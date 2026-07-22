import { describe, expect, test } from "bun:test";
import { parseMain } from "./main";

describe("parseMain", () => {
  test("数字は run コマンド", () => {
    expect(parseMain(["153"])).toEqual({ cmd: "run", issue: 153, designDocPath: undefined, mode: "resume" });
    expect(parseMain(["153", "--design", "plan.md"])).toEqual({
      cmd: "run",
      issue: 153,
      designDocPath: "plan.md",
      mode: "resume",
    });
    expect(parseMain(["153", "--fresh"])).toEqual({ cmd: "run", issue: 153, designDocPath: undefined, mode: "fresh" });
  });

  test("--worktree で作業ディレクトリを指定できる", () => {
    expect(parseMain(["220", "--worktree", "/home/koki/worktrees/meo/performance-api"])).toEqual({
      cmd: "run",
      issue: 220,
      designDocPath: undefined,
      mode: "resume",
      worktreePath: "/home/koki/worktrees/meo/performance-api",
    });
    expect(parseMain(["220", "--design", "plan.md", "--worktree", "/w"])).toMatchObject({
      cmd: "run",
      designDocPath: "plan.md",
      worktreePath: "/w",
    });
  });

  test("babysit / babysit-pr / branch / planning-agent のサブコマンド", () => {
    expect(parseMain(["babysit"])).toEqual({ cmd: "babysit" });
    expect(parseMain(["babysit-pr", "194"])).toEqual({ cmd: "babysit-pr", pr: 194 });
    expect(parseMain(["branch"])).toEqual({ cmd: "branch", op: "list" });
    expect(parseMain(["branch", "list"])).toEqual({ cmd: "branch", op: "list" });
    expect(parseMain(["branch", "add", "serp-api"])).toEqual({ cmd: "branch", op: "add", pattern: "serp-api" });
    expect(parseMain(["branch", "remove", "serp-api"])).toEqual({ cmd: "branch", op: "remove", pattern: "serp-api" });
    expect(parseMain(["planning-agent"])).toEqual({ cmd: "planning-agent", op: "list" });
    expect(parseMain(["planning", "codex"])).toEqual({ cmd: "planning-agent", op: "set", agent: "codexSol" });
    expect(parseMain(["planning-agent", "claude"])).toEqual({ cmd: "planning-agent", op: "set", agent: "claude" });
  });

  test("不正な入力は help", () => {
    expect(parseMain([])).toEqual({ cmd: "help" });
    expect(parseMain(["abc"])).toEqual({ cmd: "help" });
    expect(parseMain(["babysit-pr"])).toEqual({ cmd: "help" });
    expect(parseMain(["branch", "add"])).toEqual({ cmd: "help" });
    expect(parseMain(["planning-agent", "opus"])).toEqual({ cmd: "help" });
    expect(parseMain(["-1"])).toEqual({ cmd: "help" });
  });
});
