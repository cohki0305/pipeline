import type { AgentName, AgentRunner } from "../agents";
import type { Complexity } from "./design";

export function implementerFor(complexity: Complexity): AgentName {
  return complexity === "simple" ? "composer" : "codexSol";
}

export function buildImplementPrompt(docContent: string): string {
  return `以下の実装計画に従って実装せよ。計画にないファイルは触らない。テストを先に書き、全テストが通る状態にすること。git commit はしない。

${docContent}`;
}

export function buildRevisionImplementPrompt(docContent: string): string {
  return `以下の更新された実装計画に従い、worktree 内の既存コードへ変更を反映せよ。計画にないファイルは触らない。テストを先に書き、全テストが通る状態にすること。git commit はしない。

${docContent}`;
}

export function buildLintableReviewFixPrompt(itemsJson: string): string {
  return `以下の静的解析可能なレビュー指摘リストを修正せよ。リストにある問題だけを直し、他のコードは触らない。git commit はしない。

\`\`\`json
${itemsJson}
\`\`\``;
}

export function buildFixPrompt(kind: "lint" | "test", itemsJson: string): string {
  const label = { lint: "lint/型エラー", test: "テスト失敗" }[kind];
  return `以下の${label}リストを修正せよ。リストにある問題だけを直し、他のコードは触らない。git commit はしない。

\`\`\`json
${itemsJson}
\`\`\``;
}

export async function runImplement(
  deps: { agent: AgentRunner; cwd: string },
  args: { complexity: Complexity; docContent: string },
): Promise<void> {
  await deps.agent(implementerFor(args.complexity), buildImplementPrompt(args.docContent), { cwd: deps.cwd });
}

export async function runImplementRevision(
  deps: { agent: AgentRunner; cwd: string },
  args: { complexity: Complexity; docContent: string },
): Promise<void> {
  await deps.agent(implementerFor(args.complexity), buildRevisionImplementPrompt(args.docContent), { cwd: deps.cwd });
}
