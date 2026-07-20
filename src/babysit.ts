import type { AgentRunner } from "./agents";
import type { PipelineConfig } from "./config";
import type { Exec } from "./exec";
import type { Github, PrComment, PrSummary } from "./github";
import { commitAll, passQualityGate } from "./run";

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

async function ensurePrWorktree(deps: BabysitDeps, branch: string): Promise<string> {
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

export async function babysitPr(deps: BabysitDeps, pr: PrSummary): Promise<PrAction> {
  const cwd = await ensurePrWorktree(deps, pr.headRefName);
  return babysitWorkdir(deps, pr, cwd);
}

// PR ブランチが checkout 済みのディレクトリで直接処理する（CI 実行用。worktree 管理をしない）
export async function babysitWorkdir(deps: BabysitDeps, pr: PrSummary, cwd: string): Promise<PrAction> {
  const actions: string[] = [];
  await deps.exec(`git fetch origin ${pr.baseRefName}`, { cwd });
  // コメントの新旧判定は作業前の最終コミット時刻を基準にする
  const lastCommit = (await deps.exec("git log -1 --format=%cI", { cwd })).stdout.trim();

  if (pr.mergeable === "CONFLICTING") {
    const m = await deps.exec(`git merge --no-edit origin/${pr.baseRefName}`, { cwd });
    if (m.code !== 0) {
      deps.log(`#${pr.number}: コンフリクト → composer が解消`);
      await deps.agent("composer", buildConflictPrompt(pr.baseRefName), { cwd });
      await passQualityGate(deps, cwd, "composer");
      await commitAll(deps, cwd, `origin/${pr.baseRefName} をマージしてコンフリクト解消`);
    }
    await push(deps, cwd, pr.headRefName);
    actions.push("conflict-resolved");
  }

  const comments = (await deps.github.getPrComments(deps.projectRoot, pr.number)).filter((c) =>
    isNewComment(c, lastCommit),
  );
  if (comments.length > 0) {
    deps.log(`#${pr.number}: 新規コメント ${comments.length} 件 → composer が対応`);
    await deps.agent("composer", buildCommentsPrompt(JSON.stringify(comments, null, 2)), { cwd });
    await passQualityGate(deps, cwd, "composer");
    await commitAll(deps, cwd, "PR レビューコメントに対応");
    await push(deps, cwd, pr.headRefName);
    actions.push(`comments-addressed(${comments.length})`);
  }

  return { number: pr.number, actions };
}

export async function runBabysit(deps: BabysitDeps): Promise<PrAction[]> {
  const prs = (await deps.github.listOpenPrs(deps.projectRoot)).filter((p) => /^issue-\d+$/.test(p.headRefName));
  const results: PrAction[] = [];
  for (const pr of prs) results.push(await babysitPr(deps, pr));
  return results;
}
