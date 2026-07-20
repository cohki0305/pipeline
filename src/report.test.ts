import { describe, expect, test } from "bun:test";
import { RunReport } from "./report";

describe("RunReport", () => {
  test("ステージと lint 化候補を markdown に整形する", () => {
    const r = new RunReport(143, "2026-07-19");
    r.addStage("設計", "complexity: simple");
    r.addStage("品質ゲート", "1 回の修正で通過");
    r.addLintCandidate({ file: "app/x.ts", message: "raw palette 使用" });
    const md = r.render();
    expect(md).toContain("# issue #143 パイプライン実行レポート");
    expect(md).toContain("日付: 2026-07-19");
    expect(md).toContain("## 設計");
    expect(md).toContain("complexity: simple");
    expect(md).toContain("## custom lint 化候補");
    expect(md).toContain("- app/x.ts: raw palette 使用");
  });

  test("lint 化候補がなければセクション自体を出さない", () => {
    const r = new RunReport(1, "2026-07-19");
    expect(r.render()).not.toContain("custom lint 化候補");
  });

  test("同じ lint 化候補は重複登録されない", () => {
    const r = new RunReport(1, "2026-07-19");
    r.addLintCandidate({ file: "app/x.ts", message: "重複" });
    r.addLintCandidate({ file: "app/x.ts", message: "重複" });
    const md = r.render();
    expect(md.split("- app/x.ts: 重複")).toHaveLength(2);
  });

  test("low 指摘は専用セクションに載り、重複しない", () => {
    const r = new RunReport(1, "2026-07-19");
    r.addLowFinding({ file: "app/y.ts", message: "命名が惜しい" });
    r.addLowFinding({ file: "app/y.ts", message: "命名が惜しい" });
    const md = r.render();
    expect(md).toContain("## 未対応の low 指摘");
    expect(md.split("- app/y.ts: 命名が惜しい")).toHaveLength(2);
  });
});
