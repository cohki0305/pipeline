import { randomBytes } from "node:crypto";
import type { AgentRunner } from "../agents";
import type { PipelineConfig } from "../config";
import type { Exec } from "../exec";

export type Shot = { page: string; url: string };
export type ScreenshotResult = { shots: Shot[]; failures: string[] };

/** 全リポジトリ共通の既定インフラ。アカウント ID とバケット URL は秘匿情報ではない（キーのランダム 16hex が実質の鍵） */
export const R2_DEFAULTS = {
  accountId: "64e49c2d094df7eb659a0e88d99ef51a",
  bucket: "pipeline-screenshots",
  publicBaseUrl: "https://pub-8113baf548a54f3a8f37bb5358097b97.r2.dev",
} as const;

export type EffectiveScreenshotConfig = {
  serve: string;
  baseUrl?: string;
  login?: { path?: string; email?: string };
  r2Bucket: string;
  r2PublicBaseUrl: string;
  r2AccountId: string;
};

/** 設定は全項目任意。未指定の項目は既定値と、composer によるリポジトリ・サーバーログからの自力発見で補う */
export function resolveScreenshotConfig(config: PipelineConfig): EffectiveScreenshotConfig {
  const cfg = config.uiScreenshot;
  return {
    serve: cfg?.serve ?? "bun run dev",
    baseUrl: cfg?.baseUrl,
    login: cfg?.login,
    r2Bucket: cfg?.r2Bucket ?? R2_DEFAULTS.bucket,
    r2PublicBaseUrl: cfg?.r2PublicBaseUrl ?? R2_DEFAULTS.publicBaseUrl,
    r2AccountId: R2_DEFAULTS.accountId,
  };
}

export function screenshotFileName(issueNumber: number, index: number, page: string): string {
  const slug = page.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "root";
  return `issue-${issueNumber}-${index + 1}-${slug}.png`;
}

export function buildScreenshotPrompt(
  cfg: EffectiveScreenshotConfig,
  args: { pages: string[]; files: string[]; outDir: string; serverLogPath: string },
): string {
  const base = cfg.baseUrl
    ? `1. ${cfg.baseUrl} が HTTP 応答を返すまで待つ（curl 等で確認。最大 90 秒。応答しなければ ${args.serverLogPath} の内容を出力して中断する）。以降これを <BASE> と呼ぶ`
    : `1. サーバーログ ${args.serverLogPath} から dev サーバーのローカル URL（例: \`Local: http://localhost:5173\`）を特定し、HTTP 応答を返すまで待つ（最大 90 秒。まだログに出ていなければ数秒待って再確認する）。以降これを <BASE> と呼ぶ`;
  const knownLogin = [
    cfg.login?.path ? `ログインページは <BASE>${cfg.login.path}` : null,
    cfg.login?.email ? `テスト用メールアドレスは ${cfg.login.email}` : null,
  ].filter(Boolean);
  const login = `2. 撮影対象がログインを要求する場合はログインする。${
    knownLogin.length > 0 ? `既知の情報: ${knownLogin.join(" / ")}。` : ""
  }不明な点はリポジトリを調査して特定する（認証設定からログイン方式を、seed やテストデータからテスト用メールアドレスを探す）。メールアドレス方式（マジックリンク）の場合は、フォームにメールアドレスを入力・送信した後、サーバーログ ${args.serverLogPath} に出力されるマジックリンク URL を grep 等で探し、\`agent-browser open "<そのURL>"\` で開いてログインを完了する（リンクがまだ無ければ数秒待って再確認する）。ログイン不要ならこの手順は飛ばす`;
  const shots = args.pages
    .map(
      (page, i) =>
        `   - \`agent-browser open "<BASE>${page}"\` → \`agent-browser wait 1500\` → \`agent-browser screenshot ${args.outDir}/${args.files[i]}\``,
    )
    .join("\n");
  return `あなたはブラウザ操作の担当。起動済みの開発サーバーの画面を agent-browser CLI（\`bunx agent-browser\`）で撮影せよ。リポジトリのコードを変更してはならない。

手順:
${base}
${login}
3. 以下のページを順番に撮影する（agent-browser はブラウザインスタンス共有のため並列実行不可）:
${shots}
4. 各ファイルが生成されていることを ls で確認する

最後に、撮影に成功したファイルの絶対パスを 1 行ずつ出力せよ。失敗したページがあれば「FAILED: <ページ> <理由>」と出力する。`;
}

