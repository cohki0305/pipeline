import { describe, expect, test } from "bun:test";
import type { PipelineConfig } from "./config";
import type { Finding } from "./stages/review";
import {
  LEGACY_PIPELINE_STATE_FILE,
  findIssueDesignDoc,
  loadPipelineState,
  pipelineStatePath,
  resolveResumePlan,
  savePipelineState,
  type PipelineState,
} from "./pipeline-state";

const CONFIG = {
  commands: { lint: "l", typecheck: "tc", test: "t" },
  designDocDir: "docs/plans",
  reportDir: "docs/runs",
  baseBranch: "main",
  worktreeRoot: "/wt",
} satisfies PipelineConfig;

const DOC = `---\ncomplexity: simple\n---\n\n# 計画`;

function makeIo(files: Record<string, string> = {}, dirs: Record<string, string[]> = {}) {
  const store = { ...files };
  return {
    readFile: async (path: string) => {
      if (store[path] === undefined) throw new Error(`ENOENT: ${path}`);
      return store[path];
    },
    writeFile: async (path: string, content: string) => {
      store[path] = content;
    },
    readdir: async (dir: string) => dirs[dir] ?? [],
    unlink: async (path: string) => {
      delete store[path];
    },
    store,
  };
}

describe("findIssueDesignDoc", () => {
  test("issue 番号に一致する設計書の相対パスを返す", async () => {
    const io = makeIo({}, { "/wt/issue-143/docs/plans": ["2026-07-19-issue-143.md", "2026-07-20-issue-144.md"] });
    expect(await findIssueDesignDoc(io.readdir, "/wt/issue-143", CONFIG.designDocDir, 143)).toBe("docs/plans/2026-07-19-issue-143.md");
  });

  test("複数ある場合はファイル名で最新を選ぶ", async () => {
    const io = makeIo({}, { "/wt/issue-143/docs/plans": ["2026-07-18-issue-143.md", "2026-07-20-issue-143.md"] });
    expect(await findIssueDesignDoc(io.readdir, "/wt/issue-143", CONFIG.designDocDir, 143)).toBe("docs/plans/2026-07-20-issue-143.md");
  });

  test("なければ null", async () => {
    const io = makeIo({}, { "/wt/issue-143/docs/plans": ["2026-07-19-issue-99.md"] });
    expect(await findIssueDesignDoc(io.readdir, "/wt/issue-143", CONFIG.designDocDir, 143)).toBeNull();
  });
});

describe("loadPipelineState / savePipelineState", () => {
  test("状態ファイルがなければ issue 番号だけの初期状態", async () => {
    const io = makeIo();
    expect(await loadPipelineState(io, "/wt/issue-143/.pipeline-state.json", 143)).toEqual({ issue: 143 });
  });

  test("状態を読み書きできる", async () => {
    const io = makeIo();
    const path = "/wt/issue-143/.pipeline-state.json";
    const state: PipelineState = {
      issue: 143,
      design: { docPath: "docs/plans/x.md", complexity: "simple" },
      implement: true,
    };
    await savePipelineState(io, path, state);
    expect(JSON.parse(io.store[path]!)).toEqual(state);
    expect(await loadPipelineState(io, path, 143)).toEqual(state);
  });
});

describe("resolveResumePlan", () => {
  test("fresh はすべて実行", () => {
    const plan = resolveResumePlan("fresh", { issue: 143 }, null);
    expect(plan).toEqual({
      skipDesign: false,
      skipImplement: false,
      skipQualityGateInitial: false,
      resumeReview: false,
      resumeFollowup: false,
    });
  });

  test("設計のみ完了なら実装から再開", () => {
    const plan = resolveResumePlan(
      "resume",
      { issue: 143, design: { docPath: "docs/plans/x.md", complexity: "complex" } },
      null,
    );
    expect(plan.skipDesign).toBe(true);
    expect(plan.designDocPath).toBe("docs/plans/x.md");
    expect(plan.complexity).toBe("complex");
    expect(plan.skipImplement).toBe(false);
  });

  test("実装完了なら品質ゲートから再開", () => {
    const plan = resolveResumePlan(
      "resume",
      {
        issue: 143,
        design: { docPath: "docs/plans/x.md", complexity: "simple" },
        implement: true,
      },
      null,
    );
    expect(plan.skipDesign).toBe(true);
    expect(plan.skipImplement).toBe(true);
    expect(plan.skipQualityGateInitial).toBe(false);
  });

  test("初回コミット済みならレビューから再開", () => {
    const plan = resolveResumePlan(
      "resume",
      {
        issue: 143,
        design: { docPath: "docs/plans/x.md", complexity: "simple" },
        implement: true,
        initialCommit: true,
        prTitle: "feat: x",
      },
      null,
    );
    expect(plan.skipQualityGateInitial).toBe(true);
    expect(plan.prTitle).toBe("feat: x");
    expect(plan.resumeReview).toBe(false);
  });

  test("レビュー途中なら未解消指摘の修正から再開", () => {
    const outstanding: Finding[] = [
      { id: "R1-1", file: "app/a.ts", line: 1, severity: "high", message: "直せ", lintable: false },
    ];
    const plan = resolveResumePlan(
      "resume",
      {
        issue: 143,
        design: { docPath: "docs/plans/x.md", complexity: "simple" },
        implement: true,
        initialCommit: true,
        review: { round: 1, outstanding },
      },
      null,
    );
    expect(plan.resumeReview).toBe(true);
    expect(plan.resumeFollowup).toBe(false);
    expect(plan.reviewRound).toBe(1);
    expect(plan.outstanding).toEqual(outstanding);
  });

  test("反映済み（applied）なら修正を繰り返さず消し込みレビューから再開", () => {
    const outstanding: Finding[] = [
      { id: "R1-1", file: "app/a.ts", line: 1, severity: "high", message: "直せ", lintable: false },
    ];
    const plan = resolveResumePlan(
      "resume",
      {
        issue: 143,
        design: { docPath: "docs/plans/x.md", complexity: "simple" },
        implement: true,
        initialCommit: true,
        review: { round: 1, outstanding, phase: "applied" },
      },
      null,
    );
    expect(plan.resumeReview).toBe(false);
    expect(plan.resumeFollowup).toBe(true);
    expect(plan.outstanding).toEqual(outstanding);
  });

  test("状態に設計がなくても worktree 内の設計書を検出する", () => {
    const plan = resolveResumePlan("resume", { issue: 143 }, "docs/plans/2026-07-19-issue-143.md");
    expect(plan.skipDesign).toBe(true);
    expect(plan.designDocPath).toBe("docs/plans/2026-07-19-issue-143.md");
  });
});

describe("pipelineStatePath", () => {
  test("worktree の外（worktree 置き場の直下）に置く", () => {
    const path = pipelineStatePath(CONFIG.worktreeRoot, 143);
    expect(path).toBe("/wt/.pipeline-state-issue-143.json");
    expect(path.startsWith("/wt/issue-143/")).toBe(false);
  });

  test("旧配置のファイル名は移行用に残っている", () => {
    expect(LEGACY_PIPELINE_STATE_FILE).toBe(".pipeline-state.json");
  });
});
