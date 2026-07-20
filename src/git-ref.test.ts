import { describe, expect, test } from "bun:test";
import { safeRef } from "./git-ref";

describe("safeRef", () => {
  test("通常のブランチ名はそのまま返す", () => {
    expect(safeRef("main")).toBe("main");
    expect(safeRef("issue-153")).toBe("issue-153");
    expect(safeRef("feature/x.y_z-2")).toBe("feature/x.y_z-2");
  });

  test("シェルメタ文字や不正な形は throw する", () => {
    for (const bad of ["a;b", "a|b", "$(x)", "a`b`", "a b", "-x", "", "a\nb", "a&b", "a>b"]) {
      expect(() => safeRef(bad)).toThrow("ref");
    }
  });
});
