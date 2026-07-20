import { describe, expect, test } from "bun:test";
import {
  buildCiFailurePrompt,
  extractWorkflowRunId,
  findFailedChecks,
  pickWorkflowRunId,
  trimCiLog,
} from "./ci-status";

describe("findFailedChecks", () => {
  test("失敗系 conclusion のチェックだけ返す", () => {
    const checks = findFailedChecks([
      { __typename: "CheckRun", name: "test", conclusion: "SUCCESS", detailsUrl: null },
      { __typename: "CheckRun", name: "lint", conclusion: "FAILURE", detailsUrl: "https://x/actions/runs/1/job/2" },
      { __typename: "CheckRun", name: "pending", conclusion: null, detailsUrl: null },
    ]);
    expect(checks.map((check) => check.name)).toEqual(["lint"]);
  });
});

describe("extractWorkflowRunId", () => {
  test("actions run URL から run id を取り出す", () => {
    expect(
      extractWorkflowRunId("https://github.com/cohki0305/uketuke-otaku/actions/runs/29721336563/job/88284809637"),
    ).toBe(29721336563);
  });
});

describe("pickWorkflowRunId", () => {
  test("最初に見つかった run id を返す", () => {
    expect(
      pickWorkflowRunId([
        { __typename: "CheckRun", name: "a", conclusion: "FAILURE", detailsUrl: null },
        {
          __typename: "CheckRun",
          name: "b",
          conclusion: "FAILURE",
          detailsUrl: "https://github.com/x/y/actions/runs/42/job/1",
        },
      ]),
    ).toBe(42);
  });
});

describe("buildCiFailurePrompt", () => {
  test("失敗チェック名とログを含める", () => {
    const prompt = buildCiFailurePrompt([{ name: "test-typescript" }], "error: lint failed");
    expect(prompt).toContain("test-typescript");
    expect(prompt).toContain("error: lint failed");
    expect(prompt).toContain("git commit はしない");
  });
});

describe("trimCiLog", () => {
  test("長いログは末尾だけ残す", () => {
    const log = `${"a".repeat(20_000)}TAIL`;
    expect(trimCiLog(log, 100)).toBe(`${"a".repeat(96)}TAIL`);
  });
});
