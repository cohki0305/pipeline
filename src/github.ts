import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findFailedChecks, pickWorkflowRunId, trimCiLog, type StatusCheck } from "./ci-status";
import type { Exec } from "./exec";

export type Issue = { number: number; title: string; body: string };
export type PrSummary = { number: number; headRefName: string; baseRefName: string; mergeable: string; author: string };

type RawPr = { number: number; headRefName: string; baseRefName: string; mergeable: string; author?: { login?: string } };

function normalizePr(raw: RawPr): PrSummary {
  return {
    number: raw.number,
    headRefName: raw.headRefName,
    baseRefName: raw.baseRefName,
    mergeable: raw.mergeable,
    author: raw.author?.login ?? "",
  };
}
export type PrComment = { author: string; authorAssociation: string; body: string; path: string | null; createdAt: string };
export type PrFailedCheck = Pick<StatusCheck, "name" | "conclusion" | "detailsUrl">;

export type Github = {
  fetchIssue(cwd: string, num: number): Promise<Issue>;
  createPr(cwd: string, args: { title: string; body: string; base: string }): Promise<string>;
  listOpenPrs(cwd: string): Promise<PrSummary[]>;
  getPr(cwd: string, num: number): Promise<PrSummary>;
  getPrComments(cwd: string, num: number): Promise<PrComment[]>;
  getPrFailedChecks(cwd: string, num: number): Promise<PrFailedCheck[]>;
  getWorkflowRunFailedLog(cwd: string, runId: number): Promise<string>;
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
      const r = await exec("gh pr list --state open --json number,headRefName,baseRefName,mergeable,author", { cwd });
      if (r.code !== 0) throw new Error(`PR 一覧の取得に失敗: ${r.stderr}`);
      return (JSON.parse(r.stdout) as RawPr[]).map(normalizePr);
    },
    async getPr(cwd, num) {
      const r = await exec(`gh pr view ${num} --json number,headRefName,baseRefName,mergeable,author`, { cwd });
      if (r.code !== 0) throw new Error(`PR #${num} の取得に失敗: ${r.stderr}`);
      return normalizePr(JSON.parse(r.stdout) as RawPr);
    },
    async getPrComments(cwd, num) {
      const view = await exec(`gh pr view ${num} --json comments,reviews`, { cwd });
      if (view.code !== 0) throw new Error(`PR #${num} のコメント取得に失敗: ${view.stderr}`);
      const data = JSON.parse(view.stdout) as {
        comments?: { author?: { login?: string }; authorAssociation?: string; body?: string; createdAt?: string }[];
        reviews?: { author?: { login?: string }; authorAssociation?: string; body?: string; submittedAt?: string }[];
      };
      const inline = await exec(`gh api "repos/{owner}/{repo}/pulls/${num}/comments"`, { cwd });
      if (inline.code !== 0) throw new Error(`PR #${num} のインラインコメント取得に失敗: ${inline.stderr}`);
      const inlineData = JSON.parse(inline.stdout) as {
        user?: { login?: string };
        author_association?: string;
        body?: string;
        path?: string;
        created_at?: string;
      }[];
      return [
        ...(data.comments ?? []).map((c) => ({
          author: c.author?.login ?? "",
          authorAssociation: c.authorAssociation ?? "NONE",
          body: c.body ?? "",
          path: null,
          createdAt: c.createdAt ?? "",
        })),
        ...(data.reviews ?? [])
          .filter((rv) => rv.body?.trim())
          .map((rv) => ({
            author: rv.author?.login ?? "",
            authorAssociation: rv.authorAssociation ?? "NONE",
            body: rv.body ?? "",
            path: null,
            createdAt: rv.submittedAt ?? "",
          })),
        ...inlineData.map((c) => ({
          author: c.user?.login ?? "",
          authorAssociation: c.author_association ?? "NONE",
          body: c.body ?? "",
          path: c.path ?? null,
          createdAt: c.created_at ?? "",
        })),
      ];
    },
    async getPrFailedChecks(cwd, num) {
      const r = await exec(`gh pr view ${num} --json statusCheckRollup`, { cwd });
      if (r.code !== 0) throw new Error(`PR #${num} の CI 状態取得に失敗: ${r.stderr}`);
      const data = JSON.parse(r.stdout) as { statusCheckRollup?: StatusCheck[] };
      return findFailedChecks(data.statusCheckRollup ?? []);
    },
    async getWorkflowRunFailedLog(cwd, runId) {
      const r = await exec(`gh run view ${runId} --log-failed`, { cwd, timeoutMs: 120_000 });
      if (r.code !== 0) throw new Error(`workflow run ${runId} のログ取得に失敗: ${r.stderr}`);
      return trimCiLog(`${r.stdout}\n${r.stderr}`.trim());
    },
  };
}
