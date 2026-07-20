import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Exec } from "./exec";

export type Issue = { number: number; title: string; body: string };
export type PrSummary = { number: number; headRefName: string; baseRefName: string; mergeable: string };
export type PrComment = { author: string; body: string; path: string | null; createdAt: string };

export type Github = {
  fetchIssue(cwd: string, num: number): Promise<Issue>;
  createPr(cwd: string, args: { title: string; body: string; base: string }): Promise<string>;
  listOpenPrs(cwd: string): Promise<PrSummary[]>;
  getPr(cwd: string, num: number): Promise<PrSummary>;
  getPrComments(cwd: string, num: number): Promise<PrComment[]>;
};

export function makeGithub(exec: Exec): Github {
  return {
    async fetchIssue(cwd, num) {
      const r = await exec(`gh issue view ${num} --json number,title,body`, { cwd });
      if (r.code !== 0) throw new Error(`issue #${num} を取得できません: ${r.stderr}`);
      return JSON.parse(r.stdout) as Issue;
    },
    async createPr(cwd, { title, body, base }) {
      const bodyFile = join(mkdtempSync(join(tmpdir(), "agent-pipeline-pr-")), "body.md");
      writeFileSync(bodyFile, body);
      const r = await exec(`gh pr create --title "$PR_TITLE" --body-file "$PR_BODY_FILE" --base ${base}`, {
        cwd,
        env: { PR_TITLE: title, PR_BODY_FILE: bodyFile },
      });
      if (r.code !== 0) throw new Error(`PR 作成に失敗: ${r.stderr}`);
      return r.stdout.trim().split("\n").pop() ?? "";
    },
    async listOpenPrs(cwd) {
      const r = await exec("gh pr list --state open --json number,headRefName,baseRefName,mergeable", { cwd });
      if (r.code !== 0) throw new Error(`PR 一覧の取得に失敗: ${r.stderr}`);
      return JSON.parse(r.stdout) as PrSummary[];
    },
    async getPr(cwd, num) {
      const r = await exec(`gh pr view ${num} --json number,headRefName,baseRefName,mergeable`, { cwd });
      if (r.code !== 0) throw new Error(`PR #${num} の取得に失敗: ${r.stderr}`);
      return JSON.parse(r.stdout) as PrSummary;
    },
    async getPrComments(cwd, num) {
      const view = await exec(`gh pr view ${num} --json comments,reviews`, { cwd });
      if (view.code !== 0) throw new Error(`PR #${num} のコメント取得に失敗: ${view.stderr}`);
      const data = JSON.parse(view.stdout) as {
        comments?: { author?: { login?: string }; body?: string; createdAt?: string }[];
        reviews?: { author?: { login?: string }; body?: string; submittedAt?: string }[];
      };
      const inline = await exec(`gh api "repos/{owner}/{repo}/pulls/${num}/comments"`, { cwd });
      if (inline.code !== 0) throw new Error(`PR #${num} のインラインコメント取得に失敗: ${inline.stderr}`);
      const inlineData = JSON.parse(inline.stdout) as {
        user?: { login?: string };
        body?: string;
        path?: string;
        created_at?: string;
      }[];
      return [
        ...(data.comments ?? []).map((c) => ({
          author: c.author?.login ?? "",
          body: c.body ?? "",
          path: null,
          createdAt: c.createdAt ?? "",
        })),
        ...(data.reviews ?? [])
          .filter((rv) => rv.body?.trim())
          .map((rv) => ({ author: rv.author?.login ?? "", body: rv.body ?? "", path: null, createdAt: rv.submittedAt ?? "" })),
        ...inlineData.map((c) => ({
          author: c.user?.login ?? "",
          body: c.body ?? "",
          path: c.path ?? null,
          createdAt: c.created_at ?? "",
        })),
      ];
    },
  };
}
