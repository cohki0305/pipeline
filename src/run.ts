import type { AgentRunner } from "./agents";
import type { PipelineConfig } from "./config";
import type { Exec } from "./exec";
import type { Github } from "./github";
import { resolveEfficiencyAgent, runEfficiencyAgent } from "./efficiency-agent";
import { safeRef } from "./git-ref";
import {
  LEGACY_PIPELINE_STATE_FILE,
  clearPipelineState,
  findIssueDesignDoc,
  isInitialState,
  loadPipelineState,
  pipelineStatePath,
  resolveResumePlan,
  savePipelineState,
  type PipelineMode,
  type PipelineState,
} from "./pipeline-state";
import { RunReport } from "./report";
import { runCommitMessage } from "./stages/commit-message";
import { loadDesign, loadExistingDesign, reviseDesignFromReview, runDesign } from "./stages/design";
import { buildFixPrompt, buildLintableReviewFixPrompt, implementerFor, runImplement, runImplementRevision } from "./stages/implement";
import { runPrBody } from "./stages/pr-body";
import { runAutoFixLint, runQualityGate } from "./stages/quality-gate";
import { type Finding, assignIds, isBlocking, partitionBlocking, runFollowupReview, runReview } from "./stages/review";

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

function hasIncrementalCommands(config: PipelineConfig): boolean {
  return Boolean(config.incrementalCommands && Object.values(config.incrementalCommands).some(Boolean));
}

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

export async function passQualityGate(
  deps: GateDeps,
  cwd: string,
  options: { scope?: "full" | "incremental"; changedFiles?: string[] } = {},
): Promise<number> {
  for (let attempt = 0; ; attempt++) {
    const gate = await runQualityGate({ ...deps, cwd, ...options });
    if (gate.ok) return attempt;
    if (attempt >= MAX_GATE_FIXES) throw new LoopExceededError("品質ゲート", gate.raw.slice(-3000));

    if (gate.kind === "lint" && deps.config.autoFixCommands?.lint) {
      deps.log("lint 自動修正を試行");
      const fixed = await runAutoFixLint({ ...deps, cwd });
      if (fixed) {
        const retry = await runQualityGate({ ...deps, cwd, ...options });
        if (retry.ok) return attempt;
      }
    }

    const fixer = resolveEfficiencyAgent(deps.config, gate.kind === "test" ? "testFix" : "gateFix", attempt);
    deps.log(`品質ゲート違反 (${gate.kind}) → ${fixer} が修正 (${attempt + 1}/${MAX_GATE_FIXES})`);
    await deps.agent(fixer, buildFixPrompt(gate.kind ?? "lint", JSON.stringify(gate.violations, null, 2)), { cwd });
  }
}

async function persistState(deps: Deps, statePath: string, state: PipelineState): Promise<void> {
  await savePipelineState(deps, statePath, state);
}

async function currentHeadSha(deps: Pick<Deps, "exec">, cwd: string): Promise<string> {
  const result = await deps.exec("git rev-parse HEAD", { cwd });
  const sha = result.stdout.trim();
  if (result.code !== 0 || !/^[0-9a-f]{7,40}$/.test(sha)) throw new Error(`HEAD SHA の取得に失敗: ${result.stderr}`);
  return sha;
}

