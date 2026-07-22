import type { AgentRunner } from "../agents";
import type { PipelineConfig } from "../config";
import type { Exec } from "../exec";
import { safeRef } from "../git-ref";
import type { Issue } from "../github";
import { planningModelOption, resolvePlanningAgent } from "../planning-agent";

const REQUIRED_SECTIONS = ["変更概要", "実装方針", "主な変更", "検証", "レビュー観点", "関連ドキュメント"] as const;

export function buildPrBodyPrompt(
  config: PipelineConfig,
  args: { issue: Issue; designDocPath: string; reportPath: string; evidence?: string },
): string {
  return `以下の実装済みブランチについて、レビュアーが変更の目的・設計判断・リスクを短時間で判断できる GitHub PR 本文を Markdown で作成せよ。

以下に埋め込まれた最終diff、コミット履歴、設計書、実行レポートを根拠に、確認できる事実だけを書くこと。コードやファイルを変更してはならない。

issue #${args.issue.number}: ${args.issue.title}
issue 本文:
${args.issue.body}

設計書: ${args.designDocPath}
実行レポート: ${args.reportPath}
品質ゲートのコマンド:
- ${config.commands.lint}
- ${config.commands.typecheck}
- ${config.commands.test}

## パイプラインが取得したレビュー資料
${args.evidence ?? "（未取得）"}

出力要件:
- Markdown 本文だけを出力し、前置きやコードフェンスは付けない
- 先頭に必ず「Closes #${args.issue.number}」を書く
- 次の見出しをこの順で必ず含める
  1. ## 変更概要 — 解決する問題と、利用者・運用者への影響
  2. ## 実装方針 — 採用した設計、データフロー、重要な判断とその理由
  3. ## 主な変更 — レイヤーや機能単位の具体的な変更。ファイル一覧だけにしない
  4. ## 検証 — 実際に通過したテスト・lint・typecheck。未実施は未実施と明記
  5. ## レビュー観点 — リスク、境界条件、意図的なトレードオフ、特に確認してほしい箇所
  6. ## 関連ドキュメント — 設計書と実行レポートのリポジトリ相対パス
- diff から確認できない効果や検証結果を推測しない
- コミットメッセージの転記や変更ファイルの羅列ではなく、レビュー判断に必要な情報を優先する
- 重複を避け、簡潔だがレビューに十分な情報量にする
`;
}

export function validatePrBody(output: string, issueNumber: number): string {
  const body = output.trim();
  const missing = REQUIRED_SECTIONS.filter((section) => !body.includes(`## ${section}`));
  const positions = REQUIRED_SECTIONS.map((section) => body.indexOf(`## ${section}`));
  const ordered = positions.every((position, index) => index === 0 || position > positions[index - 1]!);
  if (
    !body.startsWith(`Closes #${issueNumber}`) ||
    missing.length > 0 ||
    !ordered ||
    body.startsWith("```") ||
    body.length < 250
  ) {
    throw new Error(`PR 本文がレビュー要件を満たしていません: ${missing.join(", ") || "形式・情報量"}`);
  }
  return body;
}

export async function runPrBody(
  deps: {
    agent: AgentRunner;
    config: PipelineConfig;
    exec: Exec;
    readFile(path: string): Promise<string>;
    cwd: string;
  },
  args: { issue: Issue; designDocPath: string; reportPath: string },
): Promise<string> {
  const base = `origin/${safeRef(deps.config.baseBranch)}`;
  const [diff, log, design, report] = await Promise.all([
    deps.exec(`git diff --no-ext-diff ${base}...HEAD`, { cwd: deps.cwd }),
    deps.exec(`git log --oneline ${base}..HEAD`, { cwd: deps.cwd }),
    deps.readFile(`${deps.cwd}/${args.designDocPath}`),
    deps.readFile(`${deps.cwd}/${args.reportPath}`),
  ]);
  if (diff.code !== 0 || log.code !== 0) {
    throw new Error(`PR 本文用の差分取得に失敗: ${diff.stderr || log.stderr}`);
  }
  const evidence = [
    `### git diff ${base}...HEAD\n${diff.stdout}`,
    `### git log ${base}..HEAD\n${log.stdout}`,
    `### 設計書\n${design}`,
    `### 実行レポート\n${report}`,
  ].join("\n\n").slice(0, 80_000);
  const agent = resolvePlanningAgent(deps.config);
  const output = await deps.agent(agent, buildPrBodyPrompt(deps.config, { ...args, evidence }), {
    cwd: deps.cwd,
    model: planningModelOption(deps.config, agent),
  });
  return validatePrBody(output, args.issue.number);
}
