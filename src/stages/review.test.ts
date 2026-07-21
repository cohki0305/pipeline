// src/stages/review.test.ts
import { describe, expect, test } from "bun:test";
import type { PipelineConfig } from "../config";
import {
  type Finding,
  assignIds,
  buildFollowupPrompt,
  isBlocking,
  parseFindings,
  parseFollowupOutput,
  partitionBlocking,
  runFollowupReview,
  runReview,
} from "./review";

const CONFIG = {
  commands: { lint: "l", typecheck: "tc", test: "t" },
  designDocDir: "d",
  reportDir: "r",
  baseBranch: "main",
  worktreeRoot: "/wt",
} satisfies PipelineConfig;

const FINDING = { file: "app/a.ts", line: 3, severity: "high", message: "N+1", lintable: false };

describe("parseFindings", () => {
  test("素の JSON 配列をパースする", () => {
    expect(parseFindings(JSON.stringify([FINDING]))).toEqual([FINDING]);
  });

  test("コードフェンスと前置きが付いていてもパースする", () => {
    const out = '指摘は以下です。\n```json\n[' + JSON.stringify(FINDING) + "]\n```";
    expect(parseFindings(out)).toEqual([FINDING]);
  });

  test("空配列は指摘なし", () => {
    expect(parseFindings("[]")).toEqual([]);
  });

  test("JSON 配列が見つからなければ throw する", () => {
    expect(() => parseFindings("問題ありません")).toThrow("JSON");
  });

  test("前置きや後書きに角括弧が混ざっても正しい配列を抽出する", () => {
    const arr = JSON.stringify([FINDING]);
    expect(parseFindings(`[Note] レビュー結果です。\n${arr}`)).toEqual([FINDING]);
    expect(parseFindings(`${arr}\n補足: issue #12] を参照`)).toEqual([FINDING]);
    expect(parseFindings(`配列[0] は重要です。\n${arr}`)).toEqual([FINDING]);
  });
});

describe("runReview", () => {
  test("diff を取得してプロンプトに埋め込み claude に依頼する", async () => {
    const findings = await runReview({
      exec: async (cmd, opts) => {
        expect(cmd).toBe("git diff origin/main...HEAD");
        expect(opts?.cwd).toBe("/work");
        return { code: 0, stdout: "diff --git a/x.ts b/x.ts", stderr: "" };
      },
      agent: async (agent, prompt) => {
        expect(agent).toBe("claude");
        expect(prompt).toContain("git diff origin/main...HEAD");
        expect(prompt).toContain("diff --git a/x.ts b/x.ts");
        return JSON.stringify([FINDING]);
      },
      cwd: "/work",
      config: CONFIG,
    });
    expect(findings).toEqual([FINDING]);
  });

  test("planningAgent: codexSol ならレビューを codex に依頼する", async () => {
    await runReview({
      exec: async () => ({ code: 0, stdout: "diff --git a/x.ts b/x.ts", stderr: "" }),
      agent: async (agent) => {
        expect(agent).toBe("codexSol");
        return "[]";
      },
      cwd: "/work",
      config: { ...CONFIG, planningAgent: "codexSol" },
    });
  });

  test("git diff 失敗は throw する", async () => {
    expect(
      runReview({
        exec: async () => ({ code: 128, stdout: "", stderr: "not a git repository" }),
        agent: async () => "[]",
        cwd: "/work",
        config: CONFIG,
      }),
    ).rejects.toThrow("git diff");
  });
});

describe("severity ゲート", () => {
  test("critical/high/medium はブロック、low は非ブロック", () => {
    const f = (severity: string) => ({ ...FINDING, severity }) as Finding;
    expect(isBlocking(f("critical"))).toBe(true);
    expect(isBlocking(f("high"))).toBe(true);
    expect(isBlocking(f("medium"))).toBe(true);
    expect(isBlocking(f("low"))).toBe(false);
  });
});

