import { describe, expect, test } from "bun:test";
import type { PipelineConfig } from "../config";
import {
  buildCommitMessagePrompt,
  collectCommitEvidence,
  extractCommitMessageCandidate,
  hasUncommittedChanges,
  runCommitMessage,
  validateCommitMessage,
} from "./commit-message";

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

  test("エージェントが前置き付きコードフェンスで返してもフェンス内を採用する", async () => {
    const message = await runCommitMessage(
      { agent: async () => `以下がコミットメッセージです。\n\n\`\`\`\n${VALID}\n\`\`\``, config, exec, cwd: "/wt/issue-14" },
      { reference: { kind: "issue", number: 14 }, purpose: "initial" },
    );
    expect(message).toBe(`${VALID}\n\n関連: #14`);
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

describe("collectCommitEvidence", () => {
  test("未追跡ファイルは intent-to-add して diff に含める", async () => {
    const calls: string[] = [];
    const evidence = await collectCommitEvidence({
      cwd: "/wt/issue-14",
      exec: async (command) => {
        calls.push(command);
        if (command === "git ls-files -o --exclude-standard") {
          return { code: 0, stdout: "src/new.ts\n", stderr: "" };
        }
        if (command === "git add -N .") return { code: 0, stdout: "", stderr: "" };
        if (command === "git status --short") return { code: 0, stdout: " A src/new.ts\n", stderr: "" };
        if (command === "git diff --no-ext-diff") {
          return { code: 0, stdout: "diff --git a/src/new.ts b/src/new.ts\n+export const x = 1;\n", stderr: "" };
        }
        if (command === "git diff --cached --no-ext-diff") return { code: 0, stdout: "", stderr: "" };
        return { code: 1, stdout: "", stderr: "unexpected" };
      },
    });

    expect(calls).toContain("git add -N .");
    expect(evidence).toContain("src/new.ts");
    expect(evidence).toContain("export const x = 1");
  });
});

describe("hasUncommittedChanges", () => {
  test("sinceSha 指定時は未追跡ファイルも変更として扱う", async () => {
    const exec = async (command: string) => ({
      code: 0,
      stdout: command.startsWith("git diff --name-only")
        ? ""
        : command === "git ls-files -o --exclude-standard"
          ? "src/new.ts\n"
          : "",
      stderr: "",
    });
    expect(await hasUncommittedChanges({ exec, cwd: "/wt" }, { sinceSha: "abc1234" })).toBe(true);
  });

  test("差分も未追跡もなければ false", async () => {
    const exec = async () => ({ code: 0, stdout: "", stderr: "" });
    expect(await hasUncommittedChanges({ exec, cwd: "/wt" }, { sinceSha: "abc1234" })).toBe(false);
    expect(await hasUncommittedChanges({ exec, cwd: "/wt" })).toBe(false);
  });
});

describe("extractCommitMessageCandidate", () => {
  test("前置きや解説に包まれたコードフェンスからフェンス内だけを取り出す", () => {
    const output = `コミットメッセージを作成しました。\n\n\`\`\`\n${VALID}\n\`\`\`\n\n★ Insight ─────\nsubject は挙動を先に表しています。\n─────`;
    expect(extractCommitMessageCandidate(output)).toBe(VALID);
  });

  test("言語タグ付きフェンスも取り出せる", () => {
    expect(extractCommitMessageCandidate(`\`\`\`text\n${VALID}\n\`\`\``)).toBe(VALID);
  });

  test("フェンスがなければ trim して返す", () => {
    expect(extractCommitMessageCandidate(`\n${VALID}\n`)).toBe(VALID);
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
