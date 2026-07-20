import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { RunCoalescer } from "./coalescer";
import { shellExec } from "./exec";

// GitHub webhook を中継 Worker から outbound WebSocket で受け取り、ローカルで babysit を回す常駐クライアント

type RelayConfig = { url: string; token: string; projectRoot: string };

const stateDir = join(homedir(), ".agent-pipeline");
const pidFile = join(stateDir, "relay-client.pid");
const config = JSON.parse(readFileSync(join(stateDir, "relay.json"), "utf8")) as RelayConfig;

const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);

if (existsSync(pidFile)) {
  const old = Number(readFileSync(pidFile, "utf8").trim());
  try {
    if (old > 0) {
      process.kill(old, 0);
      log(`既にクライアントが動いている (pid ${old})。終了`);
      process.exit(0);
    }
  } catch {}
}
mkdirSync(stateDir, { recursive: true });
writeFileSync(pidFile, String(process.pid));
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    rmSync(pidFile, { force: true });
    process.exit(0);
  });
}

const runBabysitOnce = () => shellExec("bun run babysit", { cwd: config.projectRoot, timeoutMs: 45 * 60 * 1000 });

const coalescer = new RunCoalescer(async () => {
  log("babysit 実行");
  let r = await runBabysitOnce();
  if (r.code !== 0) {
    // GitHub API の一時障害に備えて 1 回だけリトライ
    log(`babysit 失敗 (exit ${r.code})。60 秒後にリトライ`);
    await Bun.sleep(60_000);
    r = await runBabysitOnce();
  }
  const tail = `${r.stdout}\n${r.stderr}`.trim().split("\n").slice(-8).join(" / ");
  log(`babysit 完了 (exit ${r.code}): ${tail}`);
}, 15_000);

const wsUrl = `${config.url.replace(/^http/, "ws")}/connect`;
let backoffMs = 5_000;

function connect(): void {
  log(`接続中: ${wsUrl}`);
  const ws = new WebSocket(wsUrl, { headers: { Authorization: `Bearer ${config.token}` } });
  let pingTimer: ReturnType<typeof setInterval> | null = null;

  ws.onopen = () => {
    log("接続完了。イベント待機");
    backoffMs = 5_000;
    pingTimer = setInterval(() => ws.send("ping"), 30_000);
  };
  ws.onmessage = (ev) => {
    const data = String(ev.data);
    if (data === "pong") return;
    log(`イベント受信: ${data}`);
    coalescer.trigger();
  };
  ws.onclose = () => {
    if (pingTimer) clearInterval(pingTimer);
    log(`切断。${Math.round(backoffMs / 1000)} 秒後に再接続`);
    setTimeout(connect, backoffMs);
    backoffMs = Math.min(backoffMs * 2, 5 * 60 * 1000);
  };
  ws.onerror = () => {};
}

connect();
