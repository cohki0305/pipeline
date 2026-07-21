import type { AgentName } from "./agents";
import type { PipelineConfig } from "./config";

export type EfficiencyTask = "designRevision" | "followupReview" | "gateFix" | "lintableFix";

export const EFFICIENCY_TASK_AGENTS = ["composerFast", "composer", "codexSol"] as const;
export type EfficiencyTaskAgent = (typeof EFFICIENCY_TASK_AGENTS)[number];

const DEFAULTS: Record<EfficiencyTask, EfficiencyTaskAgent> = {
  designRevision: "composerFast",
  followupReview: "composerFast",
  gateFix: "composerFast",
  lintableFix: "composerFast",
};

export function resolveEfficiencyAgent(config: PipelineConfig, task: EfficiencyTask): AgentName {
  return config.efficiencyAgents?.[task] ?? DEFAULTS[task];
}

export function isEfficiencyTaskAgent(agent: string): agent is EfficiencyTaskAgent {
  return (EFFICIENCY_TASK_AGENTS as readonly string[]).includes(agent);
}
