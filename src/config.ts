import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PLANNING_AGENTS, type PlanningAgent } from "./planning-agent";
import { EFFICIENCY_TASK_AGENTS, type EfficiencyTask, type EfficiencyTaskAgent } from "./efficiency-agent";

export type PipelineConfig = {
  commands: { lint: string; typecheck: string; test: string };
  /** 修正ループ中だけ使う変更対象向けコマンド。未指定の項目は commands のフルゲートへフォールバック */
  incrementalCommands?: Partial<{ lint: string; typecheck: string; test: string }>;
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
  /** 設計・レビュー担当エージェント。未指定は claude。Fable 切れ時は codexSol */
  planningAgent?: PlanningAgent;
  /** lint 失敗時に composer を呼ぶ前に実行する自動修正コマンド */
  autoFixCommands?: { lint?: string };
  /** 設計改訂・消し込みレビュー・ゲート修正など安価タスクの担当。未指定は composer（Composer 2.5 Standard） */
  efficiencyAgents?: Partial<Record<EfficiencyTask, EfficiencyTaskAgent>>;
  /**
   * UI 変更時のスクリーンショット撮影の上書き。全項目任意で、未指定は既定値
   * （serve: "bun run dev"、R2 は共通バケット）と composer の自力発見
   * （URL はサーバーログから、ログイン方式・テストメールはリポジトリ調査）で補う
   */
  uiScreenshot?: {
    /** worktree で dev サーバーを起動するコマンド（pipeline がバックグラウンド起動・停止を管理） */
    serve?: string;
    baseUrl?: string;
    /** マジックリンクログインのヒント。dev サーバーがリンクをログに出力する構成が前提 */
    login?: { path?: string; email?: string };
    r2Bucket?: string;
    /** バケットの公開 URL（r2.dev またはカスタムドメイン）。末尾スラッシュなし */
    r2PublicBaseUrl?: string;
  };
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
  if (cfg.planningAgent !== undefined && !PLANNING_AGENTS.includes(cfg.planningAgent)) {
    throw new Error(
      `planningAgent は ${PLANNING_AGENTS.join(" / ")} のいずれかです（指定値: ${JSON.stringify(cfg.planningAgent)}）`,
    );
  }
  if (cfg.efficiencyAgents) {
    for (const [task, agent] of Object.entries(cfg.efficiencyAgents)) {
      if (!EFFICIENCY_TASK_AGENTS.includes(agent as EfficiencyTaskAgent)) {
        throw new Error(
          `efficiencyAgents.${task} は ${EFFICIENCY_TASK_AGENTS.join(" / ")} のいずれかです（指定値: ${JSON.stringify(agent)}）`,
        );
      }
    }
  }
  return cfg;
}
