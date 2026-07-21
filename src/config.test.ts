import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config";

function tempProject(config: object | null): string {
  const dir = mkdtempSync(join(tmpdir(), "pipeline-config-"));
  if (config !== null) writeFileSync(join(dir, ".agent-pipeline.json"), JSON.stringify(config));
  return dir;
}

const VALID = { commands: { lint: "bun run lint:all", typecheck: "bun run typecheck", test: "bun run test" } };

describe("loadConfig", () => {
  test("commands を読み、未指定項目にデフォルトを適用する", () => {
    const dir = tempProject(VALID);
    const cfg = loadConfig(dir);
    expect(cfg.commands.lint).toBe("bun run lint:all");
    expect(cfg.designDocDir).toBe("docs/agent-pipeline/plans");
    expect(cfg.reportDir).toBe("docs/agent-pipeline/runs");
    expect(cfg.baseBranch).toBe("main");
    expect(cfg.worktreeRoot).toBe(join(dir, "..", "pipeline-worktrees"));
  });

  test("明示指定はデフォルトより優先される", () => {
    const dir = tempProject({ ...VALID, baseBranch: "develop", worktreeRoot: "/tmp/wt" });
    const cfg = loadConfig(dir);
    expect(cfg.baseBranch).toBe("develop");
    expect(cfg.worktreeRoot).toBe("/tmp/wt");
  });

  test("設定ファイルがなければ throw する", () => {
    expect(() => loadConfig(tempProject(null))).toThrow(".agent-pipeline.json");
  });

  test("commands が欠けていれば throw する", () => {
    const dir = tempProject({ commands: { lint: "x", typecheck: "y" } });
    expect(() => loadConfig(dir)).toThrow("commands.test");
  });

  test("planningAgent が未対応の値なら throw する", () => {
    const dir = tempProject({ ...VALID, planningAgent: "codex" });
    expect(() => loadConfig(dir)).toThrow("planningAgent");
  });

  test("planningAgent は未指定でも対応値でも通る", () => {
    expect(loadConfig(tempProject(VALID)).planningAgent).toBeUndefined();
    expect(loadConfig(tempProject({ ...VALID, planningAgent: "codexSol" })).planningAgent).toBe("codexSol");
    expect(loadConfig(tempProject({ ...VALID, planningAgent: "claude" })).planningAgent).toBe("claude");
  });

  test("efficiencyAgents が未対応の値なら throw する", () => {
    const dir = tempProject({ ...VALID, efficiencyAgents: { gateFix: "claude" } });
    expect(() => loadConfig(dir)).toThrow("efficiencyAgents.gateFix");
  });
});
