import type { PipelineConfig } from "../config";
import type { Issue } from "../github";
import { planningModelOption, resolvePlanningAgent } from "../planning-agent";
import type { Finding } from "./review";

export type Complexity = "simple" | "complex";
export type DesignResult = { complexity: Complexity; docPath: string; docContent: string };

// ユーザー定義の判断基準。実装時にユーザーに書いてもらう（フォールバック値）
export const COMPLEXITY_CRITERIA = `- simple: リポジトリ内に同型の実装例があり、それを模倣すれば書ける変更（typo・文言修正、既存 lint への追随、既存テーブルへの単純な CRUD 追加、既存エンドポイントと同型のエンドポイント追加、設定値・定数の追加）。ファイル数の多さだけを complex の根拠にしない
- complex: 次のいずれかに該当する場合のみ: 新しい抽象・インターフェースの導入 / DB マイグレーションやデータ移行 / 並行処理・トランザクション境界の変更 / 外部 API との新規連携 / 既存の公開挙動を変えうる横断的リファクタリング
- 判断手順: complex の各条件に該当するか一つずつ確認し、該当したものを計画の冒頭に列挙する。ひとつも該当しなければ simple とする（「なんとなく難しそう」は complex の根拠にしない）`;

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
export async function loadExistingDesign(
  deps: { cwd: string; readFile(path: string): Promise<string> },
  docPath: string,
): Promise<DesignResult> {
  const output = await deps.readFile(`${deps.cwd}/${docPath}`);
  const { complexity, content } = parseDesignOutput(output);
  return { complexity, docPath, docContent: content };
}

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

export function nextRevision(content: string): number {
  const fm = content.trimStart().match(/^---\n([\s\S]*?)\n---/);
  const m = fm?.[1]?.match(/revision:\s*(\d+)/);
  return m ? Number(m[1]) + 1 : 2;
}

export function appendReviewFindings(currentContent: string, findings: Finding[]): string {
  const ids = findings.map((finding) => finding.id ?? `${finding.file}:${finding.line ?? "?"}`).join(",");
  const marker = `<!-- agent-pipeline-review:${ids} -->`;
  // state 保存前にプロセスが落ちても、同じ指摘を resume した際に設計追記を重複させない。
  if (currentContent.includes(marker)) return currentContent;

  const revision = nextRevision(currentContent);
  const withRevision = currentContent.replace(/^---\n([\s\S]*?)\n---/, (_frontmatter, body: string) => {
    const revisedBody = /(^|\n)revision:\s*\d+/.test(body)
      ? body.replace(/(^|\n)revision:\s*\d+/, `$1revision: ${revision}`)
      : `${body}\nrevision: ${revision}`;
    return `---\n${revisedBody}\n---`;
  });

  const items = findings
    .map(
      (finding) =>
        `- ${finding.id ?? "(id なし)"}: ${finding.message}（${finding.file}${finding.line == null ? "" : `:${finding.line}`}）`,
    )
    .join("\n");
  return `${withRevision.trimEnd()}\n\n## レビュー反映（revision ${revision}）\n\n${marker}\n${items}\n`;
}

export async function reviseDesignFromReview(
  deps: {
    cwd: string;
    writeFile(path: string, content: string): Promise<void>;
  },
  design: DesignResult,
  findings: Finding[],
): Promise<DesignResult> {
  const content = appendReviewFindings(design.docContent, findings);
  await deps.writeFile(`${deps.cwd}/${design.docPath}`, content);
  return { complexity: design.complexity, docPath: design.docPath, docContent: content };
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
  const agent = resolvePlanningAgent(deps.config);
  const output = await deps.agent(agent, buildDesignPrompt(issue), {
    cwd: deps.cwd,
    model: planningModelOption(deps.config, agent),
  });
  const { complexity, content } = parseDesignOutput(output);
  const docPath = `${deps.config.designDocDir}/${date}-issue-${issue.number}.md`;
  await deps.writeFile(`${deps.cwd}/${docPath}`, content);
  return { complexity, docPath, docContent: content };
}
