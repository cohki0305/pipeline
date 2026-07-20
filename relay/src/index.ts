import { DurableObject } from "cloudflare:workers";

export interface Env {
  RELAY: DurableObjectNamespace<Relay>;
  WEBHOOK_SECRET: string;
  CLIENT_TOKEN: string;
}

export class Relay extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const pair = new WebSocketPair();
    // hibernation API: 接続を維持したまま DO は休止できる。ping/pong は DO を起こさず自動応答
    this.ctx.acceptWebSocket(pair[1]);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  broadcast(message: string): number {
    const sockets = this.ctx.getWebSockets();
    for (const ws of sockets) ws.send(message);
    return sockets.length;
  }

  async webSocketMessage(): Promise<void> {}
}

const FORWARD_EVENTS = new Set([
  "issue_comment",
  "pull_request_review",
  "pull_request_review_comment",
  "push",
  "check_suite",
]);

// CI は失敗系の完了だけ babysit のトリガーにする（成功まで転送すると無駄な起動が増える）
const CI_FAILURE_CONCLUSIONS = new Set(["failure", "timed_out", "startup_failure"]);

async function validSignature(secret: string, body: string, signature: string | null): Promise<boolean> {
  if (!signature?.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  const expected = `sha256=${[...mac].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
  return timingSafeEqual(expected, signature);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // secrets 未設定のままデプロイされた場合は fail-closed
    if (!env.WEBHOOK_SECRET || !env.CLIENT_TOKEN) {
      return new Response("relay not configured", { status: 500 });
    }
    const url = new URL(request.url);
    const relay = env.RELAY.getByName("main");

    if (url.pathname === "/webhook" && request.method === "POST") {
      const body = await request.text();
      if (!(await validSignature(env.WEBHOOK_SECRET, body, request.headers.get("x-hub-signature-256")))) {
        return new Response("bad signature", { status: 401 });
      }
      const event = request.headers.get("x-github-event") ?? "";
      if (!FORWARD_EVENTS.has(event)) return new Response("ignored");
      const payload = JSON.parse(body) as {
        action?: string;
        ref?: string;
        issue?: { number?: number };
        pull_request?: { number?: number };
        repository?: { full_name?: string };
        check_suite?: { conclusion?: string; pull_requests?: { number?: number }[] };
      };
      if (event === "push" && payload.ref !== "refs/heads/main") return new Response("ignored");
      if (
        event === "check_suite" &&
        (payload.action !== "completed" || !CI_FAILURE_CONCLUSIONS.has(payload.check_suite?.conclusion ?? ""))
      ) {
        return new Response("ignored");
      }
      const delivered = await relay.broadcast(
        JSON.stringify({
          event,
          action: payload.action ?? null,
          pr:
            payload.issue?.number ??
            payload.pull_request?.number ??
            payload.check_suite?.pull_requests?.[0]?.number ??
            null,
          repo: payload.repository?.full_name ?? null,
        }),
      );
      return new Response(`forwarded to ${delivered}`);
    }

    if (url.pathname === "/connect") {
      if (!timingSafeEqual(request.headers.get("authorization") ?? "", `Bearer ${env.CLIENT_TOKEN}`)) {
        return new Response("unauthorized", { status: 401 });
      }
      return relay.fetch(request);
    }

    return new Response("not found", { status: 404 });
  },
};
