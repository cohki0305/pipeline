import type { AgentRunner } from "./agents";
import { buildCiFailurePrompt, pickWorkflowRunId } from "./ci-status";
import type { PipelineConfig } from "./config";
import type { Exec } from "./exec";
import { runEfficiencyAgent } from "./efficiency-agent";
import type { Github, PrComment, PrSummary } from "./github";
import { safeRef } from "./git-ref";
import { commitAll, passQualityGate } from "./run";
import { runCommitMessage } from "./stages/commit-message";

// コメントは第三者も書けるため、コード修正の指示として扱うのはリポジトリ関係者のものに限る
const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

// GraphQL (gh pr view) は "name"、REST は "name[bot]" と bot login の表記が揺れるため正規化して照合する
const normalizeLogin = (login: string) => login.replace(/\[bot\]$/, "");

export function isTrustedComment(c: PrComment, trustedAuthors?: string[]): boolean {
  if (TRUSTED_ASSOCIATIONS.has(c.authorAssociation)) return true;
  if (!trustedAuthors) return false;
  return trustedAuthors.some((a) => normalizeLogin(a) === normalizeLogin(c.author));
}

export type BabysitDeps = {
  config: PipelineConfig;
  exec: Exec;
  agent: AgentRunner;
  github: Github;
  projectRoot: string;
  log(msg: string): void;
  sleep?(ms: number): Promise<void>;
};

// GitHub は main への push 直後 mergeable を非同期計算するため、UNKNOWN の間は確定するまで待つ
const MERGEABLE_POLL_ATTEMPTS = 5;
const MERGEABLE_POLL_INTERVAL_MS = 3000;

async function resolveMergeable(deps: BabysitDeps, pr: PrSummary): Promise<PrSummary> {
  if (pr.mergeable !== "UNKNOWN") return pr;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  let current = pr;
  for (let i = 0; i < MERGEABLE_POLL_ATTEMPTS && current.mergeable === "UNKNOWN"; i++) {
    await sleep(MERGEABLE_POLL_INTERVAL_MS);
    current = await deps.github.getPr(deps.projectRoot, pr.number);
  }
  return current;
}

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

