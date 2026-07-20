import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Exec } from "./exec";

export type AgentName = "claude" | "codexSol" | "composer";
export type AgentOpts = { cwd: string; timeoutMs?: number };
export type AgentRunner = (agent: AgentName, prompt: string, opts: AgentOpts) => Promise<string>;

// NOTES.md の疎通確認で確定したコマンド。codex/cursor-agent は stdin を読む仕様のため /dev/null が必要
export const AGENT_COMMANDS: Record<AgentName, string> = {
  claude: 'claude -p --output-format json < "$PROMPT_FILE"',
  codexSol: 'codex exec -s workspace-write -m gpt-5.6-sol "$(cat "$PROMPT_FILE")" < /dev/null',
  composer: 'cursor-agent -p --model composer-2.5 -f "$(cat "$PROMPT_FILE")" < /dev/null',
};

export function makeAgentRunner(exec: Exec): AgentRunner {
  return async (agent, prompt, opts) => {
    // シェル引数のクオート事故を避けるためプロンプトはファイル渡し
    const promptFile = join(mkdtempSync(join(tmpdir(), "agent-pipeline-")), "prompt.md");
    writeFileSync(promptFile, prompt);
    const result = await exec(AGENT_COMMANDS[agent], {
      cwd: opts.cwd,
      timeoutMs: opts.timeoutMs,
      env: { PROMPT_FILE: promptFile },
    });
    if (result.code !== 0) {
      throw new Error(`${agent} が失敗 (exit ${result.code}): ${result.stderr.slice(0, 2000)}`);
    }
    return agent === "claude" ? extractClaudeResult(result.stdout) : result.stdout;
  };
}

export function extractClaudeResult(stdout: string): string {
  try {
    const parsed = JSON.parse(stdout);
    if (typeof parsed?.result === "string") return parsed.result;
  } catch {}
  return stdout;
}
