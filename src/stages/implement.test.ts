import { describe, expect, test } from "bun:test";
import { buildFixPrompt, buildRevisionImplementPrompt, implementerFor, runImplement, runImplementRevision } from "./implement";

describe("implementerFor", () => {
  test("simple は composer、complex は codexSol", () => {
    expect(implementerFor("simple")).toBe("composer");
    expect(implementerFor("complex")).toBe("codexSol");
  });
});

describe("buildFixPrompt", () => {
  test("スコープ制約と違反 JSON を含む", () => {
    const p = buildFixPrompt("lint", '[{"file":"a.ts"}]');
    expect(p).toContain("他のコードは触らない");
    expect(p).toContain('[{"file":"a.ts"}]');
  });
});

describe("runImplement", () => {
  test("complexity に応じたエージェントに計画を渡す", async () => {
    const calls: { agent: string; prompt: string }[] = [];
    await runImplement(
      {
        agent: async (agent, prompt) => {
          calls.push({ agent, prompt });
          return "";
        },
        cwd: "/work",
      },
      { complexity: "complex", docContent: "# 計画" },
    );
    expect(calls[0]!.agent).toBe("codexSol");
    expect(calls[0]!.prompt).toContain("# 計画");
  });
});

describe("runImplementRevision", () => {
  test("更新計画を実装担当に渡す", async () => {
    const calls: { agent: string; prompt: string }[] = [];
    await runImplementRevision(
      {
        agent: async (agent, prompt) => {
          calls.push({ agent, prompt });
          return "";
        },
        cwd: "/work",
      },
      { complexity: "simple", docContent: "# 更新計画" },
    );
    expect(calls[0]!.prompt).toContain("更新された実装計画");
  });
});

describe("buildRevisionImplementPrompt", () => {
  test("既存コードへの反映を指示する", () => {
    expect(buildRevisionImplementPrompt("# x")).toContain("既存コードへ変更を反映");
  });
});
