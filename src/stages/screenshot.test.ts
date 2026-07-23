import { describe, expect, test } from "bun:test";
import type { PipelineConfig } from "../config";
import type { ExecResult } from "../exec";
import {
  R2_DEFAULTS,
  appendScreenshotSection,
  buildScreenshotPrompt,
  resolveScreenshotConfig,
  runScreenshotStage,
  screenshotFileName,
} from "./screenshot";

const UI = {
  serve: "bun run dev",
  baseUrl: "http://localhost:5173",
  login: { path: "/login", email: "pipeline-test@example.com" },
  r2Bucket: "pipeline-screenshots",
  r2PublicBaseUrl: "https://pub-x.r2.dev",
};

const BASE_CONFIG = {
  commands: { lint: "l", typecheck: "tc", test: "t" },
  designDocDir: "docs/plans",
  reportDir: "docs/runs",
  baseBranch: "main",
  worktreeRoot: "/wt",
} satisfies PipelineConfig;

const CONFIG = { ...BASE_CONFIG, uiScreenshot: UI } satisfies PipelineConfig;

const OK: ExecResult = { code: 0, stdout: "", stderr: "" };

function makeDeps(opts: {
  config?: PipelineConfig;
  execResult?: (cmd: string) => ExecResult | undefined;
  agentError?: string;
}) {
  const execCalls: { cmd: string; env?: Record<string, string> }[] = [];
  const agentCalls: { agent: string; prompt: string }[] = [];
  const deps = {
    exec: async (cmd: string, execOpts?: { env?: Record<string, string> }): Promise<ExecResult> => {
      execCalls.push({ cmd, env: execOpts?.env });
      return opts.execResult?.(cmd) ?? OK;
    },
    agent: async (agent: string, prompt: string) => {
      agentCalls.push({ agent, prompt });
      if (opts.agentError) throw new Error(opts.agentError);
      return "";
    },
    config: opts.config ?? CONFIG,
    log: () => {},
    randomHex: () => "deadbeefdeadbeef",
  };
  return { deps, execCalls, agentCalls };
}

describe("resolveScreenshotConfig", () => {
  test("設定なしは既定値（serve は bun run dev、R2 は共通バケット）", () => {
    const cfg = resolveScreenshotConfig(BASE_CONFIG);
    expect(cfg.serve).toBe("bun run dev");
    expect(cfg.baseUrl).toBeUndefined();
    expect(cfg.login).toBeUndefined();
    expect(cfg.r2Bucket).toBe(R2_DEFAULTS.bucket);
    expect(cfg.r2PublicBaseUrl).toBe(R2_DEFAULTS.publicBaseUrl);
  });

  test("部分指定は指定項目だけ上書きする", () => {
    const cfg = resolveScreenshotConfig({ ...BASE_CONFIG, uiScreenshot: { serve: "npm run dev" } });
    expect(cfg.serve).toBe("npm run dev");
    expect(cfg.r2Bucket).toBe(R2_DEFAULTS.bucket);
  });
});

describe("screenshotFileName", () => {
  test("パスを slug 化し、ルートは root にする", () => {
    expect(screenshotFileName(143, 0, "/")).toBe("issue-143-1-root.png");
    expect(screenshotFileName(143, 1, "/settings/profile")).toBe("issue-143-2-settings-profile.png");
  });
});

describe("buildScreenshotPrompt", () => {
  const args = { pages: ["/"], files: ["issue-1-1-root.png"], outDir: "/out", serverLogPath: "/out/server.log" };

  test("baseUrl とログインのヒントがあればプロンプトに埋め込む", () => {
    const prompt = buildScreenshotPrompt(resolveScreenshotConfig(CONFIG), args);
    expect(prompt).toContain("http://localhost:5173 が HTTP 応答");
    expect(prompt).toContain("既知の情報");
    expect(prompt).toContain("pipeline-test@example.com");
    expect(prompt).toContain("マジックリンク");
    expect(prompt).toContain("agent-browser screenshot /out/issue-1-1-root.png");
  });

  test("設定なしは URL をサーバーログから、ログイン方法をリポジトリ調査で自力発見させる", () => {
    const prompt = buildScreenshotPrompt(resolveScreenshotConfig(BASE_CONFIG), args);
    expect(prompt).toContain("ローカル URL");
    expect(prompt).toContain("リポジトリを調査");
    expect(prompt).not.toContain("既知の情報");
  });
});

