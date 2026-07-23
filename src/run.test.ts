import { describe, expect, test } from "bun:test";
import type { PipelineConfig } from "./config";
import type { ExecResult } from "./exec";
import { pipelineStatePath } from "./pipeline-state";
import { LoopExceededError, runPipeline } from "./run";

const CONFIG = {
  commands: { lint: "run-lint", typecheck: "run-tc", test: "run-test" },
  designDocDir: "docs/plans",
  reportDir: "docs/runs",
  baseBranch: "main",
  worktreeRoot: "/wt",
} satisfies PipelineConfig;

const DESIGN = (c: "simple" | "complex", revision?: number, screenshots?: string[]) =>
  `---\ncomplexity: ${c}${revision ? `\nrevision: ${revision}` : ""}${screenshots ? `\nscreenshots: ${JSON.stringify(screenshots)}` : ""}\n---\n# 計画`;
const OK: ExecResult = { code: 0, stdout: "", stderr: "" };
const COMMIT_MESSAGE = `feat: 回答状態の判定を安全化

不正な入力でも既存回答を壊さず、利用者が処理を継続できるようにする。`;
const PR_BODY = `Closes #143

## 変更概要
回答状態の判定を安全化し、不正な入力でも処理を継続できるようにします。

## 実装方針
設計書を入力の中心にして、品質ゲートと内部レビューを段階的に実行します。

## 主な変更
- 回答状態の検証処理と例外経路を追加しました。
- レビューで検出した境界条件を設計書と実装へ反映しました。

## 検証
- lint、typecheck、testの品質ゲートが成功しました。

## レビュー観点
- 不正な入力と既存回答が同時に存在する場合の挙動を確認してください。

## 関連ドキュメント
- 設計: docs/plans/2026-07-19-issue-143.md
- 実行レポート: docs/runs/issue-143.md`;

const findingsOf = (n: number, severity = "high") =>
  JSON.stringify(
    Array.from({ length: n }, (_, i) => ({ file: `app/f${i}.ts`, line: 1, severity, message: `指摘 ${i}`, lintable: false })),
  );
const followupOf = (n: number) =>
  JSON.stringify({
    fixed: [],
    remaining: Array.from({ length: n }, (_, i) => ({
      id: null,
      file: `app/f${i}.ts`,
      line: 1,
      severity: "high",
      message: `指摘 ${i}`,
      lintable: false,
    })),
  });

