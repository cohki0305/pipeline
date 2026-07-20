import type { AgentRunner } from "./agents";
import type { PipelineConfig } from "./config";
import type { Exec } from "./exec";
import type { Github, PrComment, PrSummary } from "./github";
import { safeRef } from "./git-ref";
import { commitAll, passQualityGate } from "./run";

// コメントは第三者も書けるため、コード修正の指示として扱うのはリポジトリ関係者のものに限る
const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

export function isTrustedComment(c: PrComment): boolean {
  return TRUSTED_ASSOCIATIONS.has(c.authorAssociation);
}

export type BabysitDeps = {
  config: PipelineConfig;
  exec: Exec;
  agent: AgentRunner;
  github: Github;
  projectRoot: string;
  log(msg: string): void;
};

export type PrAction = { number: number; actions: string[] };

export function buildConflictPrompt(base: string): string {
  return `この worktree では origin/${base} のマージ中にコンフリクトが発生している（git status で確認できる）。すべてのコンフリクトを解消せよ。両ブランチの変更意図を保ち、機械的にどちらか一方を捨てない。コンフリクトマーカーを残さない。git commit はしない。`;
}

export function buildCommentsPrompt(commentsJson: string): string {
  return `以下は GitHub PR に付いたレビューコメントのリスト。コード修正を求めているものに対応せよ。質問・議論のみで修正が不要なコメントは無視してよい。リストにない問題は触らない。git commit はしない。

\`\`\`json
${commentsJson}
\`\`\``;
}

// gh は UTC、git はローカルオフセットを返すため文字列比較ではなく時刻で比較する
export function isNewComment(c: PrComment, lastCommitIso: string): boolean {
  const created = Date.parse(c.createdAt);
  const last = Date.parse(lastCommitIso);
  if (Number.isNaN(created) || Number.isNaN(last)) return true;
  return created > last;
}

// 同一ブランチは二重 checkout できないため、既存 worktree（projectRoot 自身を含む）を最優先で再利用する
async function findExistingWorktree(deps: BabysitDeps, branch: string): Promise<string | null> {
  const r = await deps.exec("git worktree list --porcelain", { cwd: deps.projectRoot });
  if (r.code !== 0) return null;
  let current: string | null = null;
  for (const line of r.stdout.split("\n")) {
    if (line.startsWith("worktree ")) current = line.slice("worktree ".length).trim();
    else if (line.startsWith("branch refs/heads/") && line.slice("branch refs/heads/".length).trim() === branch) {
      return current;
    }
  }
  return null;
}

async function ensurePrWorktree(deps: BabysitDeps, branch: string): Promise<string> {
  const existing = await findExistingWorktree(deps, branch);
  if (existing) return existing;
  const path = `${deps.config.worktreeRoot}/${branch}`;
  const exists = await deps.exec(`test -d "${path}"`, { cwd: deps.projectRoot });
  if (exists.code === 0) return path;
  await deps.exec("git worktree prune", { cwd: deps.projectRoot });
  await deps.exec(`git fetch origin ${branch}`, { cwd: deps.projectRoot });
  const r = await deps.exec(`git worktree add "${path}" ${branch}`, { cwd: deps.projectRoot });
  if (r.code !== 0) {
    const retry = await deps.exec(`git worktree add "${path}" -b ${branch} origin/${branch}`, { cwd: deps.projectRoot });
    if (retry.code !== 0) throw new Error(`worktree 作成に失敗: ${r.stderr}\n${retry.stderr}`);
  }
  return path;
}

async function push(deps: BabysitDeps, cwd: string, branch: string): Promise<void> {
  const p = await deps.exec(`git push origin ${branch}`, { cwd });
  if (p.code !== 0) throw new Error(`push に失敗: ${p.stderr}`);
}

export type BabysitOpts = { comments?: boolean };

export async function babysitPr(deps: BabysitDeps, pr: PrSummary, opts: BabysitOpts = {}): Promise<PrAction> {
  const cwd = await ensurePrWorktree(deps, safeRef(pr.headRefName));
  return babysitWorkdir(deps, pr, cwd, opts);
}

// PR ブランチが checkout 済みのディレクトリで直接処理する（CI 実行用。worktree 管理をしない）
export async function babysitWorkdir(deps: BabysitDeps, pr: PrSummary, cwd: string, opts: BabysitOpts = {}): Promise<PrAction> {
  // ブランチ名は PR 作成者由来の外部入力。シェル補間前に必ず検証する
  const head = safeRef(pr.headRefName);
  const base = safeRef(pr.baseRefName);
  const actions: string[] = [];
  await deps.exec(`git fetch origin ${base}`, { cwd });
  // コメントの新旧判定は作業前の最終コミット時刻を基準にする
  const lastCommit = (await deps.exec("git log -1 --format=%cI", { cwd })).stdout.trim();

  if (pr.mergeable === "CONFLICTING") {
    const m = await deps.exec(`git merge --no-edit origin/${base}`, { cwd });
    if (m.code !== 0) {
      deps.log(`#${pr.number}: コンフリクト → composer が解消`);
      await deps.agent("composer", buildConflictPrompt(base), { cwd });
      await passQualityGate(deps, cwd, "composer");
      await commitAll(deps, cwd, `origin/${base} をマージしてコンフリクト解消`);
    }
    await push(deps, cwd, head);
    actions.push("conflict-resolved");
  }

  if (opts.comments === false) return { number: pr.number, actions };

  const fresh = (await deps.github.getPrComments(deps.projectRoot, pr.number)).filter((c) =>
    isNewComment(c, lastCommit),
  );
  const comments = fresh.filter(isTrustedComment);
  if (fresh.length !== comments.length) {
    deps.log(`#${pr.number}: 信頼できない投稿者のコメント ${fresh.length - comments.length} 件を無視`);
  }
  if (comments.length > 0) {
    deps.log(`#${pr.number}: 新規コメント ${comments.length} 件 → composer が対応`);
    await deps.agent("composer", buildCommentsPrompt(JSON.stringify(comments, null, 2)), { cwd });
    await passQualityGate(deps, cwd, "composer");
    await commitAll(deps, cwd, "PR レビューコメントに対応");
    await push(deps, cwd, head);
    actions.push(`comments-addressed(${comments.length})`);
  }

  return { number: pr.number, actions };
}

// 監視対象ブランチはリポジトリ単位の設定（babysitBranches、glob）で決める。既定はパイプライン製 PR のみ
export function matchesBranch(patterns: string[], branch: string): boolean {
  return patterns.some((p) => {
    const re = new RegExp(`^${p.split("*").map(escapeRegExp).join(".*")}$`);
    return re.test(branch);
  });
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function runBabysit(deps: BabysitDeps): Promise<PrAction[]> {
  const patterns = deps.config.babysitBranches ?? ["issue-*"];
  const results: PrAction[] = [];
  for (const pr of await deps.github.listOpenPrs(deps.projectRoot)) {
    // コンフリクト解消は全 PR、コメント対応は babysitBranches にマッチするブランチのみ
    const wantComments = matchesBranch(patterns, pr.headRefName);
    const wantConflict = pr.mergeable === "CONFLICTING";
    if (!wantComments && !wantConflict) continue;
    try {
      results.push(await babysitPr(deps, pr, { comments: wantComments }));
    } catch (e) {
      const reason = e instanceof Error ? e.message.slice(0, 200) : String(e);
      deps.log(`#${pr.number}: 処理失敗 — ${reason}`);
      results.push({ number: pr.number, actions: [`error: ${reason}`] });
    }
  }
  return results;
}
