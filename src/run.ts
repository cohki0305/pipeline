import type { AgentName, AgentRunner } from "./agents";
import type { PipelineConfig } from "./config";
import type { Exec } from "./exec";
import type { Github } from "./github";
import { safeRef } from "./git-ref";
import { RunReport } from "./report";
import { loadDesign, runDesign } from "./stages/design";
import { buildFixPrompt, implementerFor, runImplement } from "./stages/implement";
import { runQualityGate } from "./stages/quality-gate";
import { type Finding, assignIds, isBlocking, runFollowupReview, runReview } from "./stages/review";

const MAX_GATE_FIXES = 3;
// レビューは件数が減り続ける限り継続する。1 ラウンド = claude レビュー + 修正なので上限は低めに抑える
const MAX_REVIEW_ROUNDS = 3;

export class LoopExceededError extends Error {
  constructor(
    public stage: string,
    public detail: string,
  ) {
    super(`${stage} の修正ループが上限に達しました:\n${detail}`);
  }
}

export type Deps = {
  config: PipelineConfig;
  exec: Exec;
  agent: AgentRunner;
  github: Github;
  projectRoot: string;
  log(msg: string): void;
  writeFile(path: string, content: string): Promise<void>;
  readFile(path: string): Promise<string>;
  date: string;
};

export type PipelineOptions = { designDocPath?: string };

async function setupWorktree(deps: Deps, issueNumber: number): Promise<string> {
  const branch = `issue-${issueNumber}`;
  const path = `${deps.config.worktreeRoot}/${branch}`;
  // リトライ時は既存 worktree を再利用する
  const exists = await deps.exec(`test -d "${path}"`, { cwd: deps.projectRoot });
  if (exists.code === 0) return path;
  // ディレクトリだけ消された残骸があると add が失敗するため先に掃除する
  await deps.exec("git worktree prune", { cwd: deps.projectRoot });
  // ローカル checkout の鮮度に依存しないよう、必ず fetch 済みの origin/<base> を基準にする
  const base = safeRef(deps.config.baseBranch);
  await deps.exec(`git fetch origin ${base}`, { cwd: deps.projectRoot });
  const r = await deps.exec(`git worktree add "${path}" -b ${branch} origin/${base}`, {
    cwd: deps.projectRoot,
  });
  if (r.code !== 0) {
    // 前回実行の branch が残っている場合は -b なしで attach する
    const retry = await deps.exec(`git worktree add "${path}" ${branch}`, { cwd: deps.projectRoot });
    if (retry.code !== 0) throw new Error(`worktree 作成に失敗: ${r.stderr}\n${retry.stderr}`);
  }
  if (deps.config.postWorktreeSetup) {
    const s = await deps.exec(deps.config.postWorktreeSetup, { cwd: path });
    if (s.code !== 0) throw new Error(`worktree セットアップに失敗: ${s.stderr}`);
  }
  return path;
}

export async function commitAll(deps: { exec: Exec }, cwd: string, message: string): Promise<void> {
  // 品質ゲート通過後なので hooks は再実行しない。変更ゼロ（diff --cached --quiet が 0）は成功扱い
  const r = await deps.exec(`git add -A && { git diff --cached --quiet || git commit --no-verify -m "$COMMIT_MSG"; }`, {
    cwd,
    env: { COMMIT_MSG: message },
  });
  if (r.code !== 0) throw new Error(`コミットに失敗: ${r.stderr}`);
}

export type GateDeps = { exec: Exec; config: PipelineConfig; agent: AgentRunner; log(msg: string): void };

export async function passQualityGate(deps: GateDeps, cwd: string, implementer: AgentName): Promise<number> {
  for (let attempt = 0; ; attempt++) {
    const gate = await runQualityGate({ ...deps, cwd });
    if (gate.ok) return attempt;
    if (attempt >= MAX_GATE_FIXES) throw new LoopExceededError("品質ゲート", gate.raw.slice(-3000));
    const fixer = gate.kind === "test" ? implementer : "composer";
    deps.log(`品質ゲート違反 (${gate.kind}) → ${fixer} が修正 (${attempt + 1}/${MAX_GATE_FIXES})`);
    await deps.agent(fixer, buildFixPrompt(gate.kind ?? "lint", JSON.stringify(gate.violations, null, 2)), { cwd });
  }
}

