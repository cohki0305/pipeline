import type { AgentRunner } from "../agents";
import type { PipelineConfig } from "../config";
import type { Exec } from "../exec";
import { planningModelOption, resolvePlanningAgent } from "../planning-agent";

const TYPES = ["feat", "fix", "refactor", "perf", "test", "docs", "chore"] as const;
const VAGUE_SUBJECTS = new Set([
  "バグ修正",
  "レビュー指摘を修正",
  "レビュー反映を実装",
  "レビューコメントに対応",
  "PR コメントと CI 失敗に一括対応",
  "CI 失敗に対応",
  "コンフリクトを解消",
  "コードを修正",
  "ファイルを更新",
  "機能を追加",
]);

export type CommitPurpose = "initial" | "review" | "feedback" | "conflict";
export type CommitReference = { kind: "issue" | "pr"; number: number };

export function buildCommitMessagePrompt(args: {
  reference: CommitReference;
  purpose: CommitPurpose;
  context?: string;
  evidence?: string;
}): string {
  const target = args.reference.kind === "issue" ? `issue #${args.reference.number}` : `PR #${args.reference.number}`;
  const purpose = {
    initial: "実装全体で何を変え、利用者やシステムの挙動をどう改善したか",
    review: "レビューで判明した具体的な問題と、どの挙動を保証するよう修正したか",
    feedback: "PR コメントまたは CI 失敗を受けて、どのコードや挙動をどう修正したか",
    conflict: "競合した双方の意図をどのように統合し、どの挙動を維持したか",
  }[args.purpose];
  const context = args.context ? `\n## 作業の背景\n${args.context.slice(0, 20_000)}\n` : "";
  const evidence = args.evidence ? `\n## Gitで取得した現在の差分\n${args.evidence}\n` : "";

  return `${target} の現在の未コミット差分に付けるコミットメッセージを作成せよ。

以下に埋め込まれた git status / diff を根拠に、${purpose}が分かる内容にすること。コードやファイルは変更せず、コミットメッセージだけを出力すること。${context}${evidence}
出力形式:
<type>: <subject>

<body>

要件:
- type は feat / fix / refactor / perf / test / docs / chore のいずれか
- subject は日本語50文字以内で、実際に何をどう変えたか具体的に書く
- body は WHY（背景・解決する問題）を中心に、重要な WHAT を補足する
- subject と body の間は空行にする
- Markdown、引用符、Co-Authored-By、issue・PR番号は付けない（関連番号はpipelineが追加する）
- 「レビュー反映を実装」「レビューコメントに対応」「CI失敗に対応」のような作業名だけの文言は禁止
- ファイル名の羅列ではなく、変更によって保証される挙動を先に表す
`;
}

export async function hasUncommittedChanges(
  deps: { exec: Exec; cwd: string },
  opts: { sinceSha?: string } = {},
): Promise<boolean> {
  if (opts.sinceSha) {
    const [diff, untracked] = await Promise.all([
      deps.exec(`git diff --name-only ${opts.sinceSha}`, { cwd: deps.cwd }),
      deps.exec("git ls-files -o --exclude-standard", { cwd: deps.cwd }),
    ]);
    if (diff.code !== 0) throw new Error(`変更の有無確認に失敗: ${diff.stderr}`);
    if (untracked.code !== 0) throw new Error(`未追跡ファイルの確認に失敗: ${untracked.stderr}`);
    return Boolean(diff.stdout.trim() || untracked.stdout.trim());
  }
  const status = await deps.exec("git status --porcelain", { cwd: deps.cwd });
  if (status.code !== 0) throw new Error(`変更の有無確認に失敗: ${status.stderr}`);
  return Boolean(status.stdout.trim());
}

export async function collectCommitEvidence(deps: { exec: Exec; cwd: string }): Promise<string> {
  const untracked = await deps.exec("git ls-files -o --exclude-standard", { cwd: deps.cwd });
  if (untracked.code !== 0) throw new Error(`未追跡ファイルの確認に失敗: ${untracked.stderr}`);
  if (untracked.stdout.trim()) {
    const add = await deps.exec("git add -N .", { cwd: deps.cwd });
    if (add.code !== 0) throw new Error(`未追跡ファイルの intent-to-add に失敗: ${add.stderr}`);
  }
  const [status, unstaged, staged] = await Promise.all([
    deps.exec("git status --short", { cwd: deps.cwd }),
    deps.exec("git diff --no-ext-diff", { cwd: deps.cwd }),
    deps.exec("git diff --cached --no-ext-diff", { cwd: deps.cwd }),
  ]);
  if (status.code !== 0 || unstaged.code !== 0 || staged.code !== 0) {
    throw new Error(`コミット用差分の取得に失敗: ${status.stderr || unstaged.stderr || staged.stderr}`);
  }
  return [
    `### git status --short\n${status.stdout}`,
    `### git diff\n${unstaged.stdout}`,
    `### git diff --cached\n${staged.stdout}`,
  ].join("\n").slice(0, 50_000);
}

// エージェントがメッセージを前置き・解説付きのコードフェンスで包んで返すことがある
// （output style 混入等）。フェンスがあればその中身をメッセージ候補として採用する
export function extractCommitMessageCandidate(output: string): string {
  const fence = output.match(/```[^\n]*\n([\s\S]*?)```/);
  return (fence ? fence[1]! : output).trim();
}

export function validateCommitMessage(output: string): string {
  const message = output.trim();
  const lines = message.split("\n");
  const firstLine = lines[0] ?? "";
  const separator = lines[1];
  const body = lines.slice(2).join("\n").trim();
  const match = firstLine.match(/^([a-z]+): (.+)$/);
  const type = match?.[1];
  const subject = match?.[2] ?? "";
  if (
    !type ||
    !TYPES.includes(type as (typeof TYPES)[number]) ||
    subject.length < 6 ||
    subject.length > 50 ||
    VAGUE_SUBJECTS.has(subject) ||
    separator !== "" ||
    body.length < 15 ||
    message.includes("Co-Authored-By:") ||
    /issue\s*#|PR\s*#|関連:\s*#/i.test(message) ||
    message.startsWith("`")
  ) {
    throw new Error(`不正なコミットメッセージです: ${JSON.stringify(message)}`);
  }
  return message;
}

export async function runCommitMessage(
  deps: { agent: AgentRunner; config: PipelineConfig; exec: Exec; cwd: string },
  args: { reference: CommitReference; purpose: CommitPurpose; context?: string },
): Promise<string> {
  const evidence = await collectCommitEvidence(deps);
  const agent = resolvePlanningAgent(deps.config);
  const output = await deps.agent(agent, buildCommitMessagePrompt({ ...args, evidence }), {
    cwd: deps.cwd,
    model: planningModelOption(deps.config, agent),
  });
  const reference = args.reference.kind === "issue" ? `#${args.reference.number}` : `PR #${args.reference.number}`;
  return `${validateCommitMessage(extractCommitMessageCandidate(output))}\n\n関連: ${reference}`;
}
