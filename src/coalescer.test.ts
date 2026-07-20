import { describe, expect, test } from "bun:test";
import { RunCoalescer } from "./coalescer";

describe("RunCoalescer", () => {
  test("デバウンス内の連続トリガーは 1 回の実行にまとまる", async () => {
    let runs = 0;
    const c = new RunCoalescer(async () => {
      runs++;
    }, 20);
    c.trigger();
    c.trigger();
    c.trigger();
    await Bun.sleep(60);
    expect(runs).toBe(1);
  });

  test("実行中のトリガーは完了後に 1 回だけ追加実行される", async () => {
    let runs = 0;
    const c = new RunCoalescer(async () => {
      runs++;
      await Bun.sleep(50);
    }, 5);
    c.trigger();
    await Bun.sleep(20); // 1 回目の実行中
    c.trigger();
    c.trigger();
    await Bun.sleep(200);
    expect(runs).toBe(2);
  });
});
