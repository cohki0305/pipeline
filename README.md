# agent-pipeline

GitHub issue 番号を渡すと 設計(Claude) → 実装(Codex Sol / Composer 2.5) → 品質ゲート(lint/typecheck/test + Composer 修正ループ) → レビュー(Claude + 修正ループ) → PR 作成 まで自動で回す汎用パイプライン。

## 前提

- CLI: claude / codex / cursor-agent / gh / git / bun（すべて認証済み）
- 対象リポジトリは GitHub リモートを持つ
- **issue・PR コメントの投稿者が信頼できるリポジトリでのみ使う**。issue 本文と PR コメントはそのまま実装エージェント（コマンド実行権限あり）へのプロンプトになるため、第三者が書き込めるリポジトリではプロンプトインジェクション経路になる。**公開リポジトリでの利用は非推奨**。babysit は緩和策として author association が OWNER / MEMBER / COLLABORATOR のコメントのみ処理し、それ以外は無視する
- codex を使う場合、`~/.codex/config.toml` に worktree 親ディレクトリの trust エントリを追加しておく（例: `[projects."/path/to/worktrees"] trust_level = "trusted"`）

## インストール（1 回だけ）

```bash
git clone https://github.com/cohki0305/pipeline ~/agent-pipeline
ln -sf ~/agent-pipeline/bin/pipeline ~/.local/bin/pipeline   # PATH 上に置く
```

以降は**どのプロジェクトでも** `pipeline` コマンドが使える（プロジェクト側の package.json への登録は不要）。

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

## 実行

プロジェクトルートで `pipeline <issue番号>`

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

プロジェクトルートで `pipeline babysit`（1 回走査）。イベント駆動の常駐監視は relay 構成で行う（下記）。

- **コンフリクト解消は全 open PR が対象**（mergeable: CONFLICTING）→ base ブランチをマージし、コンフリクトは Composer 2.5 が解消 → 品質ゲート → コミット → push
- **レビューコメント対応はブランチ単位**: `.agent-pipeline.json` の `babysitBranches`（glob 配列、リポジトリごとに設定）にマッチする PR のみ。省略時は `["issue-*"]`（パイプライン製 PR のみ）。人間ブランチを含める場合は Composer が自動 push してくることを理解した上で追加する
- 最終コミットより新しいレビューコメント（PR コメント・レビュー本文・インラインコメント、投稿者が OWNER/MEMBER/COLLABORATOR のもの）→ Composer 2.5 がコード対応 → 品質ゲート → コミット → push
- 自分で設定したレビュー bot（Codex クラウドレビュー等、association が NONE になる）を信頼したい場合は `.agent-pipeline.json` に `"babysitTrustedAuthors": ["chatgpt-codex-connector[bot]"]` を追加する。login の `[bot]` サフィックスは有無を問わず照合される。**その bot のコメントはコマンド実行権限を持つエージェントへのプロンプトになるため、自分の管理下にある bot だけを載せること**
- **保護ブランチの例外**: head が `babysitExcludeBranches`（省略時 `["main", "master", "develop", "release/*"]`）にマッチする PR には、コンフリクト解消も含め一切触らない
- 対象ブランチの管理コマンド: `pipeline branch [list | add <glob> | remove <glob>]`（プロジェクトルートで実行、`.agent-pipeline.json` を書き換える）
- PR ブランチが既にどこかの worktree に checkout 済みの場合はその worktree を再利用する

## relay（webhook のイベント駆動監視）

```
GitHub ──webhook(HMAC)──→ relay/ の Worker（Cloudflare、workers.dev）
                              │ Durable Object が WebSocket へ push
ローカル常駐 relay-client ←──(outbound WS)──┘ → babysit 実行（15 秒デバウンス、失敗時 60 秒後 1 リトライ）
```

- Worker: `relay/` を `bunx wrangler deploy`。secrets: `WEBHOOK_SECRET`（GitHub 署名検証）/ `CLIENT_TOKEN`（クライアント認証）は**必須**（未設定の場合 Worker は全リクエストを 500 で拒否する fail-closed 設計）。`openssl rand -hex 32` 等で十分な長さのランダム値を使う
- リポジトリ側: webhook を `<worker URL>/webhook` に登録（events: issue_comment, pull_request_review, pull_request_review_comment, push）
- ローカル側: `~/.agent-pipeline/relay.json` を置き、relay-client を常駐させる（pidfile で多重起動防止）。複数プロジェクトは `projects`（`"owner/repo": projectRoot` マップ）で振り分ける。Worker が broadcast に含める `repo`（repository.full_name）でルーティングし、マップにない repo のイベントは無視する。旧形式の単一 `projectRoot` も後方互換で動く（repo 情報がないメッセージのフォールバック先にもなる）

  ```json
  {
    "url": "https://<worker>.workers.dev",
    "token": "<CLIENT_TOKEN>",
    "projects": {
      "owner/repo-a": "/path/to/project-a",
      "owner/repo-b": "/path/to/project-b"
    }
  }
  ```

  webhook の `secret` は全リポジトリで同一（Worker の `WEBHOOK_SECRET` 1 本と照合されるため）。新しいリポジトリを足すときは同じ secret で webhook を登録し、`projects` にエントリを追加して relay-client を再起動する
- 恒久化: systemd user service（`~/.config/systemd/user/relay-client.service`、Restart=always）+ `loginctl enable-linger` でブート時自動起動。フォールバックに user crontab の `@reboot` エントリ。操作: `systemctl --user {status,restart} relay-client`
- ポート開放なし（PC からの outbound WebSocket のみ）。main への push・workflow ファイルも不要

## 開発

```bash
bun test   # 全テスト（実 CLI は呼ばない、フェイク注入）
```
