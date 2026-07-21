import type { AgentName, AgentRunner } from "./agents";
import type { PipelineConfig } from "./config";
import type { Exec } from "./exec";
import type { Github } from "./github";
import { safeRef } from "./git-ref";
import {
  PIPELINE_STATE_FILE,
  clearPipelineState,
  findIssueDesignDoc,
  loadPipelineState,
  resolveResumePlan,
  savePipelineState,
  type PipelineMode,
  type PipelineState,
} from "./pipeline-state";
import { RunReport } from "./report";
import { loadDesign, loadExistingDesign, reviseDesignFromReview, runDesign } from "./stages/design";
import { buildFixPrompt, implementerFor, runImplement, runImplementRevision } from "./stages/implement";
import { runQualityGate } from "./stages/quality-gate";
import { type Finding, assignIds, isBlocking, runFollowupReview, runReview } from "./stages/review";

const MAX_GATE_FIXES = 3;
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
  readdir(dir: string): Promise<string[]>;
  unlink(path: string): Promise<void>;
  date: string;
};

export type PipelineOptions = {
  designDocPath?: string;
  mode?: PipelineMode;
};

async function setupWorktree(deps: Deps, issueNumber: number): Promise<string> {
  const branch = `issue-${issueNumber}`;
  const path = `${deps.config.worktreeRoot}/${branch}`;
  const exists = await deps.exec(`test -d "${path}"`, { cwd: deps.projectRoot });
  if (exists.code === 0) return path;
  await deps.exec("git worktree prune", { cwd: deps.projectRoot });
  const base = safeRef(deps.config.baseBranch);
  await deps.exec(`git fetch origin ${base}`, { cwd: deps.projectRoot });
  const r = await deps.exec(`git worktree add "${path}" -b ${branch} origin/${base}`, {
    cwd: deps.projectRoot,
  });
  if (r.code !== 0) {
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

function pipelineStatePath(cwd: string): string {
  return `${cwd}/${PIPELINE_STATE_FILE}`;
}

async function persistState(deps: Deps, cwd: string, state: PipelineState): Promise<void> {
  await savePipelineState(deps, pipelineStatePath(cwd), state);
}

type DesignDeps = Pick<Deps, "agent" | "config" | "cwd" | "readFile" | "writeFile" | "readdir" | "log" | "date"> & {
  cwd: string;
};

async function acquireDesign(
  deps: DesignDeps,
  issue: Awaited<ReturnType<Github["fetchIssue"]>>,
  plan: ReturnType<typeof resolveResumePlan>,
  options: PipelineOptions,
): Promise<Awaited<ReturnType<typeof runDesign>>> {
  if (options.designDocPath) {
    return loadDesign(deps, issue, deps.date, options.designDocPath);
  }
  if (plan.skipDesign && plan.designDocPath) {
    deps.log(`設計をスキップ（既存: ${plan.designDocPath}）`);
    return loadExistingDesign(deps, plan.designDocPath);
  }
  return runDesign(deps, issue, deps.date);
}

async function reviseAndImplement(
  deps: Deps,
  cwd: string,
  design: Awaited<ReturnType<typeof runDesign>>,
  findings: Finding[],
  implementer: AgentName,
): Promise<Awaited<ReturnType<typeof runDesign>>> {
  const revised = await reviseDesignFromReview({ ...deps, cwd }, design, findings);
  deps.log(`レビュー指摘 ${findings.length} 件 → 設計書を更新 → ${implementer} が実装`);
  await runImplementRevision({ agent: deps.agent, cwd }, revised);
  return revised;
}

export async function runPipeline(
  deps: Deps,
  issueNumber: number,
  options: PipelineOptions = {},
): Promise<{ prUrl: string; reportPath: string }> {
  const mode = options.mode ?? "resume";
  const report = new RunReport(issueNumber, deps.date);
  const issue = await deps.github.fetchIssue(deps.projectRoot, issueNumber);
  const cwd = await setupWorktree(deps, issueNumber);
  const reportPath = `${deps.config.reportDir}/issue-${issueNumber}.md`;
  const stateFile = pipelineStatePath(cwd);
  deps.log(`worktree: ${cwd}`);

  if (mode === "fresh") await clearPipelineState(deps, stateFile);

  let state = await loadPipelineState(deps, stateFile, issueNumber);
  const inferredDesign = await findIssueDesignDoc(deps.readdir, deps.config.designDocDir, issueNumber);
  let plan = resolveResumePlan(mode, state, inferredDesign);

  let design: Awaited<ReturnType<typeof runDesign>>;
  try {
    design = await acquireDesign({ ...deps, cwd }, issue, plan, options);
    state = {
      ...state,
      design: { docPath: design.docPath, complexity: design.complexity },
    };
    await persistState(deps, cwd, state);

    const implementer = implementerFor(design.complexity);
    if (!plan.skipDesign || options.designDocPath) {
      report.addStage("設計", `complexity: ${design.complexity} / ${design.docPath}`);
    }
    deps.log(`設計 (${design.complexity} → ${implementer})`);

    if (!plan.skipImplement && !plan.resumeReview) {
      await runImplement({ agent: deps.agent, cwd }, design);
      report.addStage("実装", `担当: ${implementer}`);
      state = { ...state, implement: true };
      await persistState(deps, cwd, state);
    } else if (plan.skipImplement) {
      deps.log("実装をスキップ（前回の変更を再利用）");
    }

    if (!plan.skipQualityGateInitial) {
      const gateFixes = await passQualityGate(deps, cwd, implementer);
      report.addStage("品質ゲート", `${gateFixes} 回の修正で通過`);
      await commitAll(deps, cwd, `issue #${issueNumber}: ${issue.title}`);
      state = { ...state, initialCommit: true, qualityGateInitial: { fixAttempts: gateFixes }, review: undefined };
      await persistState(deps, cwd, state);
      plan = { ...plan, skipQualityGateInitial: true, resumeReview: false };
    }

    let outstanding: Finding[] = [];
    let prevBlocking = Number.POSITIVE_INFINITY;
    let resumeFollowup = false;

    if (plan.resumeReview && plan.outstanding?.length) {
      design = await reviseAndImplement(deps, cwd, design, plan.outstanding, implementer);
      await passQualityGate(deps, cwd, implementer);
      await commitAll(deps, cwd, `issue #${issueNumber}: レビュー反映を実装`);
      outstanding = plan.outstanding;
      prevBlocking = outstanding.length;
      state = { ...state, review: undefined };
      await persistState(deps, cwd, state);
      resumeFollowup = true;
      deps.log("レビュー再開（未反映の指摘を設計→実装で処理済み）");
    }

    for (let round = 0; ; round++) {
      let current: Finding[];
      if (resumeFollowup) {
        resumeFollowup = false;
        const followup = await runFollowupReview({ ...deps, cwd }, outstanding);
        deps.log(`消し込みレビュー: ${followup.fixed.length} 件解消 (${followup.fixed.join(", ")})`);
        current = assignIds(followup.remaining, round + 1);
      } else if (round === 0) {
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
        state = { ...state, review: undefined };
        await persistState(deps, cwd, state);
        break;
      }
      if (blocking.length >= prevBlocking) {
        state = { ...state, review: { round: round + 1, outstanding: blocking } };
        await persistState(deps, cwd, state);
        throw new LoopExceededError(
          "レビュー",
          `指摘件数が減っていません（前回 ${prevBlocking} 件 → 今回 ${blocking.length} 件）:\n${JSON.stringify(blocking, null, 2)}`,
        );
      }
      if (round >= MAX_REVIEW_ROUNDS) {
        state = { ...state, review: { round: round + 1, outstanding: blocking } };
        await persistState(deps, cwd, state);
        throw new LoopExceededError("レビュー", `ラウンド上限 ${MAX_REVIEW_ROUNDS} に達しました:\n${JSON.stringify(blocking, null, 2)}`);
      }

      prevBlocking = blocking.length;
      outstanding = blocking;
      state = { ...state, review: { round: round + 1, outstanding: blocking } };
      await persistState(deps, cwd, state);

      design = await reviseAndImplement(deps, cwd, design, blocking, implementer);
      state = { ...state, design: { docPath: design.docPath, complexity: design.complexity } };
      await persistState(deps, cwd, state);

      await passQualityGate(deps, cwd, implementer);
      await commitAll(deps, cwd, `issue #${issueNumber}: レビュー反映を実装`);
    }
  } catch (e) {
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
