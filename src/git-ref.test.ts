import { describe, expect, test } from "bun:test";
import { safeRef } from "./git-ref";

describe("safeRef", () => {
  test("通常のブランチ名はそのまま返す", () => {
    expect(safeRef("main")).toBe("main");
    expect(safeRef("issue-153")).toBe("issue-153");
    expect(safeRef("feature/x.y_z-2")).toBe("feature/x.y_z-2");
    expect(safeRef("feat/#140-gbp-profile-real-sync")).toBe("feat/#140-gbp-profile-real-sync");
    expect(safeRef("renovate/@types-node")).toBe("renovate/@types-node");
    expect(safeRef("worktree-feat+50-score-breakdown")).toBe("worktree-feat+50-score-breakdown");
  });

  test("# や @ が先頭のブランチ名は拒否する", () => {
    expect(() => safeRef("#140")).toThrow("ref");
    expect(() => safeRef("@evil")).toThrow("ref");
  });

  test("シェルメタ文字や不正な形は throw する", () => {
    for (const bad of ["a;b", "a|b", "$(x)", "a`b`", "a b", "-x", "", "a\nb", "a&b", "a>b"]) {
      expect(() => safeRef(bad)).toThrow("ref");
    }
  });
});
