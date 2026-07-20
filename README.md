# agent-pipeline

GitHub issue 番号を渡すと 設計(Claude) → 実装(Codex Sol / Composer 2.5) → 品質ゲート(lint/typecheck/test + Composer 修正ループ) → レビュー(Claude + 修正ループ) → PR 作成 まで自動で回す汎用パイプライン。

## 前提

- CLI: claude / codex / cursor-agent / gh / git / bun（すべて認証済み）
- 対象リポジトリは GitHub リモートを持つ
- **issue の作成者が信頼できるリポジトリでのみ使う**。issue 本文はそのまま実装エージェント（コマンド実行権限あり）へのプロンプトになるため、第三者が issue を書けるリポジトリではプロンプトインジェクション経路になる
- codex を使う場合、`~/.codex/config.toml` に worktree 親ディレクトリの trust エントリを追加しておく（例: `[projects."/path/to/worktrees"] trust_level = "trusted"`）

## プロジェクトへの導入

1. リポジトリ直下に `.agent-pipeline.json` を置く:

   ```json
   {
     "commands": { "lint": "...", "typecheck": "...", "test": "..." },
     "designDocDir": "docs/agent-pipeline/plans",
     "reportDir": "docs/agent-pipeline/runs",
     "baseBranch": "main",
     "worktreeRoot": "../pipeline-worktrees",
     "postWorktreeSetup": "worktree 内で実行する任意のセットアップコマンド"
   }
   ```

   `commands` の 3 つは必須。それ以外は省略可（上記がデフォルト、`worktreeRoot` はプロジェクトの親ディレクトリ配下、`postWorktreeSetup` はなし）。

2. package.json の scripts に追加（任意）: `"pipeline": "bun run $HOME/agent-pipeline/src/cli.ts"`

## 実行

プロジェクトルートで `bun run pipeline <issue番号>`

- `--design <パス>` を付けると設計ステージを省略し、外部で作った設計書（frontmatter に `complexity: simple|complex` 必須）をそのまま実装に渡す。設計書は worktree の designDocDir にコピーされてコミットされる

- exit 0: PR 作成まで完了（stdout に URL）
- exit 2: 修正ループ上限超過。stderr に残違反。worktree は残るので手動で続きから対応可能
- その他: 環境エラー（設定不備・認証切れ等）

## 挙動の要点

- 実装の担当は設計 doc の complexity で決まる: simple → Composer 2.5 / complex → Codex Sol（判断基準は `src/stages/design.ts` の `COMPLEXITY_CRITERIA`）
- lint/typecheck 違反は常に Composer 2.5 が修正、テスト失敗とレビュー指摘は実装担当が修正
- 修正ループ: 品質ゲートは最大 3 回。レビューは指摘件数が減り続ける限り継続し、停滞（件数が減らない）または 3 ラウンドで停止。レビュー修正後は必ず品質ゲートを再実行してからコミットする
- severity ゲート: 修正ループの対象は critical/high/medium のみ。low はループを止めず実行レポートの「未対応の low 指摘」に記録される（機械化できるものは custom lint 化で吸収する方針）
- 消し込み方式: 2 巡目以降のレビューは diff 全体の再レビューではなく、前回指摘リスト（id 付き）の fixed/unfixed 判定 + 修正が持ち込んだ新規問題の追加のみ
- レビューで「静的検出可能」と判定された指摘は実行レポート（`reportDir/issue-<番号>.md`）の「custom lint 化候補」に蓄積される
- codex はグローバル設定に依らず `-s workspace-write` サンドボックスで実行する。codex / cursor-agent は stdin を読みにいく仕様のため、コマンドテンプレートは `/dev/null` リダイレクトを含む（`src/agents.ts` の `AGENT_COMMANDS` を参照）

## babysit（open PR の見張り）

プロジェクトルートで `bun run babysit`（1 回走査）。イベント駆動の常駐監視は relay 構成で行う（下記）。

- 対象: `issue-*` ブランチの open PR
- コンフリクト（mergeable: CONFLICTING）→ base ブランチをマージし、コンフリクトは Composer 2.5 が解消 → 品質ゲート → コミット → push
- 最終コミットより新しいレビューコメント（PR コメント・レビュー本文・インラインコメント）→ Composer 2.5 がコード対応 → 品質ゲート → コミット → push

## relay（webhook のイベント駆動監視）

```
GitHub ──webhook(HMAC)──→ relay/ の Worker（Cloudflare、workers.dev）
                              │ Durable Object が WebSocket へ push
ローカル常駐 relay-client ←──(outbound WS)──┘ → babysit 実行（15 秒デバウンス、失敗時 60 秒後 1 リトライ）
```

- Worker: `relay/` を `bunx wrangler deploy`。secrets: `WEBHOOK_SECRET`（GitHub 署名検証）/ `CLIENT_TOKEN`（クライアント認証）
- リポジトリ側: webhook を `<worker URL>/webhook` に登録（events: issue_comment, pull_request_review, pull_request_review_comment, push）
- ローカル側: `~/.agent-pipeline/relay.json`（url / token / projectRoot）を置き、relay-client を常駐させる（pidfile で多重起動防止）
- 恒久化: systemd user service（`~/.config/systemd/user/relay-client.service`、Restart=always）+ `loginctl enable-linger` でブート時自動起動。フォールバックに user crontab の `@reboot` エントリ。操作: `systemctl --user {status,restart} relay-client`
- ポート開放なし（PC からの outbound WebSocket のみ）。main への push・workflow ファイルも不要

## 開発

```bash
bun test   # 全テスト（実 CLI は呼ばない、フェイク注入）
```
