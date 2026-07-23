# UI スクリーンショット付き PR

## 目的

UI に変更が伴う issue では、実装後の画面スクリーンショットを自動で撮影し、PR 本文にインライン表示する。レビュアーがコードを読む前に見た目の変化を確認できるようにする。

## 全体フロー

```
設計 (screenshots frontmatter に撮影対象パスを列挙)
  → 実装 → 品質ゲート → レビューループ (既存のまま変更なし)
  → 【新】スクショ撮影 (composer + agent-browser)
  → 【新】R2 アップロード (pipeline 本体が wrangler で実行)
  → PR 作成 (本文末尾に「## スクリーンショット」を機械的に追記)
```

## 設計書 frontmatter

設計担当は UI に影響する変更のとき、frontmatter に撮影対象のパスを JSON 配列で列挙する:

```
---
complexity: simple
screenshots: ["/", "/settings"]
---
```

- キーが無い・空配列なら撮影ステージ全体をスキップ（非 UI 変更のデフォルト挙動）
- 設計プロンプトに「画面の見た目に影響する変更の場合のみ列挙せよ」と判断基準を追記する

## per-repo 設定 (`.agent-pipeline.json`)

```json
"uiScreenshot": {
  "serve": "bun run dev",
  "baseUrl": "http://localhost:5173",
  "login": { "path": "/login", "email": "pipeline-test@example.com" },
  "r2Bucket": "pipeline-screenshots",
  "r2PublicBaseUrl": "https://pub-xxxx.r2.dev"
}
```

- `uiScreenshot` が無いリポジトリでは、frontmatter に screenshots があっても撮影をスキップし、レポートに「設定なし」を記録する
- `login` は任意。無ければログインせずに撮影する

## 撮影ステージ

サーバーのライフサイクルは pipeline 本体が管理する（composer 任せにするとプロセスが残留するため）:

1. pipeline が `serve` コマンドを worktree でバックグラウンド起動し、stdout/stderr をログファイルへリダイレクト、PID を記録
2. composer に依頼: 「baseUrl が応答するまで待つ → login 設定があれば `login.path` を開きメールアドレスを入力・送信 → **サーバーログファイルからマジックリンク URL を探して開く** → 各パスを agent-browser で open し screenshot を指定ファイル名で保存」
3. pipeline が PID を kill してサーバーを停止

- ログイン方式はマジックリンク前提（meo は dev で noop sender がリンクをサーバーログに出力する）。パスワード等の秘匿情報は扱わない
- テストメールは事前にアプリ側の allowlist（DB seed）へ登録しておく。これはリポジトリ側の責務
- agent-browser はブラウザインスタンス共有のため撮影は直列
- スクショの保存先は `<worktreeRoot>/.pipeline-screenshots-issue-<N>/` （worktree 外。コミット混入防止）

## R2 アップロード

- pipeline 本体が `wrangler r2 object put <bucket>/<key> --file <png> --content-type image/png` を実行（wrangler は認証済み）
- キーは `<ランダム16hex>/issue-<N>-<連番>-<パスのslug>.png`。公開バケットだがキーが推測不能なので実質非公開
- 公開 URL は `<r2PublicBaseUrl>/<key>`

## PR 本文 / レポート

- PR 本文は既存の LLM 生成 + バリデーションを変えず、生成後に pipeline が「## スクリーンショット」セクションを機械的に末尾へ追記する（`![<path>](<url>)` の列挙）。LLM に URL を扱わせない
- 実行レポートにも同じ URL 一覧を記録する

## エラー処理

スクショは補助情報でありゲートではない。以下すべて **PR 作成をブロックしない**:

- serve 起動失敗 / baseUrl 応答なし / ログイン失敗 / 撮影失敗 / アップロード失敗

失敗時はレポートに失敗理由を記録し、PR 本文のスクリーンショットセクションに「撮影失敗（理由）」を明記して続行する。サーバープロセスの kill は成否に関わらず必ず実行する。

## 対象外 (v1)

- before/after 比較（after のみ撮影）
- babysit の修正 push 後の再撮影
- 複数ビューポート（デスクトップ幅のみ）

## テスト

既存ハーネスの流儀でユニットテスト:

- frontmatter の screenshots パース（無し・空・配列）
- 設定なし/対象なしのスキップ判定
- R2 キー生成（ランダム部は deps 注入で決定化）
- PR 本文へのセクション追記
- 失敗時に PR 作成へ進む非ブロック動作
- サーバー起動/停止コマンドの発行

## 改訂 (2026-07-23 v2: ゼロコンフィグ化)

per-repo 設定なしで動くように変更。`uiScreenshot` は全項目任意の上書きヒントに格下げ:

- serve: 既定 `bun run dev`
- baseUrl: 未指定なら composer がサーバーログの `Local: http://localhost:PORT` から特定
- login: 未指定なら composer がリポジトリ（認証設定・seed）を調査してログイン方式とテスト用メールを特定。マジックリンクはサーバーログから取得
- R2: 共通バケット `pipeline-screenshots`（cohki0305 アカウント）と公開 URL を既定値としてコードに保持。`wrangler r2 object put` は `--remote` 必須、bunx で対象リポジトリの依存から解決、`CLOUDFLARE_ACCOUNT_ID` を明示

アカウント ID とバケット公開 URL は秘匿情報ではない（実質の鍵はキーのランダム 16hex）。
