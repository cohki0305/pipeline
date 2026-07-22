import { describe, expect, test } from "bun:test";
import type { PipelineConfig } from "./config";
import { EFFICIENCY_TASK_AGENTS, efficiencyAgentSequence, resolveEfficiencyAgent, runEfficiencyAgent } from "./efficiency-agent";

const BASE = {
  commands: { lint: "l", typecheck: "tc", test: "t" },
  designDocDir: "docs/plans",
  reportDir: "docs/runs",
  baseBranch: "main",
  worktreeRoot: "/wt",
} satisfies PipelineConfig;

describe("resolveEfficiencyAgent", () => {
  test("既定は composerFast", () => {
    expect(resolveEfficiencyAgent(BASE, "followupReview")).toBe("composerFast");
    expect(resolveEfficiencyAgent(BASE, "gateFix")).toBe("composerFast");
    expect(resolveEfficiencyAgent(BASE, "lintableFix")).toBe("composerFast");
  });

  test("テスト修正とレビュー反映は composer 開始で codexSol に昇格する", () => {
    expect(efficiencyAgentSequence(BASE, "testFix")).toEqual(["composer", "codexSol"]);
    expect(efficiencyAgentSequence(BASE, "revisionImplement")).toEqual(["composer", "codexSol"]);
    expect(resolveEfficiencyAgent(BASE, "revisionImplement", 2)).toBe("codexSol");
  });

  test("efficiencyAgents で上書きできる", () => {
    const cfg = {
      ...BASE,
      efficiencyAgents: { followupReview: "codexSol" },
    } satisfies PipelineConfig;
    expect(resolveEfficiencyAgent(cfg, "followupReview")).toBe("codexSol");
    expect(resolveEfficiencyAgent(cfg, "gateFix")).toBe("composerFast");
  });

  test("失敗回数に応じ composerFast → composer → codexSol と昇格する", () => {
    expect(efficiencyAgentSequence(BASE, "gateFix")).toEqual(["composerFast", "composer", "codexSol"]);
    expect(resolveEfficiencyAgent(BASE, "gateFix", 1)).toBe("composer");
    expect(resolveEfficiencyAgent(BASE, "gateFix", 2)).toBe("codexSol");
  });

  test("CLI 失敗時は次のモデルへ昇格する", async () => {
    const calls: string[] = [];
    const result = await runEfficiencyAgent(
      {
        config: BASE,
        agent: async (agent) => {
          calls.push(agent);
          if (agent === "composerFast") throw new Error("failed");
          return "ok";
        },
      },
      "babysitFix",
      "直せ",
      { cwd: "/work" },
    );
    expect(calls).toEqual(["composerFast", "composer"]);
    expect(result).toEqual({ output: "ok", agent: "composer" });
  });

  test("許可エージェント一覧が定義されている", () => {
    expect(EFFICIENCY_TASK_AGENTS).toContain("composerFast");
    expect(EFFICIENCY_TASK_AGENTS).toContain("codexSol");
  });
});
