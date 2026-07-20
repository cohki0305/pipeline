import { readFileSync } from "node:fs";
import { join } from "node:path";

export type PipelineConfig = {
  commands: { lint: string; typecheck: string; test: string };
  designDocDir: string;
  reportDir: string;
  baseBranch: string;
  worktreeRoot: string;
  postWorktreeSetup?: string;
};

const DEFAULTS = {
  designDocDir: "docs/agent-pipeline/plans",
  reportDir: "docs/agent-pipeline/runs",
  baseBranch: "main",
};

export function loadConfig(projectRoot: string): PipelineConfig {
  const path = join(projectRoot, ".agent-pipeline.json");
  let raw: object;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`.agent-pipeline.json を ${projectRoot} から読めません: ${e}`);
  }
  const cfg = {
    ...DEFAULTS,
    worktreeRoot: join(projectRoot, "..", "pipeline-worktrees"),
    ...raw,
  } as PipelineConfig;
  for (const key of ["lint", "typecheck", "test"] as const) {
    if (!cfg.commands?.[key]) throw new Error(`commands.${key} が未設定です`);
  }
  return cfg;
}