function makeHarness(opts: {
  complexity: "simple" | "complex";
  reviewOutputs?: string[];
  gateFailures?: { cmd: string; stdout: string; times: number }[];
  worktreeExists?: boolean;
  existingDesignDoc?: string;
  pipelineState?: string;
  mode?: "resume" | "fresh";
  autoFixCommands?: { lint?: string };
  currentBranch?: string;
  dirty?: boolean;
}) {
  const agentCalls: { agent: string; prompt: string }[] = [];
  const execCalls: string[] = [];
  const commitMessages: string[] = [];
  const createdPrArgs: { title: string; body: string; base: string }[] = [];
  const written: { path: string; content: string }[] = [];
  const fileStore: Record<string, string> = {};
  if (opts.existingDesignDoc) {
    fileStore[`/wt/issue-143/${opts.existingDesignDoc}`] = DESIGN(opts.complexity);
  }
  if (opts.pipelineState) {
    fileStore[pipelineStatePath(CONFIG.worktreeRoot, 143)] = opts.pipelineState;
  }
  const reviews = [...(opts.reviewOutputs ?? ["[]"])];
  const failures = (opts.gateFailures ?? []).map((f) => ({ ...f }));

  const deps = {
    config: { ...CONFIG, autoFixCommands: opts.autoFixCommands, uiScreenshot: opts.uiScreenshot },
    exec: async (cmd: string, execOpts?: { env?: Record<string, string> }): Promise<ExecResult> => {
      execCalls.push(cmd);
      if (execOpts?.env?.COMMIT_MSG) commitMessages.push(execOpts.env.COMMIT_MSG);
      if (cmd.startsWith("test -d")) return { code: opts.worktreeExists ? 0 : 1, stdout: "", stderr: "" };
      const f = failures.find((f) => cmd === f.cmd && f.times > 0);
      if (f) {
        f.times--;
        return { code: 1, stdout: f.stdout, stderr: "" };
      }
      if (cmd === opts.autoFixCommands?.lint) return OK;
      if (cmd === "git rev-parse HEAD") {
        return { code: 0, stdout: "0123456789abcdef0123456789abcdef01234567\n", stderr: "" };
      }
      if (cmd === "git rev-parse --abbrev-ref HEAD") {
        return { code: 0, stdout: `${opts.currentBranch ?? "issue-143"}\n`, stderr: "" };
      }
      if (cmd === "git status --porcelain") {
        return { code: 0, stdout: opts.dirty ? " M app/foo.ts\n" : "", stderr: "" };
      }
      if (cmd.startsWith("gh pr create")) return { code: 0, stdout: "https://pr/1\n", stderr: "" };
      return OK;
    },
    agent: async (agent: string, prompt: string) => {
      agentCalls.push({ agent, prompt });
      if (prompt.includes("GitHub PR 本文")) return PR_BODY;
      if (prompt.includes("コミットメッセージ")) return COMMIT_MESSAGE;
      if (prompt.includes("現行の実装計画")) return DESIGN(opts.complexity, 2);
      if (prompt.includes("complexity の判断基準")) return DESIGN(opts.complexity, undefined, opts.screenshots);
      if (prompt.includes("指摘せよ")) return reviews.shift() ?? "[]";
      if (prompt.includes('"remaining"')) return reviews.shift() ?? '{"fixed": [], "remaining": []}';
      return "";
    },
    github: {
      fetchIssue: async () => ({ number: 143, title: "直す", body: "本文" }),
      createPr: async (_cwd: string, args: { title: string; body: string; base: string }) => {
        createdPrArgs.push(args);
        return "https://pr/1";
      },
    },
    projectRoot: "/repo",
    log: () => {},
    writeFile: async (path: string, content: string) => {
      written.push({ path, content });
      fileStore[path] = content;
    },
    readFile: async (path: string) => {
      if (fileStore[path] !== undefined) return fileStore[path];
      if (path.endsWith("my-design.md")) return DESIGN(opts.complexity);
      throw new Error(`ENOENT: ${path}`);
    },
    readdir: async (dir: string) => {
      if (dir === "/wt/issue-143/docs/plans" && opts.existingDesignDoc) return [opts.existingDesignDoc.split("/").pop()!];
      return [];
    },
    unlink: async (path: string) => {
      delete fileStore[path];
    },
    date: "2026-07-19",
  };
  return { deps: deps as never, agentCalls, execCalls, commitMessages, createdPrArgs, written, fileStore };
}

