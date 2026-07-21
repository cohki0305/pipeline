import { describe, expect, test } from "bun:test";
import type { PipelineConfig } from "../config";
import type { Exec } from "../exec";
import { parseViolations, runAutoFixLint, runQualityGate } from "./quality-gate";

const CONFIG = {
  commands: { lint: "run-lint", typecheck: "run-tc", test: "run-test" },
  designDocDir: "d",
  reportDir: "r",
  baseBranch: "main",
  worktreeRoot: "/wt",
} satisfies PipelineConfig;

function execFor(failures: Record<string, string>): Exec {
  return async (cmd) => {
    const out = failures[cmd];
    return out === undefined ? { code: 0, stdout: "", stderr: "" } : { code: 1, stdout: out, stderr: "" };
  };
}

describe("parseViolations", () => {
  test("file:line 形式（既存 lint 規約）を拾う", () => {
    const v = parseViolations("lint", "違反: app/routes/x.tsx:12 raw palette 使用");
    expect(v).toEqual([{ file: "app/routes/x.tsx", line: 12, rule: "lint", message: "違反: app/routes/x.tsx:12 raw palette 使用" }]);
  });

  test("tsc の file(line,col) 形式も拾う", () => {
    const v = parseViolations("typecheck", "app/x.ts(5,3): error TS2322: 型が違う");
    expect(v[0]).toMatchObject({ file: "app/x.ts", line: 5 });
  });

  test("どの形式でもなければ末尾を丸ごと 1 件にする", () => {
    const v = parseViolations("test", "3 tests failed");
    expect(v).toHaveLength(1);
    expect(v[0]!.message).toContain("3 tests failed");
  });
});

describe("runQualityGate", () => {
  test("全部通れば ok", async () => {
    const r = await runQualityGate({ exec: execFor({}), cwd: "/w", config: CONFIG });
    expect(r.ok).toBe(true);
  });

  test("lint 失敗は kind lint で返し、後続を実行しない", async () => {
    const r = await runQualityGate({ exec: execFor({ "run-lint": "app/a.ts:1 x" }), cwd: "/w", config: CONFIG });
    expect(r).toMatchObject({ ok: false, kind: "lint" });
    expect(r.violations[0]!.file).toBe("app/a.ts");
  });

  test("typecheck 失敗も kind lint（機械的修正の対象）", async () => {
    const r = await runQualityGate({ exec: execFor({ "run-tc": "app/b.ts(2,1): error" }), cwd: "/w", config: CONFIG });
    expect(r).toMatchObject({ ok: false, kind: "lint" });
  });

  test("test 失敗は kind test（実装担当に差し戻す対象）", async () => {
    const r = await runQualityGate({ exec: execFor({ "run-test": "1 fail" }), cwd: "/w", config: CONFIG });
    expect(r).toMatchObject({ ok: false, kind: "test" });
  });
});

describe("runAutoFixLint", () => {
  test("autoFixCommands.lint が成功すれば true", async () => {
    const ok = await runAutoFixLint({
      exec: async (cmd) => ({ code: cmd === "run-lint-fix" ? 0 : 1, stdout: "", stderr: "" }),
      cwd: "/w",
      config: { ...CONFIG, autoFixCommands: { lint: "run-lint-fix" } },
    });
    expect(ok).toBe(true);
  });

  test("未設定なら false", async () => {
    const ok = await runAutoFixLint({
      exec: async () => ({ code: 0, stdout: "", stderr: "" }),
      cwd: "/w",
      config: CONFIG,
    });
    expect(ok).toBe(false);
  });
});

describe("runQualityGate incremental", () => {
  test("増分コマンドへ変更ファイルを環境変数で渡し、未設定項目はフルコマンドへ戻る", async () => {
    const calls: { cmd: string; files?: string }[] = [];
    const result = await runQualityGate({
      exec: async (cmd, opts) => {
        calls.push({ cmd, files: opts?.env?.PIPELINE_CHANGED_FILES });
        return { code: 0, stdout: "", stderr: "" };
      },
      cwd: "/w",
      config: { ...CONFIG, incrementalCommands: { lint: "lint-changed", test: "test-changed" } },
      scope: "incremental",
      changedFiles: ["src/a.ts", "src/b.ts"],
    });
    expect(result.ok).toBe(true);
    expect(calls.map((call) => call.cmd)).toEqual(["lint-changed", "run-tc", "test-changed"]);
    expect(calls[0]!.files).toBe("src/a.ts\nsrc/b.ts");
  });
});
