import { describe, expect, test } from "bun:test";
import { parseMain } from "./main";

describe("parseMain", () => {
  test("数字は run コマンド", () => {
    expect(parseMain(["153"])).toEqual({ cmd: "run", issue: 153, designDocPath: undefined });
    expect(parseMain(["153", "--design", "plan.md"])).toEqual({ cmd: "run", issue: 153, designDocPath: "plan.md" });
  });

  test("babysit / babysit-pr / branch のサブコマンド", () => {
    expect(parseMain(["babysit"])).toEqual({ cmd: "babysit" });
    expect(parseMain(["babysit-pr", "194"])).toEqual({ cmd: "babysit-pr", pr: 194 });
    expect(parseMain(["branch"])).toEqual({ cmd: "branch", op: "list" });
    expect(parseMain(["branch", "list"])).toEqual({ cmd: "branch", op: "list" });
    expect(parseMain(["branch", "add", "serp-api"])).toEqual({ cmd: "branch", op: "add", pattern: "serp-api" });
    expect(parseMain(["branch", "remove", "serp-api"])).toEqual({ cmd: "branch", op: "remove", pattern: "serp-api" });
  });

  test("不正な入力は help", () => {
    expect(parseMain([])).toEqual({ cmd: "help" });
    expect(parseMain(["abc"])).toEqual({ cmd: "help" });
    expect(parseMain(["babysit-pr"])).toEqual({ cmd: "help" });
    expect(parseMain(["branch", "add"])).toEqual({ cmd: "help" });
    expect(parseMain(["-1"])).toEqual({ cmd: "help" });
  });
});
