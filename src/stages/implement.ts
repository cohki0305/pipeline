import type { AgentName, AgentRunner } from "../agents";
import type { Complexity } from "./design";

export function implementerFor(complexity: Complexity): AgentName {
  return complexity === "simple" ? "composer" : "codexSol";
}

export function buildImplementPrompt(docContent: string): string {
  return `以下の実装計画に従って実装せよ。計画にないファイルは触らない。テストを先に書き、全テストが通る状態にすること。git commit はしない。

${docContent}`;
}

export function buildFixPrompt(kind: "lint" | "test" | "review", itemsJson: string): string {
  const label = { lint: "lint/型エラー", test: "テスト失敗", review: "コードレビュー指摘" }[kind];
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
