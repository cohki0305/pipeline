import { describe, expect, test } from "bun:test";
import { shellExec } from "./exec";

describe("shellExec", () => {
  test("stdout と exit code を返す", async () => {
    const r = await shellExec("echo hello");
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("hello");
  });

  test("非ゼロ exit でも throw せず code を返す", async () => {
    const r = await shellExec("echo err >&2; exit 3");
    expect(r.code).toBe(3);
    expect(r.stderr.trim()).toBe("err");
  });

  test("cwd と env を反映する", async () => {
    const r = await shellExec('echo "$PWD $MARKER"', { cwd: "/tmp", env: { MARKER: "m1" } });
    expect(r.stdout.trim()).toBe("/tmp m1");
  });
});
