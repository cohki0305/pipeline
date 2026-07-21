import { describe, expect, test } from "bun:test";
import type { PipelineConfig } from "../config";
import { buildCommitMessagePrompt, runCommitMessage, validateCommitMessage } from "./commit-message";

const config = {
  commands: { lint: "bun run lint", typecheck: "bun run typecheck", test: "bun test" },
  designDocDir: "docs/plans",
  reportDir: "docs/runs",
  baseBranch: "main",
  worktreeRoot: "/wt",
  planningAgent: "codexSol",
} satisfies PipelineConfig;

const VALID = `fix: Cookie解析時の境界値処理を安全化

不正なCookieでも回答画面を壊さず、既存回答から下書きを復元できるようにする。`;

const exec = async (command: string) => ({
  code: 0,
  stdout: command === "git status --short" ? " M src/cookie.ts\n" : "diff --git a/src/cookie.ts b/src/cookie.ts\n",
  stderr: "",
});

describe("runCommitMessage", () => {
  test("実差分を調査させ、WHY と issue 番号を含むメッセージを返す", async () => {
    const calls: { agent: string; prompt: string; opts: unknown }[] = [];
    const message = await runCommitMessage(
      {
        agent: async (agent, prompt, opts) => {
          calls.push({ agent, prompt, opts });
          return VALID;
        },
        config,
        exec,
        cwd: "/wt/issue-14",
      },
      { reference: { kind: "issue", number: 14 }, purpose: "review", context: "Cookie解析の例外処理" },
    );

    expect(message).toBe(`${VALID}\n\n関連: #14`);
    expect(calls[0]!.agent).toBe("codexSol");
    expect(calls[0]!.prompt).toContain("git diff --cached");
    expect(calls[0]!.prompt).toContain("Cookie解析の例外処理");
    expect(calls[0]!.opts).toEqual({ cwd: "/wt/issue-14", model: undefined });
  });

  test("PR のフィードバック修正には PR 番号を付ける", async () => {
    const message = await runCommitMessage(
      { agent: async () => VALID, config, exec, cwd: "/wt/pr-3" },
      { reference: { kind: "pr", number: 3 }, purpose: "feedback" },
    );
    expect(message).toEndWith("関連: PR #3");
  });

  test("purpose ごとに具体的な変更内容を要求する", () => {
    expect(buildCommitMessagePrompt({ reference: { kind: "pr", number: 3 }, purpose: "feedback" })).toContain(
      "どのコードや挙動をどう修正",
    );
    expect(buildCommitMessagePrompt({ reference: { kind: "pr", number: 3 }, purpose: "conflict" })).toContain(
      "双方の意図",
    );
  });
});

describe("validateCommitMessage", () => {
  test("抽象的な作業名や形式不正を拒否する", () => {
    for (const output of [
      "fix: レビュー反映を実装\n\nレビュー指摘へ対応するため。",
      "fix: レビューコメントに対応\n\nレビュー指摘へ対応するため。",
      "fix: CI 失敗に対応\n\nテストを通過させるため。",
      "修正する",
      "fix: バグ修正",
    ]) {
      expect(() => validateCommitMessage(output)).toThrow("不正なコミットメッセージ");
    }
  });

  test("具体的な変更と理由を含むメッセージを許可する", () => {
    expect(validateCommitMessage(VALID)).toBe(VALID);
  });
});
