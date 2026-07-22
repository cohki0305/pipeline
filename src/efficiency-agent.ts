import type { AgentName, AgentOpts, AgentRunner } from "./agents";
import type { PipelineConfig } from "./config";

export type EfficiencyTask = "followupReview" | "gateFix" | "lintableFix" | "babysitFix" | "testFix" | "revisionImplement";

export const EFFICIENCY_TASK_AGENTS = ["composerFast", "composer", "codexSol"] as const;
export type EfficiencyTaskAgent = (typeof EFFICIENCY_TASK_AGENTS)[number];

const DEFAULTS: Record<EfficiencyTask, EfficiencyTaskAgent> = {
  followupReview: "composerFast",
  gateFix: "composerFast",
  lintableFix: "composerFast",
  babysitFix: "composerFast",
  // テスト修正とレビュー反映はスコープの狭い差分修正なので complexity に依らず composer 開始。
  // 直後の消し込みレビュー/ゲート再実行で失敗が検知され、次の attempt で codexSol へ昇格する
  testFix: "composer",
  revisionImplement: "composer",
};

export function efficiencyAgentSequence(config: PipelineConfig, task: EfficiencyTask): AgentName[] {
  const preferred = config.efficiencyAgents?.[task] ?? DEFAULTS[task];
  const start = EFFICIENCY_TASK_AGENTS.indexOf(preferred);
  return [...EFFICIENCY_TASK_AGENTS.slice(start)];
}

export function resolveEfficiencyAgent(config: PipelineConfig, task: EfficiencyTask, attempt = 0): AgentName {
  const sequence = efficiencyAgentSequence(config, task);
  return sequence[Math.min(attempt, sequence.length - 1)]!;
}

export function nextEfficiencyAgent(config: PipelineConfig, task: EfficiencyTask, current: AgentName): AgentName {
  const sequence = efficiencyAgentSequence(config, task);
  const currentIndex = sequence.indexOf(current);
  return sequence[Math.min(Math.max(currentIndex, 0) + 1, sequence.length - 1)]!;
}

/** CLI 自体の失敗時だけ次のモデルへ昇格する。品質不足は各ステージの次ラウンドで昇格する。 */
export async function runEfficiencyAgent(
  deps: { config: PipelineConfig; agent: AgentRunner },
  task: EfficiencyTask,
  prompt: string,
  opts: AgentOpts,
): Promise<{ output: string; agent: AgentName }> {
  const sequence = efficiencyAgentSequence(deps.config, task);
  let lastError: unknown;
  for (const agent of sequence) {
    try {
      return { output: await deps.agent(agent, prompt, opts), agent };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

export function isEfficiencyTaskAgent(agent: string): agent is EfficiencyTaskAgent {
  return (EFFICIENCY_TASK_AGENTS as readonly string[]).includes(agent);
}
