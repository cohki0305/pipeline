import type { PlanningAgent } from "./planning-agent";

export function resolvePlanningAgentSetting(config: Record<string, unknown>): PlanningAgent {
  return config.planningAgent === "codexSol" ? "codexSol" : "claude";
}

export function updatePlanningAgent(
  config: Record<string, unknown>,
  agent: PlanningAgent,
): Record<string, unknown> {
  if (agent === "claude") {
    const { planningAgent: _removed, ...rest } = config;
    return rest;
  }
  return { ...config, planningAgent: "codexSol" };
}

export function parsePlanningAgentArg(value: string): PlanningAgent | null {
  if (value === "claude") return "claude";
  if (value === "codex" || value === "codexSol") return "codexSol";
  return null;
}

export function formatPlanningAgent(agent: PlanningAgent): string {
  return agent === "codexSol" ? "codexSol (gpt-5.6-sol)" : "claude";
}
