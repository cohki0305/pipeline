import { describe, expect, test } from "bun:test";
import type { PipelineConfig } from "./config";
import { EFFICIENCY_TASK_AGENTS, resolveEfficiencyAgent } from "./efficiency-agent";

const BASE = {
  commands: { lint: "l", typecheck: "tc", test: "t" },
  designDocDir: "docs/plans",
  reportDir: "docs/runs",
  baseBranch: "main",
  worktreeRoot: "/wt",
} satisfies PipelineConfig;

describe("resolveEfficiencyAgent", () => {
  test("既定は composerFast", () => {
    expect(resolveEfficiencyAgent(BASE, "designRevision")).toBe("composerFast");
    expect(resolveEfficiencyAgent(BASE, "followupReview")).toBe("composerFast");
    expect(resolveEfficiencyAgent(BASE, "gateFix")).toBe("composerFast");
    expect(resolveEfficiencyAgent(BASE, "lintableFix")).toBe("composerFast");
  });

  test("efficiencyAgents で上書きできる", () => {
    const cfg = {
      ...BASE,
      efficiencyAgents: { designRevision: "codexSol", followupReview: "codexSol" },
    } satisfies PipelineConfig;
    expect(resolveEfficiencyAgent(cfg, "designRevision")).toBe("codexSol");
    expect(resolveEfficiencyAgent(cfg, "gateFix")).toBe("composerFast");
  });

  test("許可エージェント一覧が定義されている", () => {
    expect(EFFICIENCY_TASK_AGENTS).toContain("composerFast");
    expect(EFFICIENCY_TASK_AGENTS).toContain("codexSol");
  });
});
