// .agent-pipeline.json の babysitBranches（コメント対応の対象ブランチ glob）を編集する

const SAFE_PATTERN = /^[A-Za-z0-9*][A-Za-z0-9._/*-]{0,200}$/;
const DEFAULT_PATTERNS = ["issue-*"];

export function updateBabysitBranches(
  config: Record<string, unknown>,
  op: "add" | "remove",
  pattern: string,
): Record<string, unknown> {
  if (!SAFE_PATTERN.test(pattern)) throw new Error(`不正なパターンです: ${JSON.stringify(pattern)}`);
  const current = Array.isArray(config.babysitBranches) ? (config.babysitBranches as string[]) : [...DEFAULT_PATTERNS];
  const next = op === "add" ? (current.includes(pattern) ? current : [...current, pattern]) : current.filter((p) => p !== pattern);
  return { ...config, babysitBranches: next };
}
