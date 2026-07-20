import { describe, expect, test } from "bun:test";
import type { PipelineConfig } from "./config";
import type { ExecResult } from "./exec";
import { LoopExceededError, runPipeline } from "./run";

const CONFIG = {
  commands: { lint: "run-lint", typecheck: "run-tc", test: "run-test" },
  designDocDir: "docs/plans",
  reportDir: "docs/runs",
  baseBranch: "main",
  worktreeRoot: "/wt",
} satisfies PipelineConfig;

const DESIGN = (c: "simple" | "complex") => `---\ncomplexity: ${c}\n---\n# 計画`;
const OK: ExecResult = { code: 0, stdout: "", stderr: "" };

const findingsOf = (n: number, severity = "high") =>
  JSON.stringify(
    Array.from({ length: n }, (_, i) => ({ file: `app/f${i}.ts`, line: 1, severity, message: `指摘 ${i}`, lintable: false })),
  );
// 2 巡目以降の消し込みレビューの応答
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

type Harness = ReturnType<typeof makeHarness>;

function makeHarness(opts: {
  complexity: "simple" | "complex";
  reviewOutputs?: string[];
  gateFailures?: { cmd: string; stdout: string; times: number }[];
  worktreeExists?: boolean;
}) {
  const agentCalls: { agent: string; prompt: string }[] = [];
  const execCalls: string[] = [];
  const written: { path: string; content: string }[] = [];
  const reviews = [...(opts.reviewOutputs ?? ["[]"])];
  const failures = (opts.gateFailures ?? []).map((f) => ({ ...f }));

  const deps = {
    config: CONFIG,
    exec: async (cmd: string): Promise<ExecResult> => {
      execCalls.push(cmd);
      if (cmd.startsWith("test -d")) return { code: opts.worktreeExists ? 0 : 1, stdout: "", stderr: "" };
      const f = failures.find((f) => cmd === f.cmd && f.times > 0);
      if (f) {
        f.times--;
        return { code: 1, stdout: f.stdout, stderr: "" };
      }
      if (cmd.startsWith("gh pr create")) return { code: 0, stdout: "https://pr/1\n", stderr: "" };
      return OK;
    },
    agent: async (agent: string, prompt: string) => {
      agentCalls.push({ agent, prompt });
      if (agent !== "claude") return "";
      // 設計プロンプトだけが complexity という語を含む
      if (prompt.includes("complexity")) return DESIGN(opts.complexity);
      return reviews.shift() ?? "[]";
    },
    github: {
      fetchIssue: async () => ({ number: 143, title: "直す", body: "本文" }),
      createPr: async () => "https://pr/1",
    },
    projectRoot: "/repo",
    log: () => {},
    writeFile: async (path: string, content: string) => {
      written.push({ path, content });
    },
    readFile: async () => DESIGN(opts.complexity),
    date: "2026-07-19",
  };
  return { deps: deps as never, agentCalls, execCalls, written };
}

describe("runPipeline", () => {
  test("simple: composer が実装し、ゲート素通りで PR まで到達する", async () => {
    const h = makeHarness({ complexity: "simple" });
    const result = await runPipeline(h.deps, 143);
    expect(result.prUrl).toBe("https://pr/1");
    const implementCall = h.agentCalls[1]!;
    expect(implementCall.agent).toBe("composer");
    expect(h.execCalls).toContain("run-lint");
    // ローカル main の鮮度に依存しないよう、fetch した origin/<base> を基準に worktree を切る
    expect(h.execCalls).toContain("git fetch origin main");
    expect(h.execCalls).toContain('git worktree add "/wt/issue-143" -b issue-143 origin/main');
    expect(h.execCalls.some((c) => c.startsWith("git push"))).toBe(true);
  });

  test("lint 失敗は complex でも composer が修正する", async () => {
    const h = makeHarness({
      complexity: "complex",
      gateFailures: [{ cmd: "run-lint", stdout: "app/a.ts:1 x", times: 1 }],
    });
    await runPipeline(h.deps, 143);
    const fixCall = h.agentCalls.find((c) => c.prompt.includes("lint/型エラー"));
    expect(fixCall!.agent).toBe("composer");
  });

  test("test 失敗は実装担当（complex なら codexSol）が修正する", async () => {
    const h = makeHarness({
      complexity: "complex",
      gateFailures: [{ cmd: "run-test", stdout: "1 fail", times: 1 }],
    });
    await runPipeline(h.deps, 143);
    const fixCall = h.agentCalls.find((c) => c.prompt.includes("テスト失敗"));
    expect(fixCall!.agent).toBe("codexSol");
  });

  test("ゲート修正 3 回で直らなければ LoopExceededError", async () => {
    const h = makeHarness({
      complexity: "simple",
      gateFailures: [{ cmd: "run-lint", stdout: "app/a.ts:1 x", times: 99 }],
    });
    expect(runPipeline(h.deps, 143)).rejects.toThrow(LoopExceededError);
  });

  test("レビュー指摘は実装担当が直し、消し込みレビューがクリーンなら PR に進む", async () => {
    const h = makeHarness({
      complexity: "simple",
      reviewOutputs: [findingsOf(1), '{"fixed": ["R1-1"], "remaining": []}'],
    });
    await runPipeline(h.deps, 143);
    const fixCall = h.agentCalls.find((c) => c.prompt.includes("コードレビュー指摘"));
    expect(fixCall!.agent).toBe("composer");
    const claudeCalls = h.agentCalls.filter((c) => c.agent === "claude");
    const followupCall = claudeCalls[claudeCalls.length - 1]!;
    expect(followupCall.prompt).toContain("R1-1");
    expect(followupCall.prompt).toContain('"remaining"');
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
    const fixes = h.agentCalls.filter((c) => c.prompt.includes("コードレビュー指摘"));
    expect(fixes).toHaveLength(3);
  });

  test("減り続けてもラウンド上限で LoopExceededError", async () => {
    const h = makeHarness({
      complexity: "simple",
      reviewOutputs: [findingsOf(5), followupOf(4), followupOf(3), followupOf(2)],
    });
    expect(runPipeline(h.deps, 143)).rejects.toThrow("ラウンド上限");
  });

  test("--design 指定時は設計ステージの claude 呼び出しを省略する", async () => {
    const h = makeHarness({ complexity: "simple" });
    const result = await runPipeline(h.deps, 143, { designDocPath: "/home/user/my-design.md" });
    expect(result.prUrl).toBe("https://pr/1");
    const claudeCalls = h.agentCalls.filter((c) => c.agent === "claude");
    expect(claudeCalls).toHaveLength(1);
    expect(claudeCalls[0]!.prompt).not.toContain("complexity");
    const design = h.written.find((w) => w.path.includes("docs/plans/2026-07-19-issue-143.md"));
    expect(design!.content).toContain("complexity: simple");
  });

  test("low のみの指摘は修正ループを回さず PR まで進み、レポートに残る", async () => {
    const h = makeHarness({ complexity: "simple", reviewOutputs: [findingsOf(2, "low")] });
    const result = await runPipeline(h.deps, 143);
    expect(result.prUrl).toBe("https://pr/1");
    expect(h.agentCalls.some((c) => c.prompt.includes("コードレビュー指摘"))).toBe(false);
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

  test("ループ上限で中断してもレポートが書かれ、エラーに worktree パスが載る", async () => {
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
      // 2 回目の lint（= レビュー修正後の再ゲート）だけ失敗させる
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
