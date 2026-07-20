import { describe, expect, test } from "bun:test";
import type { PipelineConfig } from "./config";
import type { ExecResult } from "./exec";
import type { PrComment, PrSummary } from "./github";
import { babysitPr, isNewComment, runBabysit } from "./babysit";

const CONFIG = {
  commands: { lint: "run-lint", typecheck: "run-tc", test: "run-test" },
  designDocDir: "d",
  reportDir: "r",
  baseBranch: "main",
  worktreeRoot: "/wt",
} satisfies PipelineConfig;
const OK: ExecResult = { code: 0, stdout: "", stderr: "" };

function makeDeps(opts: { prs?: PrSummary[]; comments?: PrComment[]; mergeFails?: boolean; lastCommit?: string }) {
  const agentCalls: { agent: string; prompt: string }[] = [];
  const execCalls: string[] = [];
  const deps = {
    config: CONFIG,
    exec: async (cmd: string): Promise<ExecResult> => {
      execCalls.push(cmd);
      if (cmd.startsWith("test -d")) return OK;
      if (cmd.startsWith("git log -1")) {
        return { code: 0, stdout: `${opts.lastCommit ?? "2026-07-20T09:00:00+09:00"}\n`, stderr: "" };
      }
      if (cmd.startsWith("git merge") && opts.mergeFails) return { code: 1, stdout: "CONFLICT", stderr: "" };
      return OK;
    },
    agent: async (agent: string, prompt: string) => {
      agentCalls.push({ agent, prompt });
      return "";
    },
    github: {
      fetchIssue: async () => {
        throw new Error("unused");
      },
      createPr: async () => "",
      listOpenPrs: async () => opts.prs ?? [],
      getPrComments: async () => opts.comments ?? [],
    },
    projectRoot: "/repo",
    log: () => {},
  };
  return { deps: deps as never, agentCalls, execCalls };
}

const PR: PrSummary = { number: 193, headRefName: "issue-153", baseRefName: "main", mergeable: "MERGEABLE" };

describe("isNewComment", () => {
  test("最終コミットより新しいコメントだけ拾う（タイムゾーン混在でも正しく比較）", () => {
    const last = "2026-07-20T09:00:00+09:00"; // = 2026-07-20T00:00:00Z
    expect(isNewComment({ author: "a", body: "x", path: null, createdAt: "2026-07-20T01:00:00Z" }, last)).toBe(true);
    expect(isNewComment({ author: "a", body: "x", path: null, createdAt: "2026-07-19T23:00:00Z" }, last)).toBe(false);
  });
});

describe("babysitPr", () => {
  test("コンフリクト PR は composer が解消して push する", async () => {
    const h = makeDeps({ mergeFails: true });
    const r = await babysitPr(h.deps, { ...PR, mergeable: "CONFLICTING" });
    expect(r.actions).toContain("conflict-resolved");
    const call = h.agentCalls.find((c) => c.prompt.includes("コンフリクト"));
    expect(call!.agent).toBe("composer");
    expect(h.execCalls.some((c) => c.startsWith("git push"))).toBe(true);
  });

  test("新規コメントに composer が対応して push する", async () => {
    const h = makeDeps({
      comments: [{ author: "koki", body: "命名直して", path: "a.ts", createdAt: "2026-07-20T05:00:00Z" }],
      lastCommit: "2026-07-20T09:00:00+09:00",
    });
    const r = await babysitPr(h.deps, PR);
    expect(r.actions).toEqual(["comments-addressed(1)"]);
    expect(h.agentCalls[0]!.agent).toBe("composer");
    expect(h.agentCalls[0]!.prompt).toContain("命名直して");
    expect(h.execCalls.some((c) => c.startsWith("git push"))).toBe(true);
  });

  test("古いコメントしかなければ何もしない", async () => {
    const h = makeDeps({ comments: [{ author: "koki", body: "既読", path: null, createdAt: "2026-07-19T00:00:00Z" }] });
    const r = await babysitPr(h.deps, PR);
    expect(r.actions).toEqual([]);
    expect(h.agentCalls).toHaveLength(0);
    expect(h.execCalls.some((c) => c.startsWith("git push"))).toBe(false);
  });
});

describe("runBabysit", () => {
  test("issue-* ブランチの PR だけを対象にする", async () => {
    const h = makeDeps({
      prs: [PR, { number: 200, headRefName: "feature-x", baseRefName: "main", mergeable: "MERGEABLE" }],
    });
    const results = await runBabysit(h.deps);
    expect(results.map((r) => r.number)).toEqual([193]);
  });
});