export function appendScreenshotSection(body: string, result: ScreenshotResult): string {
  const lines = ["## スクリーンショット", ""];
  for (const shot of result.shots) lines.push(`### ${shot.page}`, "", `![${shot.page}](${shot.url})`, "");
  for (const failure of result.failures) lines.push(`- 撮影失敗: ${failure}`);
  return `${body.trimEnd()}\n\n${lines.join("\n").trimEnd()}\n`;
}

export type ScreenshotDeps = {
  exec: Exec;
  agent: AgentRunner;
  config: PipelineConfig;
  log(msg: string): void;
  /** テストで固定するための注入口。既定は crypto の乱数 16hex */
  randomHex?: () => string;
};

/** 撮影は補助情報でゲートではないため、この関数は throw せず失敗を failures として返す */
export async function runScreenshotStage(
  deps: ScreenshotDeps,
  args: { cwd: string; issueNumber: number; pages: string[] },
): Promise<ScreenshotResult> {
  if (args.pages.length === 0) return { shots: [], failures: [] };
  const cfg = resolveScreenshotConfig(deps.config);

  const outDir = `${deps.config.worktreeRoot}/.pipeline-screenshots-issue-${args.issueNumber}`;
  const serverLogPath = `${outDir}/server.log`;
  const pidPath = `${outDir}/server.pid`;
  const files = args.pages.map((page, i) => screenshotFileName(args.issueNumber, i, page));
  const failures: string[] = [];

  const start = await deps.exec(
    `mkdir -p "$SCREENSHOT_DIR" && { nohup ${cfg.serve} >"$SCREENSHOT_DIR/server.log" 2>&1 & echo $! >"$SCREENSHOT_DIR/server.pid"; }`,
    { cwd: args.cwd, env: { SCREENSHOT_DIR: outDir } },
  );
  if (start.code !== 0) {
    return { shots: [], failures: [`dev サーバーの起動に失敗: ${start.stderr.slice(0, 500)}`] };
  }

  try {
    deps.log(`スクリーンショット撮影 (${args.pages.length} ページ) → composer`);
    await deps.agent("composer", buildScreenshotPrompt(cfg, { pages: args.pages, files, outDir, serverLogPath }), {
      cwd: args.cwd,
    });
  } catch (e) {
    failures.push(`撮影エージェントの実行に失敗: ${e instanceof Error ? e.message.slice(0, 500) : String(e)}`);
  } finally {
    // サーバーは成否に関わらず必ず停止する
    await deps.exec(`[ -f "$PID_FILE" ] && kill "$(cat "$PID_FILE")" 2>/dev/null; true`, {
      cwd: args.cwd,
      env: { PID_FILE: pidPath },
    });
  }

  const prefix = (deps.randomHex ?? (() => randomBytes(8).toString("hex")))();
  const shots: Shot[] = [];
  for (let i = 0; i < args.pages.length; i++) {
    const page = args.pages[i]!;
    const file = `${outDir}/${files[i]}`;
    const exists = await deps.exec(`test -f "$SHOT_FILE"`, { cwd: args.cwd, env: { SHOT_FILE: file } });
    if (exists.code !== 0) {
      failures.push(`${page}: スクリーンショットが生成されなかった`);
      continue;
    }
    const key = `${prefix}/${files[i]}`;
    // r2 object put はローカルシミュレーションが既定のため --remote 必須。wrangler は対象リポジトリの依存から bunx で解決する
    const upload = await deps.exec(
      `bunx wrangler r2 object put "$R2_KEY" --file "$SHOT_FILE" --content-type image/png --remote`,
      {
        cwd: args.cwd,
        env: { R2_KEY: `${cfg.r2Bucket}/${key}`, SHOT_FILE: file, CLOUDFLARE_ACCOUNT_ID: cfg.r2AccountId },
      },
    );
    if (upload.code !== 0) {
      failures.push(`${page}: R2 アップロードに失敗: ${upload.stderr.slice(0, 300)}`);
      continue;
    }
    shots.push({ page, url: `${cfg.r2PublicBaseUrl}/${key}` });
  }
  return { shots, failures };
}
