import type { AgentRunner } from "../agents";
import type { PipelineConfig } from "../config";
import type { Exec } from "../exec";

export type Severity = "critical" | "high" | "medium" | "low";
export type Finding = {
  id?: string | null;
  file: string;
  line: number | null;
  severity: Severity;
  message: string;
  lintable: boolean;
};

// low は修正ループを止めず、実行レポート送りにする（Bugbot 方式の severity ゲート）
export const BLOCKING_SEVERITIES: ReadonlySet<Severity> = new Set(["critical", "high", "medium"]);

export function isBlocking(f: Finding): boolean {
  return BLOCKING_SEVERITIES.has(f.severity);
}

export function assignIds(findings: Finding[], round: number): Finding[] {
  return findings.map((f, i) => ({ ...f, id: f.id ?? `R${round}-${i + 1}` }));
}

// headless claude は Bash 実行許可を持たないため diff はパイプライン側で取得して埋め込む
const MAX_DIFF_CHARS = 50_000;

type ReviewDeps = { agent: AgentRunner; exec: Exec; cwd: string; config: PipelineConfig };

async function getDiff(deps: ReviewDeps): Promise<string> {
  const d = await deps.exec(`git diff ${deps.config.baseBranch}...HEAD`, { cwd: deps.cwd });
  if (d.code !== 0) throw new Error(`git diff に失敗: ${d.stderr}`);
  return d.stdout.length > MAX_DIFF_CHARS ? `${d.stdout.slice(0, MAX_DIFF_CHARS)}\n...（以降省略）` : d.stdout;
}

export function buildReviewPrompt(baseBranch: string, diff: string): string {
  return `あなたはこのリポジトリのコードレビュー担当。以下の \`git diff ${baseBranch}...HEAD\` の変更を読み、リポジトリの CLAUDE.md 規約への違反・バグ・設計上の問題を指摘せよ。必要ならリポジトリ内のファイルを読んで文脈を確認してよい。

出力は JSON 配列のみ。前置き・後書き・コードフェンスは不要。指摘がなければ [] とだけ出力する。
各要素の形式:
{"file": "リポジトリ相対パス", "line": 行番号または null, "severity": "critical|high|medium|low", "message": "指摘内容と修正方針", "lintable": 静的解析で機械的に検知できる規約違反なら true}

severity の基準: correctness・セキュリティ・データ破壊に関わるものは critical/high、規約違反や設計問題は medium、好みや微改善は low。

## diff

${diff}`;
}

export async function runReview(deps: ReviewDeps): Promise<Finding[]> {
  const diff = await getDiff(deps);
  const output = await deps.agent("claude", buildReviewPrompt(deps.config.baseBranch, diff), { cwd: deps.cwd });
  return parseFindings(output);
}

export function parseFindings(output: string): Finding[] {
  // LLM 出力の前置き/後書きに [ ] が混ざっても壊れないよう、フェンス優先 + 括弧バランス走査で抽出する
  const fence = output.match(/```(?:json)?\s*([\s\S]*?)```/);
  const sources = fence ? [fence[1] ?? "", output] : [output];
  for (const source of sources) {
    for (let start = source.indexOf("["); start !== -1; start = source.indexOf("[", start + 1)) {
      const candidate = sliceBalanced(source, start, "[", "]");
      if (candidate === null) continue;
      try {
        const parsed = JSON.parse(candidate);
        if (Array.isArray(parsed) && parsed.every(isFinding)) return parsed as Finding[];
      } catch {}
    }
  }
  throw new Error(`レビュー出力に JSON 配列がありません: ${output.slice(0, 300)}`);
}

export type FollowupResult = { fixed: string[]; remaining: Finding[] };

export function buildFollowupPrompt(baseBranch: string, diff: string, outstanding: Finding[]): string {
  return `あなたはこのリポジトリのコードレビュー担当。前回の指摘に対して修正が行われた。以下の \`git diff ${baseBranch}...HEAD\` を読み、前回指摘リストの各項目が解消されたかを id ごとに判定せよ。加えて、修正が新たに持ち込んだ問題があれば remaining に追加せよ（correctness・規約違反・セキュリティに関わるもののみ。スタイルの些細な指摘は不要）。

出力は JSON オブジェクトのみ。前置き・後書き・コードフェンスは不要。形式:
{"fixed": ["解消された指摘の id"], "remaining": [{"id": "未解消なら元の id、新規なら null", "file": "リポジトリ相対パス", "line": 行番号または null, "severity": "critical|high|medium|low", "message": "指摘内容と修正方針", "lintable": 静的解析で機械的に検知できる規約違反なら true}]}

## 前回の指摘

${JSON.stringify(outstanding, null, 2)}

## diff

${diff}`;
}

export function parseFollowupOutput(output: string): FollowupResult {
  const fence = output.match(/```(?:json)?\s*([\s\S]*?)```/);
  const sources = fence ? [fence[1] ?? "", output] : [output];
  for (const source of sources) {
    for (let start = source.indexOf("{"); start !== -1; start = source.indexOf("{", start + 1)) {
      const candidate = sliceBalanced(source, start, "{", "}");
      if (candidate === null) continue;
      try {
        const parsed = JSON.parse(candidate);
        if (parsed && typeof parsed === "object" && Array.isArray(parsed.remaining)) {
          const fixed = Array.isArray(parsed.fixed)
            ? parsed.fixed.filter((x: unknown): x is string => typeof x === "string")
            : [];
          return { fixed, remaining: parsed.remaining.filter(isFinding) as Finding[] };
        }
      } catch {}
    }
  }
  throw new Error(`消し込みレビュー出力に JSON オブジェクトがありません: ${output.slice(0, 300)}`);
}

export async function runFollowupReview(deps: ReviewDeps, outstanding: Finding[]): Promise<FollowupResult> {
  const diff = await getDiff(deps);
  const output = await deps.agent("claude", buildFollowupPrompt(deps.config.baseBranch, diff, outstanding), {
    cwd: deps.cwd,
  });
  return parseFollowupOutput(output);
}

function isFinding(x: unknown): boolean {
  return (
    typeof x === "object" && x !== null && typeof (x as Finding).file === "string" && typeof (x as Finding).message === "string"
  );
}

function sliceBalanced(text: string, start: number, open: string, close: string): string | null {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}
