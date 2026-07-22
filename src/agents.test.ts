import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Exec, ExecOpts } from "./exec";
import { AGENT_COMMANDS, extractClaudeResult, makeAgentRunner } from "./agents";

function fakeExec(result: { code: number; stdout: string; stderr?: string }) {
  const calls: { cmd: string; opts: ExecOpts }[] = [];
  const exec: Exec = async (cmd, opts = {}) => {
    calls.push({ cmd, opts });
    return { code: result.code, stdout: result.stdout, stderr: result.stderr ?? "" };
  };
  return { exec, calls };
}

describe("makeAgentRunner", () => {
  test("プロンプトを一時ファイルに書き PROMPT_FILE 経由で渡す", async () => {
    const { exec, calls } = fakeExec({ code: 0, stdout: "done" });
    const run = makeAgentRunner(exec);
    await run("composer", "直して", { cwd: "/work" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toContain("cursor-agent");
    expect(calls[0]!.opts.cwd).toBe("/work");
    const promptFile = calls[0]!.opts.env!.PROMPT_FILE!;
    expect(readFileSync(promptFile, "utf8")).toBe("直して");
  });

  test("model を渡すと CLAUDE_MODEL 環境変数で claude に伝える", async () => {
    const { exec, calls } = fakeExec({ code: 0, stdout: JSON.stringify({ result: "ok" }) });
    const run = makeAgentRunner(exec);
    await run("claude", "設計して", { cwd: "/work", model: "opus" });
    expect(calls[0]!.opts.env!.CLAUDE_MODEL).toBe("opus");
    expect(calls[0]!.cmd).toContain("CLAUDE_MODEL");
  });

  test("model 未指定なら CLAUDE_MODEL は空文字（flag 省略）", async () => {
    const { exec, calls } = fakeExec({ code: 0, stdout: JSON.stringify({ result: "ok" }) });
    const run = makeAgentRunner(exec);
    await run("claude", "設計して", { cwd: "/work" });
    expect(calls[0]!.opts.env!.CLAUDE_MODEL).toBe("");
  });

  test("安全でない model 名は拒否する", async () => {
    const { exec } = fakeExec({ code: 0, stdout: "{}" });
    const run = makeAgentRunner(exec);
    expect(run("claude", "x", { cwd: "/work", model: "opus; rm -rf /" })).rejects.toThrow("model");
  });

  test("claude の出力は JSON の result フィールドを取り出す", async () => {
    const { exec } = fakeExec({ code: 0, stdout: JSON.stringify({ result: "設計です", cost: 1 }) });
    const run = makeAgentRunner(exec);
    expect(await run("claude", "設計して", { cwd: "/work" })).toBe("設計です");
  });

  test("非ゼロ exit は throw する", async () => {
    const { exec } = fakeExec({ code: 1, stdout: "", stderr: "boom" });
    const run = makeAgentRunner(exec);
    expect(run("codexSol", "x", { cwd: "/work" })).rejects.toThrow("codexSol");
  });
});

describe("AGENT_COMMANDS", () => {
  test("codex は workspace-write サンドボックスと Sol を明示する", () => {
    expect(AGENT_COMMANDS.codexSol).toContain("-s workspace-write");
    expect(AGENT_COMMANDS.codexSol).toContain("gpt-5.6-sol");
    expect(AGENT_COMMANDS.codexSol).toContain("< /dev/null");
  });

  test("claude は user 設定を読まない（output style プラグインがコミットメッセージ等へ混入するのを防ぐ）", () => {
    expect(AGENT_COMMANDS.claude).toContain("--setting-sources project,local");
  });

  test("claude は JSON 出力、composer は composer-2.5 を指定する", () => {
    expect(AGENT_COMMANDS.claude).toContain("--output-format json");
    expect(AGENT_COMMANDS.composer).toContain("--model composer-2.5");
    expect(AGENT_COMMANDS.composer).toContain("< /dev/null");
    expect(AGENT_COMMANDS.composerFast).toContain("composer-2.5-fast");
  });
});

describe("extractClaudeResult", () => {
  test("JSON でない出力はそのまま返す", () => {
    expect(extractClaudeResult("plain text")).toBe("plain text");
  });
});
