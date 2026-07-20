export type StatusCheck = {
  __typename: string;
  name: string;
  conclusion: string | null;
  detailsUrl?: string | null;
};

export const CI_FAILURE_CONCLUSIONS = new Set([
  "FAILURE",
  "TIMED_OUT",
  "STARTUP_FAILURE",
  "ACTION_REQUIRED",
]);

export function findFailedChecks(checks: StatusCheck[]): StatusCheck[] {
  return checks.filter((check) => check.conclusion != null && CI_FAILURE_CONCLUSIONS.has(check.conclusion));
}

export function extractWorkflowRunId(detailsUrl: string): number | null {
  const match = detailsUrl.match(/\/actions\/runs\/(\d+)/);
  if (!match?.[1]) return null;
  const runId = Number(match[1]);
  return Number.isInteger(runId) && runId > 0 ? runId : null;
}

export function pickWorkflowRunId(checks: StatusCheck[]): number | null {
  for (const check of checks) {
    if (!check.detailsUrl) continue;
    const runId = extractWorkflowRunId(check.detailsUrl);
    if (runId != null) return runId;
  }
  return null;
}

export function trimCiLog(log: string, maxChars = 12_000): string {
  if (log.length <= maxChars) return log;
  return log.slice(-maxChars);
}

export function buildCiFailurePrompt(failedChecks: { name: string }[], logs: string): string {
  const names = failedChecks.map((check) => check.name).join(", ");
  return `以下は GitHub PR の CI 失敗ログです（失敗チェック: ${names}）。この PR のスコープ内で原因を修正せよ。CI ワークフロー自体を緩めたり無関係な変更はしない。リストにない問題は触らない。git commit はしない。

\`\`\`
${trimCiLog(logs)}
\`\`\``;
}
