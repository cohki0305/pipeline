import type { AgentName } from "./agents";
import type { PipelineConfig } from "./config";

export type PlanningAgent = Extract<AgentName, "claude" | "codexSol">;

export const PLANNING_AGENTS: readonly PlanningAgent[] = ["claude", "codexSol"];

export function resolvePlanningAgent(config: PipelineConfig): PlanningAgent {
  return config.planningAgent ?? "claude";
}

export function planningModelOption(
  config: PipelineConfig,
  agent: PlanningAgent = resolvePlanningAgent(config),
): string | undefined {
  return agent === "claude" ? config.reviewModel : undefined;
}
