import { describe, expect, test } from "bun:test";
import type { PipelineConfig } from "../config";
import { loadDesign, parseDesignOutput, runDesign } from "./design";

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
    expect(parseDesignOutput(DOC)).toEqual({ complexity: "simple", content: DOC });
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
