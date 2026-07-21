import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Exec, ExecOpts } from "./exec";
import { makeGithub } from "./github";

function fakeExec(result: { code: number; stdout: string; stderr?: string }) {
  const calls: { cmd: string; opts: ExecOpts }[] = [];
  const exec: Exec = async (cmd, opts = {}) => {
    calls.push({ cmd, opts });
    return { code: result.code, stdout: result.stdout, stderr: result.stderr ?? "" };
  };
  return { exec, calls };
}

describe("fetchIssue", () => {
  test("gh issue view の JSON をパースする", async () => {
    const issue = { number: 143, title: "N+1 を直す", body: "詳細" };
    const { exec, calls } = fakeExec({ code: 0, stdout: JSON.stringify(issue) });
    const gh = makeGithub(exec);
    expect(await gh.fetchIssue("/repo", 143)).toEqual(issue);
    expect(calls[0]!.cmd).toBe("gh issue view 143 --json number,title,body");
    expect(calls[0]!.opts.cwd).toBe("/repo");
  });

  test("gh 失敗時は throw する", async () => {
    const { exec } = fakeExec({ code: 1, stdout: "", stderr: "not found" });
    expect(makeGithub(exec).fetchIssue("/repo", 999)).rejects.toThrow("#999");
  });
});

describe("listOpenPrs", () => {
  test("open PR の一覧を返し、author は login 文字列に正規化する", async () => {
    const raw = [
      { number: 193, headRefName: "issue-153", baseRefName: "main", mergeable: "MERGEABLE", author: { login: "koki" } },
    ];
    const { exec, calls } = fakeExec({ code: 0, stdout: JSON.stringify(raw) });
    expect(await makeGithub(exec).listOpenPrs("/repo")).toEqual([
      { number: 193, headRefName: "issue-153", baseRefName: "main", mergeable: "MERGEABLE", author: "koki" },
    ]);
    expect(calls[0]!.cmd).toContain("gh pr list");
    expect(calls[0]!.cmd).toContain("author");
  });
});

describe("getPr", () => {
  test("単一 PR のサマリを返し、author を正規化する", async () => {
    const raw = { number: 193, headRefName: "issue-153", baseRefName: "main", mergeable: "CONFLICTING", author: { login: "koki" } };
    const { exec, calls } = fakeExec({ code: 0, stdout: JSON.stringify(raw) });
    expect(await makeGithub(exec).getPr("/repo", 193)).toEqual({
      number: 193,
      headRefName: "issue-153",
      baseRefName: "main",
      mergeable: "CONFLICTING",
      author: "koki",
    });
    expect(calls[0]!.cmd).toBe("gh pr view 193 --json number,headRefName,baseRefName,mergeable,author");
  });
});

describe("getPrComments", () => {
  test("issue コメント・レビュー本文・インラインコメントを統合する", async () => {
    const exec: Exec = async (cmd) => {
      if (cmd.includes("gh pr view")) {
        return {
          code: 0,
          stdout: JSON.stringify({
            comments: [
              { author: { login: "koki" }, authorAssociation: "OWNER", body: "全体コメント", createdAt: "2026-07-20T10:00:00Z" },
            ],
            reviews: [
              { author: { login: "koki" }, authorAssociation: "MEMBER", body: "レビュー本文", submittedAt: "2026-07-20T11:00:00Z" },
              { author: { login: "koki" }, authorAssociation: "MEMBER", body: "", submittedAt: "2026-07-20T11:30:00Z" },
            ],
          }),
          stderr: "",
        };
      }
      if (cmd.includes("/pulls/193/comments")) {
        return {
          code: 0,
          stdout: JSON.stringify([
            {
              user: { login: "koki" },
              author_association: "COLLABORATOR",
              body: "行コメント",
              path: "a.ts",
              created_at: "2026-07-20T12:00:00Z",
            },
          ]),
          stderr: "",
        };
      }
      return { code: 1, stdout: "", stderr: "unexpected" };
    };
    const cs = await makeGithub(exec).getPrComments("/repo", 193);
    expect(cs.map((c) => c.body)).toEqual(["全体コメント", "レビュー本文", "行コメント"]);
    expect(cs[0]!.authorAssociation).toBe("OWNER");
    expect(cs[2]).toMatchObject({ path: "a.ts", author: "koki", authorAssociation: "COLLABORATOR", createdAt: "2026-07-20T12:00:00Z" });
  });
});

describe("createPr", () => {
  test("タイトルと本文をファイル経由で渡し PR URL を返す", async () => {
    const { exec, calls } = fakeExec({ code: 0, stdout: "https://github.com/x/y/pull/12\n" });
    const gh = makeGithub(exec);
    const url = await gh.createPr("/repo", { title: "t", body: "b", base: "main" });
    expect(url).toBe("https://github.com/x/y/pull/12");
    expect(calls[0]!.cmd).toContain("--base main");
    expect(calls[0]!.opts.env!.PR_TITLE).toBe("t");
    expect(readFileSync(calls[0]!.opts.env!.PR_BODY_FILE!, "utf8")).toBe("b");
  });
});

describe("getPrFailedChecks", () => {
  test("失敗した statusCheckRollup だけ返す", async () => {
    const { exec, calls } = fakeExec({
      code: 0,
      stdout: JSON.stringify({
        statusCheckRollup: [
          { __typename: "CheckRun", name: "ok", conclusion: "SUCCESS", detailsUrl: null },
          {
            __typename: "CheckRun",
            name: "test-typescript",
            conclusion: "FAILURE",
            detailsUrl: "https://github.com/x/y/actions/runs/42/job/1",
          },
        ],
      }),
    });
    const gh = makeGithub(exec);
    expect(await gh.getPrFailedChecks("/repo", 33)).toEqual([
      {
        __typename: "CheckRun",
        name: "test-typescript",
        conclusion: "FAILURE",
        detailsUrl: "https://github.com/x/y/actions/runs/42/job/1",
      },
    ]);
    expect(calls[0]!.cmd).toBe("gh pr view 33 --json statusCheckRollup");
  });
});

describe("getWorkflowRunFailedLog", () => {
  test("gh run view --log-failed の出力を返す", async () => {
    const { exec, calls } = fakeExec({ code: 0, stdout: "error: lint failed\n", stderr: "" });
    const gh = makeGithub(exec);
    expect(await gh.getWorkflowRunFailedLog("/repo", 42)).toBe("error: lint failed");
    expect(calls[0]!.cmd).toBe("gh run view 42 --log-failed");
  });
});
