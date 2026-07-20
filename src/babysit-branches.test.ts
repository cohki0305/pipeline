import { describe, expect, test } from "bun:test";
import { updateBabysitBranches } from "./babysit-branches";

describe("updateBabysitBranches", () => {
  test("フィールドがない場合の add はデフォルトを保持して追加する", () => {
    expect(updateBabysitBranches({}, "add", "serp-api")).toEqual({ babysitBranches: ["issue-*", "serp-api"] });
  });

  test("既存パターンの add は重複しない", () => {
    const config = { babysitBranches: ["issue-*", "serp-api"] };
    expect(updateBabysitBranches(config, "add", "serp-api")).toEqual({ babysitBranches: ["issue-*", "serp-api"] });
  });

  test("remove はパターンを取り除く", () => {
    const config = { babysitBranches: ["issue-*", "serp-api"] };
    expect(updateBabysitBranches(config, "remove", "serp-api")).toEqual({ babysitBranches: ["issue-*"] });
  });

  test("不正なパターンは throw する", () => {
    expect(() => updateBabysitBranches({}, "add", "a;b")).toThrow("パターン");
    expect(() => updateBabysitBranches({}, "add", "")).toThrow("パターン");
  });

  test("他の設定フィールドは保持される", () => {
    const config = { baseBranch: "main", babysitBranches: ["issue-*"] };
    expect(updateBabysitBranches(config, "add", "hotfix-*")).toEqual({
      baseBranch: "main",
      babysitBranches: ["issue-*", "hotfix-*"],
    });
  });
});
