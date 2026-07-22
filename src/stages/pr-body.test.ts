import { describe, expect, test } from "bun:test";
import type { PipelineConfig } from "../config";
import { buildPrBodyPrompt, runPrBody, validatePrBody } from "./pr-body";

const config = {
  commands: { lint: "bun run lint", typecheck: "bun run typecheck", test: "bun test" },
  designDocDir: "docs/plans",
  reportDir: "docs/runs",
  baseBranch: "main",
  worktreeRoot: "/wt",
  reviewModel: "opus",
} satisfies PipelineConfig;

const validBody = `Closes #143

## 変更概要
公開アンケートの重複回答を防ぎ、同一端末への特典の二重発行を避けます。

## 実装方針
Cookieによる早期判定とDB制約を組み合わせ、競合時にも整合性を維持します。

## 主な変更
- 回答時に端末トークンを保存し、既存回答を検出する処理を追加しました。
- DB制約違反を回答済みとして扱い、競合リクエストを安全に処理します。

## 検証
- bun testを実行し、全テストが成功しました。
- lintとtypecheckが成功しました。

## レビュー観点
- Cookie属性とDB制約の組み合わせが境界条件でも安全か確認してください。

## 関連ドキュメント
- 設計: docs/plans/issue-143.md
- 実行レポート: docs/runs/issue-143.md`;

const exec = async (command: string) => ({
  code: 0,
  stdout: command.startsWith("git diff")
    ? "diff --git a/src/answer.ts b/src/answer.ts\n"
    : "abc1234 fix: 重複回答時の特典発行を防止\n",
  stderr: "",
});

const readFile = async (path: string) =>
  path.includes("docs/plans") ? "# 設計\nCookieとDB制約を併用する。" : "# 実行レポート\n全品質ゲート成功。";

describe("runPrBody", () => {
  test("diff と関連資料を調査させ、レビュー可能な本文を返す", async () => {
    const calls: { agent: string; prompt: string; opts: unknown }[] = [];
    const body = await runPrBody(
      {
        agent: async (agent, prompt, opts) => {
          calls.push({ agent, prompt, opts });
          return validBody;
        },
        config,
        exec,
        readFile,
        cwd: "/wt/issue-143",
      },
      {
        issue: { number: 143, title: "重複回答を防ぐ", body: "同一端末からの再回答を防止する" },
        designDocPath: "docs/plans/issue-143.md",
        reportPath: "docs/runs/issue-143.md",
      },
    );

    expect(body).toBe(validBody);
    expect(calls[0]!.agent).toBe("claude");
    expect(calls[0]!.opts).toEqual({ cwd: "/wt/issue-143", model: "opus" });
    expect(calls[0]!.prompt).toContain("git diff origin/main...HEAD");
    expect(calls[0]!.prompt).toContain("リスク、境界条件");
  });
});

describe("validatePrBody", () => {
  test("必須セクションの欠落・順序違反・情報不足を拒否する", () => {
    expect(() => validatePrBody("Closes #143\n\n変更しました。", 143)).toThrow("レビュー要件");
    const reordered = validBody.replace("## 変更概要", "## TEMP").replace("## 実装方針", "## 変更概要").replace("## TEMP", "## 実装方針");
    expect(() => validatePrBody(reordered, 143)).toThrow("レビュー要件");
  });

  test("レビューに必要な情報を含む本文を許可する", () => {
    expect(validatePrBody(validBody, 143)).toBe(validBody);
  });
});

describe("buildPrBodyPrompt", () => {
  test("レビュー判断に必要な観点を明示する", () => {
    const prompt = buildPrBodyPrompt(config, {
      issue: { number: 143, title: "重複回答を防ぐ", body: "本文" },
      designDocPath: "docs/plans/issue-143.md",
      reportPath: "docs/runs/issue-143.md",
    });
    expect(prompt).toContain("重要な判断とその理由");
    expect(prompt).toContain("意図的なトレードオフ");
  });
});