export function buildFeedbackPrompt(commentsJson?: string, ciFailurePrompt?: string): string {
  return [
    commentsJson ? buildCommentsPrompt(commentsJson) : "",
    ciFailurePrompt ?? "",
  ].filter(Boolean).join("\n\n---\n\n");
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

async function headSha(deps: BabysitDeps, cwd: string): Promise<string> {
  const result = await deps.exec("git rev-parse HEAD", { cwd });
  const sha = result.stdout.trim();
  if (result.code !== 0 || !/^[0-9a-f]{7,40}$/.test(sha)) throw new Error(`HEAD SHA の取得に失敗: ${result.stderr}`);
  return sha;
}

async function changedFiles(deps: BabysitDeps, cwd: string, sha: string): Promise<string[]> {
  const result = await deps.exec(`git diff --name-only ${sha}`, { cwd });
  if (result.code !== 0) throw new Error(`変更ファイルの取得に失敗: ${result.stderr}`);
  return result.stdout.split("\n").map((file) => file.trim()).filter(Boolean);
}

export type BabysitOpts = { comments?: boolean; ci?: boolean };

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
      const conflictCommitMessage = await runCommitMessage(
        { agent: deps.agent, config: deps.config, exec: deps.exec, cwd },
        {
          reference: { kind: "pr", number: pr.number },
          purpose: "conflict",
          context: `origin/${base} の取り込みで発生した競合を解消`,
        },
      );
      await commitAll(deps, cwd, conflictCommitMessage);
    }
    await push(deps, cwd, head);
    actions.push("conflict-resolved");
  }

  if (opts.comments === false) return { number: pr.number, actions };

  const fresh = (await deps.github.getPrComments(deps.projectRoot, pr.number)).filter((c) =>
    isNewComment(c, lastCommit),
  );
  const comments = fresh.filter((c) => isTrustedComment(c, deps.config.babysitTrustedAuthors));
  if (fresh.length !== comments.length) {
    deps.log(`#${pr.number}: 信頼できない投稿者のコメント ${fresh.length - comments.length} 件を無視`);
  }
  let failedChecks: Awaited<ReturnType<Github["getPrFailedChecks"]>> = [];
  let ciFailurePrompt: string | undefined;
  if (opts.ci !== false) {
    failedChecks = await deps.github.getPrFailedChecks(deps.projectRoot, pr.number);
    if (failedChecks.length > 0) {
      const runId = pickWorkflowRunId(failedChecks);
      if (runId == null) {
        deps.log(`#${pr.number}: CI 失敗を検知したが workflow run id を取得できませんでした`);
      } else {
        const logs = await deps.github.getWorkflowRunFailedLog(deps.projectRoot, runId);
        ciFailurePrompt = buildCiFailurePrompt(failedChecks, logs);
      }
    }
  }

  if (comments.length > 0 || ciFailurePrompt) {
    const beforeSha = await headSha(deps, cwd);
    const prompt = buildFeedbackPrompt(
      comments.length > 0 ? JSON.stringify(comments, null, 2) : undefined,
      ciFailurePrompt,
    );
    const { agent } = await runEfficiencyAgent(deps, "babysitFix", prompt, { cwd });
    const files = await changedFiles(deps, cwd, beforeSha);
    deps.log(
      `#${pr.number}: コメント ${comments.length} 件 / CI ${failedChecks.length} 件 → ${agent} が一括対応`,
    );
    const hasIncremental = Boolean(
      deps.config.incrementalCommands && Object.values(deps.config.incrementalCommands).some(Boolean),
    );
    if (hasIncremental) {
      await passQualityGate(deps, cwd, agent, { scope: "incremental", changedFiles: files });
    }
    await passQualityGate(deps, cwd, agent);
    const feedbackCommitMessage = await runCommitMessage(
      { agent: deps.agent, config: deps.config, exec: deps.exec, cwd },
      {
        reference: { kind: "pr", number: pr.number },
        purpose: "feedback",
        context: prompt,
      },
    );
    await commitAll(deps, cwd, feedbackCommitMessage);
    await push(deps, cwd, head);
    if (comments.length > 0) actions.push(`comments-addressed(${comments.length})`);
    if (ciFailurePrompt) actions.push(`ci-fixed(${failedChecks.map((check) => check.name).join(",")})`);
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

// 保護ブランチが head の PR には自動 push しない（コンフリクト解消でも例外なし）
const DEFAULT_EXCLUDES = ["main", "master", "develop", "release/*"];

export async function runBabysit(deps: BabysitDeps): Promise<PrAction[]> {
  const patterns = deps.config.babysitBranches ?? ["issue-*"];
  const excludes = deps.config.babysitExcludeBranches ?? DEFAULT_EXCLUDES;
  const authors = deps.config.babysitAuthors ?? [];
  const results: PrAction[] = [];
  for (const listed of await deps.github.listOpenPrs(deps.projectRoot)) {
    if (matchesBranch(excludes, listed.headRefName)) continue;
    // コメント/CI 対応の対象: babysitBranches にマッチするブランチ、または babysitAuthors にマッチする作成者
    const wantComments = matchesBranch(patterns, listed.headRefName) || authors.includes(listed.author);
    const wantCi = wantComments;
    // コンフリクト判定は mergeable が確定してから行う（push 直後は UNKNOWN のことがある）
    const pr = wantComments || listed.mergeable === "UNKNOWN" ? await resolveMergeable(deps, listed) : listed;
    // コンフリクト解消は全 PR（保護ブランチ除く）
    const wantConflict = pr.mergeable === "CONFLICTING";
    if (!wantComments && !wantConflict && !wantCi) continue;
    try {
      results.push(await babysitPr(deps, pr, { comments: wantComments, ci: wantCi }));
    } catch (e) {
      const reason = e instanceof Error ? e.message.slice(0, 200) : String(e);
      deps.log(`#${pr.number}: 処理失敗 — ${reason}`);
      results.push({ number: pr.number, actions: [`error: ${reason}`] });
    }
  }
  return results;
}