export async function runPipeline(
  deps: Deps,
  issueNumber: number,
  options: PipelineOptions = {},
): Promise<{ prUrl: string; reportPath: string }> {
  const report = new RunReport(issueNumber, deps.date);
  const issue = await deps.github.fetchIssue(deps.projectRoot, issueNumber);
  const cwd = await setupWorktree(deps, issueNumber);
  const reportPath = `${deps.config.reportDir}/issue-${issueNumber}.md`;
  deps.log(`worktree: ${cwd}`);

  let design: Awaited<ReturnType<typeof runDesign>>;
  try {
    design = options.designDocPath
      ? await loadDesign({ ...deps, cwd }, issue, deps.date, options.designDocPath)
      : await runDesign({ ...deps, cwd }, issue, deps.date);
    const implementer = implementerFor(design.complexity);
    report.addStage("設計", `complexity: ${design.complexity} / ${design.docPath}`);
    deps.log(`設計完了 (complexity: ${design.complexity} → ${implementer})`);

    await runImplement({ ...deps, cwd }, design);
    report.addStage("実装", `担当: ${implementer}`);

    const gateFixes = await passQualityGate(deps, cwd, implementer);
    report.addStage("品質ゲート", `${gateFixes} 回の修正で通過`);
    await commitAll(deps, cwd, `issue #${issueNumber}: ${issue.title}`);

    // 初回はフルレビュー、2 巡目以降は前回指摘の消し込み + 修正が持ち込んだ新規問題のみ
    let outstanding: Finding[] = [];
    let prevBlocking = Number.POSITIVE_INFINITY;
    for (let round = 0; ; round++) {
      let current: Finding[];
      if (round === 0) {
        current = assignIds(await runReview({ ...deps, cwd }), round + 1);
      } else {
        const followup = await runFollowupReview({ ...deps, cwd }, outstanding);
        deps.log(`消し込みレビュー: ${followup.fixed.length} 件解消 (${followup.fixed.join(", ")})`);
        current = assignIds(followup.remaining, round + 1);
      }
      for (const f of current.filter((f) => f.lintable)) {
        report.addLintCandidate({ file: f.file, message: f.message });
      }
      const lows = current.filter((f) => !isBlocking(f));
      for (const f of lows) report.addLowFinding({ file: f.file, message: f.message });
      const blocking = current.filter(isBlocking);
      if (blocking.length === 0) {
        report.addStage("レビュー", `${round} 回の修正でクリーン（low ${lows.length} 件はレポート送り）`);
        break;
      }
      if (blocking.length >= prevBlocking) {
        throw new LoopExceededError(
          "レビュー",
          `指摘件数が減っていません（前回 ${prevBlocking} 件 → 今回 ${blocking.length} 件）:\n${JSON.stringify(blocking, null, 2)}`,
        );
      }
      if (round >= MAX_REVIEW_ROUNDS) {
        throw new LoopExceededError("レビュー", `ラウンド上限 ${MAX_REVIEW_ROUNDS} に達しました:\n${JSON.stringify(blocking, null, 2)}`);
      }
      prevBlocking = blocking.length;
      outstanding = blocking;
      deps.log(`レビュー指摘 ${blocking.length} 件（low ${lows.length} 件はレポート送り）→ ${implementer} が修正 (round ${round + 1})`);
      await deps.agent(implementer, buildFixPrompt("review", JSON.stringify(blocking, null, 2)), { cwd });
      // レビュー修正が規約違反やテスト破壊を持ち込むことがあるため、必ず再ゲートしてからコミットする
      await passQualityGate(deps, cwd, implementer);
      await commitAll(deps, cwd, `issue #${issueNumber}: レビュー指摘を修正`);
    }
  } catch (e) {
    // 中断しても進捗と lint 化候補を worktree 内に残す（コミットはしない）
    report.addStage("中断", e instanceof Error ? e.message.slice(0, 500) : String(e));
    await deps.writeFile(`${cwd}/${reportPath}`, report.render());
    if (e instanceof LoopExceededError) {
      throw new LoopExceededError(e.stage, `${e.detail}\nworktree: ${cwd}\nレポート: ${reportPath}`);
    }
    throw e;
  }

  await deps.writeFile(`${cwd}/${reportPath}`, report.render());
  await commitAll(deps, cwd, `issue #${issueNumber}: 実行レポート`);

  const push = await deps.exec(`git push -u origin issue-${issueNumber}`, { cwd });
  if (push.code !== 0) throw new Error(`push に失敗: ${push.stderr}`);
  const prUrl = await deps.github.createPr(cwd, {
    title: `issue #${issueNumber}: ${issue.title}`,
    body: `Closes #${issueNumber}\n\n- 設計: ${design.docPath}\n- 実行レポート: ${reportPath}`,
    base: deps.config.baseBranch,
  });
  return { prUrl, reportPath };
}
