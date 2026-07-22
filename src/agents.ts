import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Exec } from "./exec";

export type AgentName = "claude" | "codexSol" | "composer" | "composerFast";
export type AgentOpts = { cwd: string; timeoutMs?: number; model?: string };
export type AgentRunner = (agent: AgentName, prompt: string, opts: AgentOpts) => Promise<string>;

// NOTES.md の疎通確認で確定したコマンド。codex/cursor-agent は stdin を読む仕様のため /dev/null が必要。
// claude はモデルを CLAUDE_MODEL 経由で差し替え可能（設計/レビューを Fable→Opus 等に切り替える用途）
export const AGENT_COMMANDS: Record<AgentName, string> = {
  claude:
    'claude -p --output-format json --setting-sources project,local ${CLAUDE_MODEL:+--model $CLAUDE_MODEL} < "$PROMPT_FILE"',
  codexSol: 'codex exec -s workspace-write -m gpt-5.6-sol "$(cat "$PROMPT_FILE")" < /dev/null',
  composer: 'cursor-agent -p --model composer-2.5 -f "$(cat "$PROMPT_FILE")" < /dev/null',
  composerFast: 'cursor-agent -p --model composer-2.5-fast -f "$(cat "$PROMPT_FILE")" < /dev/null',
};

// モデル名はシェルに補間されるため厳格に検証する
const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;

export function makeAgentRunner(exec: Exec): AgentRunner {
  return async (agent, prompt, opts) => {
    if (opts.model && !SAFE_MODEL.test(opts.model)) {
      throw new Error(`安全でない model 名のため拒否: ${JSON.stringify(opts.model)}`);
    }
    // シェル引数のクオート事故を避けるためプロンプトはファイル渡し
    const promptFile = join(mkdtempSync(join(tmpdir(), "agent-pipeline-")), "prompt.md");
    writeFileSync(promptFile, prompt);
    const result = await exec(AGENT_COMMANDS[agent], {
      cwd: opts.cwd,
      timeoutMs: opts.timeoutMs,
      env: { PROMPT_FILE: promptFile, CLAUDE_MODEL: opts.model ?? "" },
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
