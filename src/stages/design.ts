import type { AgentRunner } from "../agents";
import type { PipelineConfig } from "../config";
import type { Issue } from "../github";

export type Complexity = "simple" | "complex";
export type DesignResult = { complexity: Complexity; docPath: string; docContent: string };

// ユーザー定義の判断基準。実装時にユーザーに書いてもらう（フォールバック値）
export const COMPLEXITY_CRITERIA = `- simple: 変更が 1〜2 ファイルに収まり、既存パターンの踏襲で書ける（typo 修正、既存 lint への追随、単純な CRUD 追加）
- complex: 新しい設計判断・複数レイヤー（route/service/repository）にまたがる変更・マイグレーション・並行処理を含む
- 迷ったら complex`;

export function buildDesignPrompt(issue: Issue): string {
  return `あなたはこのリポジトリの設計担当。リポジトリを調査した上で、以下の GitHub issue の実装計画を Markdown で出力せよ。出力は計画の Markdown のみとし、先頭に必ず次の frontmatter を付ける:

---
complexity: simple または complex
---

complexity の判断基準:
${COMPLEXITY_CRITERIA}

計画に含めるもの:
- 変更対象ファイルの一覧（実在するパスで）
- 実装手順（TDD: 失敗するテストを先に書く順序で）
- 受け入れ条件

## issue #${issue.number}: ${issue.title}

${issue.body}`;
}

export function parseDesignOutput(output: string): { complexity: Complexity; content: string } {
  // 先頭の frontmatter ブロック内だけを探す（本文中の complexity 言及への誤マッチ防止）
  const fm = output.trimStart().match(/^---\n([\s\S]*?)\n---/);
  const m = fm?.[1]?.match(/complexity:\s*(simple|complex)/);
  if (!m) throw new Error("設計出力に complexity frontmatter がありません");
  return { complexity: m[1] as Complexity, content: output };
}

// セッションで対話的に作った設計書をパイプラインに注入する経路。claude の設計呼び出しを省略する
export async function loadDesign(
  deps: {
    cwd: string;
    config: PipelineConfig;
    readFile(path: string): Promise<string>;
    writeFile(path: string, content: string): Promise<void>;
  },
  issue: Issue,
  date: string,
  sourcePath: string,
): Promise<DesignResult> {
  const output = await deps.readFile(sourcePath);
  const { complexity, content } = parseDesignOutput(output);
  const docPath = `${deps.config.designDocDir}/${date}-issue-${issue.number}.md`;
  await deps.writeFile(`${deps.cwd}/${docPath}`, content);
  return { complexity, docPath, docContent: content };
}

export async function runDesign(
  deps: {
    agent: AgentRunner;
    cwd: string;
    config: PipelineConfig;
    writeFile(path: string, content: string): Promise<void>;
  },
  issue: Issue,
  date: string,
): Promise<DesignResult> {
  const output = await deps.agent("claude", buildDesignPrompt(issue), {
    cwd: deps.cwd,
    model: deps.config.reviewModel,
  });
  const { complexity, content } = parseDesignOutput(output);
  const docPath = `${deps.config.designDocDir}/${date}-issue-${issue.number}.md`;
  await deps.writeFile(`${deps.cwd}/${docPath}`, content);
  return { complexity, docPath, docContent: content };
}