describe("runPipeline", () => {
  test("simple: composer が実装し、ゲート素通りで PR まで到達する", async () => {
    const h = makeHarness({ complexity: "simple" });
    const result = await runPipeline(h.deps, 143);
    expect(result.prUrl).toBe("https://pr/1");
    const implementCall = h.agentCalls[1]!;
    expect(implementCall.agent).toBe("composer");
    expect(h.execCalls).toContain("run-lint");
    expect(h.execCalls).toContain("git fetch origin main");
    expect(h.execCalls).toContain('git worktree add "/wt/issue-143" -b issue-143 origin/main');
    expect(h.execCalls.some((c) => c.startsWith("git push"))).toBe(true);
    expect(h.commitMessages[0]).toContain("feat: 回答状態の判定を安全化");
    expect(h.commitMessages[0]).toContain("関連: #143");
    expect(h.createdPrArgs[0]).toEqual({
      title: "feat: 回答状態の判定を安全化",
      body: PR_BODY,
      base: "main",
    });
  });

  test("lint 失敗は composer が修正する", async () => {
    const h = makeHarness({
      complexity: "complex",
      gateFailures: [{ cmd: "run-lint", stdout: "app/a.ts:1 x", times: 1 }],
    });
    await runPipeline(h.deps, 143);
    const fixCall = h.agentCalls.find((c) => c.prompt.includes("lint/型エラー"));
    expect(fixCall!.agent).toBe("composer");
  });

  test("test 失敗は complex でも composer が修正し、直らなければ codexSol へ昇格する", async () => {
    const h = makeHarness({
      complexity: "complex",
      gateFailures: [{ cmd: "run-test", stdout: "1 fail", times: 2 }],
    });
    await runPipeline(h.deps, 143);
    const fixCalls = h.agentCalls.filter((c) => c.prompt.includes("テスト失敗"));
    expect(fixCalls.map((c) => c.agent)).toEqual(["composer", "codexSol"]);
  });

  test("ゲート修正 3 回で直らなければ LoopExceededError", async () => {
    const h = makeHarness({
      complexity: "simple",
      gateFailures: [{ cmd: "run-lint", stdout: "app/a.ts:1 x", times: 99 }],
    });
    expect(runPipeline(h.deps, 143)).rejects.toThrow(LoopExceededError);
  });

  test("レビュー指摘は設計書への機械的追記経由で実装担当が直す", async () => {
    const h = makeHarness({
      complexity: "simple",
      reviewOutputs: [findingsOf(1), '{"fixed": ["R1-1"], "remaining": []}'],
    });
    await runPipeline(h.deps, 143);
    expect(h.agentCalls.some((c) => c.prompt.includes("指摘リストを修正"))).toBe(false);
    expect(h.agentCalls.some((c) => c.prompt.includes("現行の実装計画"))).toBe(false);
    const revisedDesign = h.written.find((w) => w.path.endsWith("docs/plans/2026-07-19-issue-143.md") && w.content.includes("R1-1"));
    expect(revisedDesign?.content).toContain("revision: 2");
    const implementCall = h.agentCalls.find((c) => c.prompt.includes("更新された実装計画"));
    expect(implementCall!.agent).toBe("composer");
  });

  test("レビュー反映は complex でも composer 開始、生き残った指摘は codexSol が反映する", async () => {
    const h = makeHarness({
      complexity: "complex",
      reviewOutputs: [findingsOf(2), followupOf(1), followupOf(0)],
    });
    await runPipeline(h.deps, 143);
    const revisions = h.agentCalls.filter((c) => c.prompt.includes("更新された実装計画"));
    expect(revisions.map((c) => c.agent)).toEqual(["composer", "codexSol"]);
  });

  test("設計書に screenshots があれば composer が撮影し PR 本文に追記する", async () => {
    const h = makeHarness({
      complexity: "simple",
      screenshots: ["/settings"],
      uiScreenshot: {
        serve: "bun run dev",
        baseUrl: "http://localhost:5173",
        r2Bucket: "shots",
        r2PublicBaseUrl: "https://pub-x.r2.dev",
      },
    });
    await runPipeline(h.deps, 143);
    expect(h.agentCalls.some((c) => c.agent === "composer" && c.prompt.includes("agent-browser"))).toBe(true);
    expect(h.execCalls.some((c) => c.includes("wrangler r2 object put"))).toBe(true);
    const body = h.createdPrArgs[0]!.body;
    expect(body).toContain("## スクリーンショット");
    expect(body).toContain("https://pub-x.r2.dev/");
  });

  test("uiScreenshot 設定なしでも既定値で撮影し PR 本文に追記する", async () => {
    const h = makeHarness({ complexity: "simple", screenshots: ["/"] });
    await runPipeline(h.deps, 143);
    expect(h.execCalls.some((c) => c.includes("nohup bun run dev"))).toBe(true);
    const body = h.createdPrArgs[0]!.body;
    expect(body).toContain("## スクリーンショット");
    expect(body).toContain(".r2.dev/");
  });

  test("lintable blocking 指摘は設計ループを bypass する", async () => {
    const lintableFinding = JSON.stringify([
      { file: "app/a.ts", line: 1, severity: "high", message: "規約違反", lintable: true },
    ]);
    const h = makeHarness({
      complexity: "simple",
      reviewOutputs: [lintableFinding, '{"fixed": ["R1-1"], "remaining": []}'],
    });
    await runPipeline(h.deps, 143);
    expect(h.agentCalls.some((c) => c.prompt.includes("現行の実装計画"))).toBe(false);
    expect(h.agentCalls.some((c) => c.agent === "composer" && c.prompt.includes("静的解析可能"))).toBe(true);
  });

  test("lint 自動修正後にゲートが通れば composer を呼ばない", async () => {
    const h = makeHarness({
      complexity: "simple",
      autoFixCommands: { lint: "run-lint-fix" },
      gateFailures: [{ cmd: "run-lint", stdout: "app/a.ts:1 x", times: 1 }],
    });
    await runPipeline(h.deps, 143);
    expect(h.execCalls).toContain("run-lint-fix");
    expect(h.agentCalls.some((c) => c.prompt.includes("lint/型エラー"))).toBe(false);
  });

  test("指摘件数が減らなくなったら LoopExceededError（停滞検知）", async () => {
    const h = makeHarness({ complexity: "simple", reviewOutputs: [findingsOf(1), followupOf(1)] });
    expect(runPipeline(h.deps, 143)).rejects.toThrow("減っていません");
  });

  test("件数が減り続けている限りレビューループは 2 周を超えて継続する", async () => {
    const h = makeHarness({
      complexity: "simple",
      reviewOutputs: [findingsOf(3), followupOf(2), followupOf(1), followupOf(0)],
    });
    const result = await runPipeline(h.deps, 143);
    expect(result.prUrl).toBe("https://pr/1");
    const implementations = h.agentCalls.filter((c) => c.prompt.includes("更新された実装計画"));
    expect(implementations).toHaveLength(3);
    expect(h.agentCalls.some((c) => c.prompt.includes("現行の実装計画"))).toBe(false);
  });

  test("減り続けてもラウンド上限で LoopExceededError", async () => {
    const h = makeHarness({
      complexity: "simple",
      reviewOutputs: [findingsOf(5), followupOf(4), followupOf(3), followupOf(2)],
    });
    expect(runPipeline(h.deps, 143)).rejects.toThrow("ラウンド上限");
  });

  test("--design 指定時は issue からの設計 claude 呼び出しを省略する", async () => {
    const h = makeHarness({ complexity: "simple" });
    const result = await runPipeline(h.deps, 143, { designDocPath: "/home/user/my-design.md" });
    expect(result.prUrl).toBe("https://pr/1");
    const designCalls = h.agentCalls.filter((c) => c.prompt.includes("complexity の判断基準"));
    expect(designCalls).toHaveLength(0);
    const design = h.written.find((w) => w.path.includes("docs/plans/2026-07-19-issue-143.md"));
    expect(design!.content).toContain("complexity: simple");
  });

  test("resume: worktree に設計書があれば issue からの設計をスキップする", async () => {
    const h = makeHarness({
      complexity: "simple",
      worktreeExists: true,
      existingDesignDoc: "docs/plans/2026-07-18-issue-143.md",
    });
    await runPipeline(h.deps, 143);
    const designCalls = h.agentCalls.filter((c) => c.prompt.includes("complexity の判断基準"));
    expect(designCalls).toHaveLength(0);
    const implementCall = h.agentCalls.find((c) => c.agent === "composer" && c.prompt.includes("実装計画"));
    expect(implementCall).toBeDefined();
  });

  test("resume: 実装済みなら品質ゲートから再開する", async () => {
    const h = makeHarness({
      complexity: "simple",
      worktreeExists: true,
      existingDesignDoc: "docs/plans/2026-07-18-issue-143.md",
      pipelineState: JSON.stringify({
        issue: 143,
        design: { docPath: "docs/plans/2026-07-18-issue-143.md", complexity: "simple" },
        implement: true,
      }),
    });
    await runPipeline(h.deps, 143);
    const implementCalls = h.agentCalls.filter((c) => c.prompt.includes("実装計画に従って実装"));
    expect(implementCalls).toHaveLength(0);
    expect(h.execCalls).toContain("run-lint");
  });

  test("state は worktree の外に書く（git add -A で PR に混入させない）", async () => {
    const h = makeHarness({ complexity: "simple" });
    await runPipeline(h.deps, 143);
    expect(h.written.some((w) => w.path.startsWith("/wt/issue-143/") && w.path.endsWith(".pipeline-state.json"))).toBe(
      false,
    );
    expect(h.fileStore["/wt/.pipeline-state-issue-143.json"]).toBeDefined();
  });

  test("worktree 内に残る旧 state を引き継いだ上で削除する", async () => {
    const h = makeHarness({
      complexity: "simple",
      worktreeExists: true,
      existingDesignDoc: "docs/plans/2026-07-18-issue-143.md",
    });
    h.fileStore["/wt/issue-143/.pipeline-state.json"] = JSON.stringify({
      issue: 143,
      design: { docPath: "docs/plans/2026-07-18-issue-143.md", complexity: "simple" },
      implement: true,
    });
    await runPipeline(h.deps, 143);
    expect(h.fileStore["/wt/issue-143/.pipeline-state.json"]).toBeUndefined();
    const implementCalls = h.agentCalls.filter((c) => c.prompt.includes("実装計画に従って実装"));
    expect(implementCalls).toHaveLength(0);
  });

  test("resume: 反映済み（applied）の指摘は再修正せず消し込みレビューから再開する", async () => {
    const outstanding = [
      { id: "R1-1", file: "app/a.ts", line: 1, severity: "high", message: "直せ", lintable: false },
    ];
    const h = makeHarness({
      complexity: "simple",
      worktreeExists: true,
      existingDesignDoc: "docs/plans/2026-07-18-issue-143.md",
      reviewOutputs: ['{"fixed": ["R1-1"], "remaining": []}'],
      pipelineState: JSON.stringify({
        issue: 143,
        design: { docPath: "docs/plans/2026-07-18-issue-143.md", complexity: "simple" },
        implement: true,
        initialCommit: true,
        review: { round: 1, outstanding, phase: "applied" },
      }),
    });
    await runPipeline(h.deps, 143);
    expect(h.agentCalls.some((c) => c.prompt.includes("現行の実装計画"))).toBe(false);
    expect(h.agentCalls.some((c) => c.prompt.includes('"remaining"'))).toBe(true);
  });

  test("resume: 未反映（pending）の指摘は設計追記と実装からやり直す", async () => {
    const outstanding = [
      { id: "R1-1", file: "app/a.ts", line: 1, severity: "high", message: "直せ", lintable: false },
    ];
    const h = makeHarness({
      complexity: "simple",
      worktreeExists: true,
      existingDesignDoc: "docs/plans/2026-07-18-issue-143.md",
      reviewOutputs: ['{"fixed": ["R1-1"], "remaining": []}'],
      pipelineState: JSON.stringify({
        issue: 143,
        design: { docPath: "docs/plans/2026-07-18-issue-143.md", complexity: "simple" },
        implement: true,
        initialCommit: true,
        review: { round: 1, outstanding, phase: "pending" },
      }),
    });
    await runPipeline(h.deps, 143);
    expect(h.agentCalls.some((c) => c.prompt.includes("更新された実装計画"))).toBe(true);
    expect(h.agentCalls.some((c) => c.prompt.includes("現行の実装計画"))).toBe(false);
  });

  test("fresh: 設計書があっても issue から設計し直す", async () => {
    const h = makeHarness({
      complexity: "simple",
      worktreeExists: true,
      existingDesignDoc: "docs/plans/2026-07-18-issue-143.md",
    });
    await runPipeline(h.deps, 143, { mode: "fresh" });
    const designCalls = h.agentCalls.filter((c) => c.prompt.includes("complexity の判断基準"));
    expect(designCalls).toHaveLength(1);
  });

  test("low のみの指摘は修正ループを回さず PR まで進み、レポートに残る", async () => {
    const h = makeHarness({ complexity: "simple", reviewOutputs: [findingsOf(2, "low")] });
    const result = await runPipeline(h.deps, 143);
    expect(result.prUrl).toBe("https://pr/1");
    expect(h.agentCalls.some((c) => c.prompt.includes("現行の実装計画"))).toBe(false);
    const report = h.written.find((w) => w.path.includes("docs/runs/issue-143.md"));
    expect(report!.content).toContain("未対応の low 指摘");
  });

  test("lintable な指摘はレポートの lint 化候補に載る", async () => {
    const finding = JSON.stringify([
      { file: "app/a.ts", line: 1, severity: "low", message: "規約違反 X", lintable: true },
    ]);
    const h = makeHarness({ complexity: "simple", reviewOutputs: [finding, "[]"] });
    await runPipeline(h.deps, 143);
    const report = h.written.find((w) => w.path.includes("docs/runs/issue-143.md"));
    expect(report!.content).toContain("custom lint 化候補");
    expect(report!.content).toContain("app/a.ts: 規約違反 X");
  });

  test("コミット失敗は throw する", async () => {
    const h = makeHarness({ complexity: "simple" });
    const deps = h.deps as { exec: (cmd: string) => Promise<ExecResult> };
    const orig = deps.exec;
    deps.exec = async (cmd: string) =>
      cmd.startsWith("git add") ? { code: 1, stdout: "", stderr: "identity 未設定" } : orig(cmd);
    expect(runPipeline(h.deps, 143)).rejects.toThrow("コミットに失敗");
  });

  test("ループ上限で中断してもレポートと state が書かれる", async () => {
    const h = makeHarness({
      complexity: "simple",
      gateFailures: [{ cmd: "run-lint", stdout: "app/a.ts:1 x", times: 99 }],
    });
    let err: unknown;
    try {
      await runPipeline(h.deps, 143);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(LoopExceededError);
    expect((err as Error).message).toContain("/wt/issue-143");
    const report = h.written.find((w) => w.path.includes("docs/runs/issue-143.md"));
    expect(report!.content).toContain("中断");
  });

  test("既存 worktree があれば再利用して add しない", async () => {
    const h = makeHarness({ complexity: "simple", worktreeExists: true });
    await runPipeline(h.deps, 143);
    expect(h.execCalls.some((c) => c.startsWith("git worktree add"))).toBe(false);
  });

  test("レビュー修正後に品質ゲートを再実行し、壊れていたら composer が直す", async () => {
    const h = makeHarness({ complexity: "complex", reviewOutputs: [findingsOf(1), followupOf(0)] });
    const deps = h.deps as { exec: (cmd: string) => Promise<ExecResult> };
    const orig = deps.exec;
    let lintCalls = 0;
    deps.exec = async (cmd: string) => {
      if (cmd === "run-lint" && ++lintCalls === 2) return { code: 1, stdout: "app/b.ts:1 broken", stderr: "" };
      return orig(cmd);
    };
    await runPipeline(h.deps, 143);
    const lintFixes = h.agentCalls.filter((c) => c.agent === "composer" && c.prompt.includes("lint/型エラー"));
    expect(lintFixes).toHaveLength(1);
    expect(lintCalls).toBeGreaterThanOrEqual(3);
  });

  test("branch だけ残っている場合は -b なしの add にフォールバックする", async () => {
    const h = makeHarness({
      complexity: "simple",
      gateFailures: [
        { cmd: 'git worktree add "/wt/issue-143" -b issue-143 origin/main', stdout: "branch exists", times: 1 },
      ],
    });
    await runPipeline(h.deps, 143);
    expect(h.execCalls).toContain('git worktree add "/wt/issue-143" issue-143');
  });
});

describe("runPipeline --worktree（既存 worktree で作業）", () => {
  test("worktree を作成せず指定パスで作業し、現在ブランチを push する", async () => {
    const h = makeHarness({ complexity: "simple", currentBranch: "performance-api" });
    const result = await runPipeline(h.deps, 220, { worktreePath: "/custom/wt" });
    expect(result.prUrl).toBe("https://pr/1");
    expect(h.execCalls.some((c) => c.startsWith("git worktree add"))).toBe(false);
    expect(h.execCalls.some((c) => c.startsWith("test -d"))).toBe(false);
    expect(h.execCalls).toContain("git push -u origin performance-api");
  });

  test("ブランチが baseBranch のままなら拒否する", async () => {
    const h = makeHarness({ complexity: "simple", currentBranch: "main" });
    expect(runPipeline(h.deps, 220, { worktreePath: "/custom/wt" })).rejects.toThrow("baseBranch");
  });

  test("未コミットの変更があれば拒否する", async () => {
    const h = makeHarness({ complexity: "simple", currentBranch: "performance-api", dirty: true });
    expect(runPipeline(h.deps, 220, { worktreePath: "/custom/wt" })).rejects.toThrow("未コミット");
  });

  test("state ファイルは既定 worktree の実行と分離される", async () => {
    const h = makeHarness({ complexity: "simple", currentBranch: "performance-api" });
    await runPipeline(h.deps, 220, { worktreePath: "/custom/wt" });
    expect(h.written.some((w) => w.path === "/wt/.pipeline-state-issue-220--wt.json")).toBe(true);
    expect(h.written.some((w) => w.path === pipelineStatePath(CONFIG.worktreeRoot, 220))).toBe(false);
  });
});