describe("assignIds", () => {
  test("id がない指摘に R{round}-{n} を振り、既存 id は保持する", () => {
    const out = assignIds([{ ...FINDING } as Finding, { ...FINDING, id: "R1-2" } as Finding], 2);
    expect(out[0]!.id).toBe("R2-1");
    expect(out[1]!.id).toBe("R1-2");
  });
});

describe("partitionBlocking", () => {
  test("blocking を lintable と structural に分ける", () => {
    const findings = [
      { file: "a.ts", line: 1, severity: "high", message: "lint", lintable: true },
      { file: "b.ts", line: 2, severity: "high", message: "設計", lintable: false },
      { file: "c.ts", line: 3, severity: "low", message: "low", lintable: true },
    ] as Finding[];
    expect(partitionBlocking(findings)).toEqual({
      lintable: [findings[0]],
      structural: [findings[1]],
    });
  });
});

describe("消し込みレビュー", () => {
  const OUTSTANDING = [{ ...FINDING, id: "R1-1" } as Finding];

  test("buildFollowupPrompt は前回指摘の id と diff を含む", () => {
    const p = buildFollowupPrompt("main...HEAD", "diff --git a/x", OUTSTANDING);
    expect(p).toContain("R1-1");
    expect(p).toContain("diff --git a/x");
    expect(p).toContain('"fixed"');
    expect(p).toContain('"remaining"');
  });

  test("parseFollowupOutput は前置き付きでも fixed / remaining を取り出す", () => {
    const out =
      '判定します。\n```json\n{"fixed": ["R1-1"], "remaining": [' + JSON.stringify({ ...FINDING, id: null }) + "]}\n```";
    const r = parseFollowupOutput(out);
    expect(r.fixed).toEqual(["R1-1"]);
    expect(r.remaining).toHaveLength(1);
  });

  test("parseFollowupOutput は remaining がなければ throw する", () => {
    expect(() => parseFollowupOutput("全部直りました")).toThrow("JSON");
  });

  test("runFollowupReview は diff と前回指摘を渡して判定を得る", async () => {
    const r = await runFollowupReview(
      {
        exec: async () => ({ code: 0, stdout: "diff --git a/x", stderr: "" }),
        agent: async (agent, prompt) => {
          expect(agent).toBe("composerFast");
          expect(prompt).toContain("R1-1");
          return '{"fixed": ["R1-1"], "remaining": []}';
        },
        cwd: "/work",
        config: CONFIG,
      },
      OUTSTANDING,
      "0123456789abcdef0123456789abcdef01234567",
    );
    expect(r).toEqual({ fixed: ["R1-1"], remaining: [] });
  });

  test("runFollowupReview は修正前 SHA からの差分だけを取得する", async () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    await runFollowupReview(
      {
        exec: async (cmd) => {
          expect(cmd).toBe(`git diff ${sha}..HEAD`);
          return { code: 0, stdout: "diff --git a/x", stderr: "" };
        },
        agent: async () => '{"fixed":["R1-1"],"remaining":[]}',
        cwd: "/work",
        config: CONFIG,
      },
      OUTSTANDING,
      sha,
    );
  });

  test("runFollowupReview は不正な JSON を 1 回だけ再整形して回復する", async () => {
    let calls = 0;
    const r = await runFollowupReview(
      {
        exec: async () => ({ code: 0, stdout: "diff --git a/x", stderr: "" }),
        agent: async (agent, prompt) => {
          calls++;
          if (calls === 1) {
            expect(agent).toBe("composerFast");
            return '{"fixed":["R1-1"],"remaining":[{"id":null';
          }
          expect(agent).toBe("composer");
          expect(prompt).toContain("JSON を修復");
          expect(prompt).toContain('"id":null');
          return '{"fixed":["R1-1"],"remaining":[]}';
        },
        cwd: "/work",
        config: CONFIG,
      },
      OUTSTANDING,
    );
    expect(calls).toBe(2);
    expect(r).toEqual({ fixed: ["R1-1"], remaining: [] });
  });
});