describe("appendScreenshotSection", () => {
  test("成功と失敗を本文末尾に追記する", () => {
    const body = appendScreenshotSection("Closes #1\n\n## 検証\nok\n", {
      shots: [{ page: "/settings", url: "https://pub-x.r2.dev/k/a.png" }],
      failures: ["/admin: スクリーンショットが生成されなかった"],
    });
    expect(body).toContain("## スクリーンショット");
    expect(body).toContain("![/settings](https://pub-x.r2.dev/k/a.png)");
    expect(body).toContain("撮影失敗: /admin");
  });
});

describe("runScreenshotStage", () => {
  test("対象ページが無ければ何もしない", async () => {
    const { deps, execCalls } = makeDeps({});
    expect(await runScreenshotStage(deps, { cwd: "/w", issueNumber: 1, pages: [] })).toEqual({
      shots: [],
      failures: [],
    });
    expect(execCalls).toHaveLength(0);
  });

  test("サーバー起動 → composer 撮影 → 停止 → R2 アップロードの順に実行する", async () => {
    const { deps, execCalls, agentCalls } = makeDeps({});
    const result = await runScreenshotStage(deps, { cwd: "/w", issueNumber: 143, pages: ["/", "/settings"] });
    expect(execCalls[0]!.cmd).toContain("nohup bun run dev");
    expect(agentCalls).toEqual([{ agent: "composer", prompt: expect.stringContaining("agent-browser") }]);
    expect(execCalls.some((c) => c.cmd.includes("kill"))).toBe(true);
    const uploads = execCalls.filter((c) => c.cmd.includes("wrangler r2 object put"));
    expect(uploads).toHaveLength(2);
    expect(uploads[0]!.cmd).toContain("--remote");
    expect(uploads[0]!.env?.R2_KEY).toBe("pipeline-screenshots/deadbeefdeadbeef/issue-143-1-root.png");
    expect(uploads[0]!.env?.CLOUDFLARE_ACCOUNT_ID).toBe(R2_DEFAULTS.accountId);
    expect(result.shots).toEqual([
      { page: "/", url: "https://pub-x.r2.dev/deadbeefdeadbeef/issue-143-1-root.png" },
      { page: "/settings", url: "https://pub-x.r2.dev/deadbeefdeadbeef/issue-143-2-settings.png" },
    ]);
    expect(result.failures).toEqual([]);
  });

  test("uiScreenshot 設定なしでも既定値で撮影・アップロードする", async () => {
    const { deps, execCalls } = makeDeps({ config: BASE_CONFIG });
    const result = await runScreenshotStage(deps, { cwd: "/w", issueNumber: 1, pages: ["/"] });
    expect(execCalls[0]!.cmd).toContain("nohup bun run dev");
    expect(result.shots[0]!.url).toBe(`${R2_DEFAULTS.publicBaseUrl}/deadbeefdeadbeef/issue-1-1-root.png`);
  });

  test("サーバー起動失敗は failures を返し composer を呼ばない", async () => {
    const { deps, agentCalls } = makeDeps({
      execResult: (cmd) => (cmd.includes("nohup") ? { code: 1, stdout: "", stderr: "boom" } : undefined),
    });
    const result = await runScreenshotStage(deps, { cwd: "/w", issueNumber: 1, pages: ["/"] });
    expect(result.failures[0]).toContain("起動に失敗");
    expect(agentCalls).toHaveLength(0);
  });

  test("composer が失敗してもサーバーは停止し、throw しない", async () => {
    const { deps, execCalls } = makeDeps({ agentError: "cli died" });
    const result = await runScreenshotStage(deps, { cwd: "/w", issueNumber: 1, pages: ["/"] });
    expect(result.failures.some((f) => f.includes("cli died"))).toBe(true);
    expect(execCalls.some((c) => c.cmd.includes("kill"))).toBe(true);
  });

  test("ファイル未生成とアップロード失敗はページ単位の failures になる", async () => {
    const { deps } = makeDeps({
      execResult: (cmd) => {
        if (cmd.startsWith("test -f")) return { code: 1, stdout: "", stderr: "" };
        return undefined;
      },
    });
    const result = await runScreenshotStage(deps, { cwd: "/w", issueNumber: 1, pages: ["/"] });
    expect(result.shots).toEqual([]);
    expect(result.failures[0]).toContain("生成されなかった");

    const upload = makeDeps({
      execResult: (cmd) => (cmd.includes("wrangler") ? { code: 1, stdout: "", stderr: "denied" } : undefined),
    });
    const uploadResult = await runScreenshotStage(upload.deps, { cwd: "/w", issueNumber: 1, pages: ["/"] });
    expect(uploadResult.shots).toEqual([]);
    expect(uploadResult.failures[0]).toContain("R2 アップロードに失敗");
  });
});
