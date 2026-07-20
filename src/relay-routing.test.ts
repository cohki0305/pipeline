import { describe, expect, test } from "bun:test";
import { resolveProjectRoot } from "./relay-routing";

const projects = {
  "cohki0305/uketuke-otaku": "/home/koki/auto-reciever",
  "TokyoFreelance/meo": "/home/koki/worktrees/meo/inky-flower/meo",
};

describe("resolveProjectRoot", () => {
  test("projects マップにある repo はその projectRoot に解決される", () => {
    const config = { url: "", token: "", projects };
    const msg = JSON.stringify({ event: "push", repo: "TokyoFreelance/meo", pr: null });
    expect(resolveProjectRoot(config, msg)).toBe("/home/koki/worktrees/meo/inky-flower/meo");
  });

  test("projects マップにない repo は null（誤ったプロジェクトで babysit を走らせない）", () => {
    const config = { url: "", token: "", projects, projectRoot: "/home/koki/auto-reciever" };
    const msg = JSON.stringify({ event: "push", repo: "someone/unknown", pr: null });
    expect(resolveProjectRoot(config, msg)).toBeNull();
  });

  test("repo 情報のないメッセージ（旧 Worker）は projectRoot にフォールバックする", () => {
    const config = { url: "", token: "", projects, projectRoot: "/home/koki/auto-reciever" };
    const msg = JSON.stringify({ event: "push", pr: null });
    expect(resolveProjectRoot(config, msg)).toBe("/home/koki/auto-reciever");
  });

  test("projects 未定義の旧設定は常に projectRoot に解決される（後方互換）", () => {
    const config = { url: "", token: "", projectRoot: "/home/koki/auto-reciever" };
    const msg = JSON.stringify({ event: "push", repo: "TokyoFreelance/meo", pr: null });
    expect(resolveProjectRoot(config, msg)).toBe("/home/koki/auto-reciever");
  });

  test("JSON でないメッセージは repo なしとして扱われる", () => {
    const config = { url: "", token: "", projectRoot: "/home/koki/auto-reciever" };
    expect(resolveProjectRoot(config, "not-json")).toBe("/home/koki/auto-reciever");
  });

  test("repo なし・projectRoot なしは null", () => {
    const config = { url: "", token: "", projects };
    expect(resolveProjectRoot(config, "not-json")).toBeNull();
  });
});