async function changedFilesSince(deps: Pick<Deps, "exec">, cwd: string, sha: string): Promise<string[]> {
  const result = await deps.exec(`git diff --name-only ${sha}`, { cwd });
  if (result.code !== 0) throw new Error(`変更ファイルの取得に失敗: ${result.stderr}`);
  return result.stdout.split("\n").map((file) => file.trim()).filter(Boolean);
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

async function applyReviewFindings(
  deps: Deps,
  cwd: string,
  design: Awaited<ReturnType<typeof runDesign>>,
  blocking: Finding[],
  revisionAttempt: number,
): Promise<Awaited<ReturnType<typeof runDesign>>> {
  const { lintable, structural } = partitionBlocking(blocking);
  if (lintable.length > 0) {
    const prompt = buildLintableReviewFixPrompt(JSON.stringify(lintable, null, 2));
    const { agent: fixer } = await runEfficiencyAgent(deps, "lintableFix", prompt, { cwd });
    deps.log(`lintable 指摘 ${lintable.length} 件 → ${fixer} が直接修正（設計ループ bypass）`);
  }
  if (structural.length > 0) {
    design = await reviseAndImplement(deps, cwd, design, structural, revisionAttempt);
  }
  return design;
}

async function reviseAndImplement(
  deps: Deps,
  cwd: string,
  design: Awaited<ReturnType<typeof runDesign>>,
  findings: Finding[],
  revisionAttempt: number,
): Promise<Awaited<ReturnType<typeof runDesign>>> {
  const revised = await reviseDesignFromReview({ cwd, writeFile: deps.writeFile }, design, findings);
  // 2 周目以降の指摘は前回の反映を生き延びたものなので、ラダーの次段（codexSol）へ昇格する
  const implementer = resolveEfficiencyAgent(deps.config, "revisionImplement", revisionAttempt);
  deps.log(`レビュー指摘 ${findings.length} 件 → 設計書へ機械的に追記 → ${implementer} が実装`);
  await runImplementRevision({ agent: deps.agent, cwd }, { implementer, docContent: revised.docContent });
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
  const stateFile = pipelineStatePath(deps.config.worktreeRoot, issueNumber);
  const legacyStateFile = `${cwd}/${LEGACY_PIPELINE_STATE_FILE}`;
  deps.log(`worktree: ${cwd}`);

  if (mode === "fresh") await clearPipelineState(deps, stateFile);

  let state = await loadPipelineState(deps, stateFile, issueNumber);
  if (mode !== "fresh" && isInitialState(state)) {
    state = await loadPipelineState(deps, legacyStateFile, issueNumber);
  }
  // 旧配置の state は worktree 内にあり git add -A で PR に混入するので、引き継いだら必ず消す
  await clearPipelineState(deps, legacyStateFile);

  const inferredDesign = await findIssueDesignDoc(deps.readdir, cwd, deps.config.designDocDir, issueNumber);
  let plan = resolveResumePlan(mode, state, inferredDesign);
  let prTitle = plan.prTitle ?? `issue #${issueNumber}: ${issue.title}`;

  let design: Awaited<ReturnType<typeof runDesign>>;
  let usedIncrementalGate = false;
  try {
    design = await acquireDesign({ ...deps, cwd }, issue, plan, options);
    state = {
      ...state,
      design: { docPath: design.docPath, complexity: design.complexity },
    };
    await persistState(deps, stateFile, state);

    const implementer = implementerFor(design.complexity);
    if (!plan.skipDesign || options.designDocPath) {
      report.addStage("設計", `complexity: ${design.complexity} / ${design.docPath}`);
    }
    deps.log(`設計 (${design.complexity} → ${implementer})`);

    if (!plan.skipImplement && !plan.resumeReview) {
      await runImplement({ agent: deps.agent, cwd }, design);
      report.addStage("実装", `担当: ${implementer}`);
      state = { ...state, implement: true };
      await persistState(deps, stateFile, state);
    } else if (plan.skipImplement) {
      deps.log("実装をスキップ（前回の変更を再利用）");
    }

    if (!plan.skipQualityGateInitial) {
      const gateFixes = await passQualityGate(deps, cwd);
      report.addStage("品質ゲート", `${gateFixes} 回の修正で通過`);
      const initialCommitMessage = await runCommitMessage(
        { agent: deps.agent, config: deps.config, exec: deps.exec, cwd },
        {
          reference: { kind: "issue", number: issueNumber },
          purpose: "initial",
          context: `${issue.title}\n\n${issue.body}`,
        },
      );
      prTitle = initialCommitMessage.split("\n", 1)[0]!;
      await commitAll(deps, cwd, initialCommitMessage);
      state = {
        ...state,
        initialCommit: true,
        qualityGateInitial: { fixAttempts: gateFixes },
        prTitle,
        review: undefined,
      };
      await persistState(deps, stateFile, state);
      plan = { ...plan, skipQualityGateInitial: true, resumeReview: false };
    }

    let outstanding: Finding[] = [];
    let prevBlocking = Number.POSITIVE_INFINITY;
    let resumeFollowup = false;
    let followupDiffBaseSha: string | undefined;

    if (plan.resumeReview && plan.outstanding?.length) {
      followupDiffBaseSha = plan.diffBaseSha ?? (await currentHeadSha(deps, cwd));
      design = await applyReviewFindings(deps, cwd, design, plan.outstanding, (plan.reviewRound ?? 1) - 1);
      const changedFiles = await changedFilesSince(deps, cwd, followupDiffBaseSha);
      const scope = hasIncrementalCommands(deps.config) ? "incremental" : "full";
      usedIncrementalGate ||= scope === "incremental";
      await passQualityGate(deps, cwd, { scope, changedFiles });
      const reviewCommitMessage = await runCommitMessage(
        { agent: deps.agent, config: deps.config, exec: deps.exec, cwd },
        {
          reference: { kind: "issue", number: issueNumber },
          purpose: "review",
          context: JSON.stringify(plan.outstanding, null, 2),
        },
      );
      await commitAll(deps, cwd, reviewCommitMessage);
      outstanding = plan.outstanding;
      prevBlocking = outstanding.length;
      state = {
        ...state,
        review: { round: plan.reviewRound ?? 1, outstanding, phase: "applied", diffBaseSha: followupDiffBaseSha },
      };
      await persistState(deps, stateFile, state);
      resumeFollowup = true;
      deps.log("レビュー再開（未反映の指摘を設計→実装で処理済み）");
    } else if (plan.resumeFollowup && plan.outstanding?.length) {
      outstanding = plan.outstanding;
      prevBlocking = outstanding.length;
      resumeFollowup = true;
      followupDiffBaseSha = plan.diffBaseSha;
      deps.log("レビュー再開（指摘は反映済み・消し込みレビューから）");
    }

    for (let round = 0; ; round++) {
      let current: Finding[];
      if (resumeFollowup) {
        resumeFollowup = false;
        const followup = await runFollowupReview({ ...deps, cwd }, outstanding, followupDiffBaseSha);
        deps.log(`消し込みレビュー: ${followup.fixed.length} 件解消 (${followup.fixed.join(", ")})`);
        current = assignIds(followup.remaining, round + 1);
      } else if (round === 0) {
        current = assignIds(await runReview({ ...deps, cwd }), round + 1);
      } else {
        const followup = await runFollowupReview({ ...deps, cwd }, outstanding, followupDiffBaseSha);
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
        await persistState(deps, stateFile, state);
        break;
      }
      if (blocking.length >= prevBlocking) {
        state = { ...state, review: { round: round + 1, outstanding: blocking } };
        await persistState(deps, stateFile, state);
        throw new LoopExceededError(
          "レビュー",
          `指摘件数が減っていません（前回 ${prevBlocking} 件 → 今回 ${blocking.length} 件）:\n${JSON.stringify(blocking, null, 2)}`,
        );
      }
      if (round >= MAX_REVIEW_ROUNDS) {
        state = { ...state, review: { round: round + 1, outstanding: blocking } };
        await persistState(deps, stateFile, state);
        throw new LoopExceededError("レビュー", `ラウンド上限 ${MAX_REVIEW_ROUNDS} に達しました:\n${JSON.stringify(blocking, null, 2)}`);
      }

      prevBlocking = blocking.length;
      outstanding = blocking;
      followupDiffBaseSha = await currentHeadSha(deps, cwd);
      state = {
        ...state,
        review: { round: round + 1, outstanding: blocking, phase: "pending", diffBaseSha: followupDiffBaseSha },
      };
      await persistState(deps, stateFile, state);

      design = await applyReviewFindings(deps, cwd, design, blocking, round);
      state = { ...state, design: { docPath: design.docPath, complexity: design.complexity } };
      await persistState(deps, stateFile, state);

      const changedFiles = await changedFilesSince(deps, cwd, followupDiffBaseSha);
      const scope = hasIncrementalCommands(deps.config) ? "incremental" : "full";
      usedIncrementalGate ||= scope === "incremental";
      await passQualityGate(deps, cwd, { scope, changedFiles });
      const reviewCommitMessage = await runCommitMessage(
        { agent: deps.agent, config: deps.config, exec: deps.exec, cwd },
        {
          reference: { kind: "issue", number: issueNumber },
          purpose: "review",
          context: JSON.stringify(blocking, null, 2),
        },
      );
      await commitAll(deps, cwd, reviewCommitMessage);
      // 反映がコミットまで済んだ時点で applied に進める。ここで落ちた resume は同じ修正を繰り返さず消し込みから再開する
      state = {
        ...state,
        review: { round: round + 1, outstanding: blocking, phase: "applied", diffBaseSha: followupDiffBaseSha },
      };
      await persistState(deps, stateFile, state);
    }

    // 修正ループ中は増分ゲートを使えるが、公開前には必ずフルゲートで安全性を確認する。
    if (usedIncrementalGate) await passQualityGate(deps, cwd);
  } catch (e) {
    report.addStage("中断", e instanceof Error ? e.message.slice(0, 500) : String(e));
    await deps.writeFile(`${cwd}/${reportPath}`, report.render());
    if (e instanceof LoopExceededError) {
      throw new LoopExceededError(e.stage, `${e.detail}\nworktree: ${cwd}\nレポート: ${reportPath}`);
    }
    throw e;
  }

  await deps.writeFile(`${cwd}/${reportPath}`, report.render());
  await commitAll(
    deps,
    cwd,
    `docs: issue #${issueNumber} の検証結果と残課題を記録\n\n品質ゲートと内部レビューの結果、未対応の low 指摘と lint 化候補を追跡できるようにする。\n\n関連: #${issueNumber}`,
  );

  const prBody = await runPrBody(
    { agent: deps.agent, config: deps.config, exec: deps.exec, readFile: deps.readFile, cwd },
    { issue, designDocPath: design.docPath, reportPath },
  );

  const push = await deps.exec(`git push -u origin issue-${issueNumber}`, { cwd });
  if (push.code !== 0) throw new Error(`push に失敗: ${push.stderr}`);
  const prUrl = await deps.github.createPr(cwd, {
    title: prTitle,
    body: prBody,
    base: deps.config.baseBranch,
  });
  return { prUrl, reportPath };
}
