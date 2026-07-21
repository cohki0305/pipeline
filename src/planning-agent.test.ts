import { describe, expect, test } from "bun:test";
import type { PipelineConfig } from "./config";
import { planningModelOption, resolvePlanningAgent } from "./planning-agent";

const BASE = {
  commands: { lint: "l", typecheck: "t", test: "x" },
  designDocDir: "d",
  reportDir: "r",
  baseBranch: "main",
  worktreeRoot: "/wt",
} satisfies PipelineConfig;

describe("resolvePlanningAgent", () => {
  test("未指定なら claude", () => {
    expect(resolvePlanningAgent(BASE)).toBe("claude");
  });

  test("planningAgent で codexSol を選べる", () => {
    expect(resolvePlanningAgent({ ...BASE, planningAgent: "codexSol" })).toBe("codexSol");
  });
});

describe("planningModelOption", () => {
  test("claude のときだけ reviewModel を渡す", () => {
    const cfg = { ...BASE, reviewModel: "opus" };
    expect(planningModelOption(cfg, "claude")).toBe("opus");
    expect(planningModelOption(cfg, "codexSol")).toBeUndefined();
  });
});
