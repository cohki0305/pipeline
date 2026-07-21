import { describe, expect, test } from "bun:test";
import {
  formatPlanningAgent,
  parsePlanningAgentArg,
  resolvePlanningAgentSetting,
  updatePlanningAgent,
} from "./planning-agent-config";

describe("updatePlanningAgent", () => {
  test("codexSol を設定する", () => {
    expect(updatePlanningAgent({ commands: {} }, "codexSol")).toEqual({
      commands: {},
      planningAgent: "codexSol",
    });
  });

  test("claude に戻すと planningAgent キーを削除する", () => {
    expect(updatePlanningAgent({ planningAgent: "codexSol", commands: {} }, "claude")).toEqual({
      commands: {},
    });
  });
});

describe("resolvePlanningAgentSetting", () => {
  test("未設定は claude", () => {
    expect(resolvePlanningAgentSetting({})).toBe("claude");
  });
});

describe("parsePlanningAgentArg", () => {
  test("codex / codexSol は codexSol に正規化する", () => {
    expect(parsePlanningAgentArg("codex")).toBe("codexSol");
    expect(parsePlanningAgentArg("codexSol")).toBe("codexSol");
    expect(parsePlanningAgentArg("claude")).toBe("claude");
    expect(parsePlanningAgentArg("opus")).toBeNull();
  });
});

describe("formatPlanningAgent", () => {
  test("表示用ラベルを返す", () => {
    expect(formatPlanningAgent("claude")).toContain("claude");
    expect(formatPlanningAgent("codexSol")).toContain("codexSol");
  });
});
