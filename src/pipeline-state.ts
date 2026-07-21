import type { Complexity } from "./stages/design";
import type { Finding } from "./stages/review";

export const PIPELINE_STATE_FILE = ".pipeline-state.json";

export type PipelineMode = "resume" | "fresh";

export type PipelineState = {
  issue: number;
  design?: { docPath: string; complexity: Complexity };
  implement?: true;
  qualityGateInitial?: { fixAttempts: number };
  initialCommit?: true;
  prTitle?: string;
  review?: { round: number; outstanding: Finding[] };
};

export type ResumePlan = {
  skipDesign: boolean;
  designDocPath?: string;
  complexity?: Complexity;
  skipImplement: boolean;
  skipQualityGateInitial: boolean;
  prTitle?: string;
  resumeReview: boolean;
  reviewRound?: number;
  outstanding?: Finding[];
};

export type StateIo = {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  readdir(dir: string): Promise<string[]>;
  unlink?(path: string): Promise<void>;
};

export async function findIssueDesignDoc(
  readdir: (dir: string) => Promise<string[]>,
  designDocDir: string,
  issueNumber: number,
): Promise<string | null> {
  let files: string[];
  try {
    files = await readdir(designDocDir);
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
    };
  }

  const designDocPath = state.design?.docPath ?? inferredDesignDocPath ?? undefined;
  const skipDesign = Boolean(designDocPath);
  const skipImplement = Boolean(state.implement);
  const skipQualityGateInitial = Boolean(state.initialCommit);
  const outstanding = state.review?.outstanding ?? [];
  const resumeReview = outstanding.length > 0;

  return {
    skipDesign,
    designDocPath,
    complexity: state.design?.complexity,
    skipImplement,
    skipQualityGateInitial,
    prTitle: state.prTitle,
    resumeReview,
    reviewRound: state.review?.round,
    outstanding: resumeReview ? outstanding : undefined,
  };
}
