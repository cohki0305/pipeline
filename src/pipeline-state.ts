import type { Complexity } from "./stages/design";
import type { Finding } from "./stages/review";

/** 旧バージョンが worktree 直下に書いていた state。git add -A で生成 PR に混入するため読み込みと削除にだけ使う */
export const LEGACY_PIPELINE_STATE_FILE = ".pipeline-state.json";

/** state は worktree の外（worktree 置き場の直下）に置く。worktree 内だと生成コミットに混入する */
export function pipelineStatePath(worktreeRoot: string, issueNumber: number): string {
  return `${worktreeRoot}/.pipeline-state-issue-${issueNumber}.json`;
}

export type PipelineMode = "resume" | "fresh";

/**
 * pending = 指摘を検出して未反映、applied = 反映・ゲート・コミットまで完了し消し込みレビュー待ち。
 * applied を残さないと、コミット後に落ちた際の resume が同じ修正を再適用してしまう。
 */
export type ReviewPhase = "pending" | "applied";

export type PipelineState = {
  issue: number;
  design?: { docPath: string; complexity: Complexity };
  implement?: true;
  qualityGateInitial?: { fixAttempts: number };
  initialCommit?: true;
  prTitle?: string;
  review?: { round: number; outstanding: Finding[]; phase?: ReviewPhase };
};

export type ResumePlan = {
  skipDesign: boolean;
  designDocPath?: string;
  complexity?: Complexity;
  skipImplement: boolean;
  skipQualityGateInitial: boolean;
  prTitle?: string;
  resumeReview: boolean;
  /** 指摘は反映済み。修正をやり直さず消し込みレビューから再開する */
  resumeFollowup: boolean;
  reviewRound?: number;
  outstanding?: Finding[];
};

/** issue 番号しか入っていない＝一度も進捗を保存していない状態 */
export function isInitialState(state: PipelineState): boolean {
  return Object.keys(state).length === 1;
}

export type StateIo = {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  readdir(dir: string): Promise<string[]>;
  unlink?(path: string): Promise<void>;
};

/**
 * worktree 内の設計書を探す。readdir は絶対パス（`${baseDir}/${designDocDir}`）で呼び、
 * 返すのは worktree 相対パス（loadExistingDesign が `${cwd}/` を前置するため）。
 */
export async function findIssueDesignDoc(
  readdir: (dir: string) => Promise<string[]>,
  baseDir: string,
  designDocDir: string,
  issueNumber: number,
): Promise<string | null> {
  let files: string[];
  try {
    files = await readdir(`${baseDir}/${designDocDir}`);
  } catch {
    return null;
  }
  const suffix = `-issue-${issueNumber}.md`;
  const matches = files.filter((f) => f.endsWith(suffix)).sort();
  if (matches.length === 0) return null;
  return `${designDocDir}/${matches[matches.length - 1]}`;
}

export async function loadPipelineState(
  io: Pick<StateIo, "readFile">,
  statePath: string,
  issueNumber: number,
): Promise<PipelineState> {
  try {
    const raw = await io.readFile(statePath);
    const parsed = JSON.parse(raw) as PipelineState;
    return parsed.issue === issueNumber ? parsed : { issue: issueNumber };
  } catch {
    return { issue: issueNumber };
  }
}

export async function savePipelineState(io: Pick<StateIo, "writeFile">, statePath: string, state: PipelineState): Promise<void> {
  await io.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

export async function clearPipelineState(io: StateIo, statePath: string): Promise<void> {
  if (!io.unlink) return;
  try {
    await io.unlink(statePath);
  } catch {
    // なければ何もしない
  }
}

export function resolveResumePlan(
  mode: PipelineMode,
  state: PipelineState,
  inferredDesignDocPath: string | null,
): ResumePlan {
  if (mode === "fresh") {
    return {
      skipDesign: false,
      skipImplement: false,
      skipQualityGateInitial: false,
      resumeReview: false,
      resumeFollowup: false,
    };
  }

  const designDocPath = state.design?.docPath ?? inferredDesignDocPath ?? undefined;
  const skipDesign = Boolean(designDocPath);
  const skipImplement = Boolean(state.implement);
  const skipQualityGateInitial = Boolean(state.initialCommit);
  const outstanding = state.review?.outstanding ?? [];
  const hasOutstanding = outstanding.length > 0;
  const applied = state.review?.phase === "applied";

  return {
    skipDesign,
    designDocPath,
    complexity: state.design?.complexity,
    skipImplement,
    skipQualityGateInitial,
    prTitle: state.prTitle,
    resumeReview: hasOutstanding && !applied,
    resumeFollowup: hasOutstanding && applied,
    reviewRound: state.review?.round,
    outstanding: hasOutstanding ? outstanding : undefined,
  };
}
