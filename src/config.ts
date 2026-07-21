import { readFileSync } from "node:fs";
import { join } from "node:path";

export type PipelineConfig = {
  commands: { lint: string; typecheck: string; test: string };
  designDocDir: string;
  reportDir: string;
  baseBranch: string;
  worktreeRoot: string;
  postWorktreeSetup?: string;
  babysitBranches?: string[];
  babysitExcludeBranches?: string[];
  /** association に依らず信頼する投稿者 login（自分で設定したレビュー bot 等）。"[bot]" サフィックスは有無を問わない */
  babysitTrustedAuthors?: string[];
  /** ここに載る login が作成した PR は、ブランチ名を問わずコメント/CI 対応の対象にする */
  babysitAuthors?: string[];
  /** 設計・レビューを行う claude のモデル上書き（例 "opus"）。未指定なら claude CLI のデフォルト */
  reviewModel?: string;
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
