import { describe, expect, test } from "bun:test";
import type { PipelineConfig } from "../config";
import {
  appendReviewFindings,
  loadDesign,
  nextRevision,
  parseDesignOutput,
  reviseDesignFromReview,
  runDesign,
} from "./design";

const CONFIG = {
  commands: { lint: "l", typecheck: "tc", test: "t" },
  designDocDir: "docs/plans",
  reportDir: "docs/runs",
  baseBranch: "main",
  worktreeRoot: "/wt",
} satisfies PipelineConfig;

const DOC = `---\ncomplexity: simple\n---\n\n# 計画`;

describe("parseDesignOutput", () => {
  test("frontmatter から complexity を取り出す", () => {
    expect(parseDesignOutput(DOC)).toEqual({ complexity: "simple", content: DOC, screenshots: [] });
  });

  test("frontmatter の screenshots を取り出す", () => {
    const doc = `---\ncomplexity: simple\nscreenshots: ["/", "/settings"]\n---\n\n# 計画`;
    expect(parseDesignOutput(doc).screenshots).toEqual(["/", "/settings"]);
  });

  test("screenshots の不正値は空配列に落とす（設計全体を落とさない）", () => {
    const invalidJson = `---\ncomplexity: simple\nscreenshots: [broken\n---\n\n# 計画`;
    expect(parseDesignOutput(invalidJson).screenshots).toEqual([]);
    const nonPath = `---\ncomplexity: simple\nscreenshots: ["settings", 1, "/ok"]\n---\n\n# 計画`;
    expect(parseDesignOutput(nonPath).screenshots).toEqual(["/ok"]);
  });

  test("complexity がなければ throw する", () => {
    expect(() => parseDesignOutput("# 計画のみ")).toThrow("complexity");
  });

  test("frontmatter 外の complexity 言及には誤マッチしない", () => {
    const doc = "---\ntitle: x\n---\n\n本文で complexity: simple と書く\n\n---\nfooter";
    expect(() => parseDesignOutput(doc)).toThrow("complexity");
  });
});

describe("loadDesign", () => {
  test("外部ファイルの設計書を読み、worktree に書き込んで complexity を返す", async () => {
    const written: { path: string; content: string }[] = [];
    const result = await loadDesign(
      {
        cwd: "/work",
        config: CONFIG,
        readFile: async (path) => {
          expect(path).toBe("/home/user/my-design.md");
          return DOC;
        },
        writeFile: async (path, content) => {
          written.push({ path, content });
        },
      },
      { number: 143, title: "直す", body: "本文" },
      "2026-07-20",
      "/home/user/my-design.md",
    );
    expect(result.complexity).toBe("simple");
    expect(result.docPath).toBe("docs/plans/2026-07-20-issue-143.md");
    expect(written).toEqual([{ path: "/work/docs/plans/2026-07-20-issue-143.md", content: DOC }]);
  });

  test("complexity frontmatter がない設計書は throw する", async () => {
    expect(
      loadDesign(
        {
          cwd: "/work",
          config: CONFIG,
          readFile: async () => "# frontmatter なし",
          writeFile: async () => {},
        },
        { number: 143, title: "直す", body: "本文" },
        "2026-07-20",
        "/home/user/no-frontmatter.md",
      ),
    ).rejects.toThrow("complexity");
  });
});

describe("runDesign", () => {
  test("claude を呼び、doc を書き、結果を返す", async () => {
    const written: { path: string; content: string }[] = [];
    const result = await runDesign(
      {
        agent: async (agent, prompt) => {
          expect(agent).toBe("claude");
          expect(prompt).toContain("issue #143");
          return DOC;
        },
        cwd: "/work",
        config: CONFIG,
        writeFile: async (path, content) => {
          written.push({ path, content });
        },
      },
      { number: 143, title: "直す", body: "本文" },
      "2026-07-19",
    );
    expect(result.complexity).toBe("simple");
    expect(result.docPath).toBe("docs/plans/2026-07-19-issue-143.md");
    expect(written).toEqual([{ path: "/work/docs/plans/2026-07-19-issue-143.md", content: DOC }]);
  });

  test("planningAgent: codexSol なら設計を codex に依頼する", async () => {
    await runDesign(
      {
        agent: async (agent) => {
          expect(agent).toBe("codexSol");
          return DOC;
        },
        cwd: "/work",
        config: { ...CONFIG, planningAgent: "codexSol" },
        writeFile: async () => {},
      },
      { number: 143, title: "直す", body: "本文" },
      "2026-07-19",
    );
  });
});

describe("nextRevision", () => {
  test("revision がなければ 2、あれば +1", () => {
    expect(nextRevision(DOC)).toBe(2);
    expect(nextRevision(`---\ncomplexity: simple\nrevision: 2\n---\n`)).toBe(3);
  });
});

describe("appendReviewFindings", () => {
  const finding = { id: "R1-1", file: "a.ts", line: 1, severity: "high", message: "直せ", lintable: false } as const;

  test("エージェントを呼ばず frontmatter と末尾へレビュー指摘を追記する", () => {
    const revised = appendReviewFindings(DOC, [finding]);
    expect(revised).toContain("revision: 2");
    expect(revised).toContain("## レビュー反映（revision 2）");
    expect(revised).toContain("R1-1: 直せ（a.ts:1）");
  });

  test("同じ指摘の再開時は重複追記しない", () => {
    const once = appendReviewFindings(DOC, [finding]);
    expect(appendReviewFindings(once, [finding])).toBe(once);
  });
});

describe("reviseDesignFromReview", () => {
  test("設計担当を呼ばず、同じ docPath に機械的に上書きする", async () => {
    const written: { path: string; content: string }[] = [];
    const result = await reviseDesignFromReview(
      {
        cwd: "/work",
        writeFile: async (path, content) => {
          written.push({ path, content });
        },
      },
      { complexity: "simple", docPath: "docs/plans/x.md", docContent: DOC },
      [{ id: "R1-1", file: "a.ts", line: 1, severity: "high", message: "直せ", lintable: false }],
    );
    expect(result.docPath).toBe("docs/plans/x.md");
    expect(result.docContent).toContain("revision: 2");
    expect(written[0]!.path).toBe("/work/docs/plans/x.md");
  });
});
