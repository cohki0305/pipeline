import type { PipelineConfig } from "../config";
import type { Exec } from "../exec";

export type Violation = { file: string; line: number | null; rule: string; message: string };
export type GateResult = { ok: boolean; kind?: "lint" | "test"; violations: Violation[]; raw: string };

const FILE_LINE = /(\S+?\.[a-z]{1,4}):(\d+)/;
const TSC_STYLE = /(\S+?\.[a-z]{1,4})\((\d+),\d+\)/;

export function parseViolations(rule: string, output: string): Violation[] {
  const found: Violation[] = [];
  for (const line of output.split("\n")) {
    const m = line.match(FILE_LINE) ?? line.match(TSC_STYLE);
    if (m) found.push({ file: m[1]!, line: Number(m[2]), rule, message: line.trim() });
  }
  if (found.length === 0 && output.trim()) {
    found.push({ file: "", line: null, rule, message: output.slice(-2000) });
  }
  return found;
}

const CHECKS = [
  { key: "lint", kind: "lint" },
  { key: "typecheck", kind: "lint" },
  { key: "test", kind: "test" },
] as const;

export async function runQualityGate(deps: {
  exec: Exec;
  cwd: string;
  config: PipelineConfig;
}): Promise<GateResult> {
  for (const check of CHECKS) {
    const r = await deps.exec(deps.config.commands[check.key], { cwd: deps.cwd });
    if (r.code !== 0) {
      const raw = `${r.stdout}\n${r.stderr}`;
      return { ok: false, kind: check.kind, violations: parseViolations(check.key, raw), raw };
    }
  }
  return { ok: true, violations: [], raw: "" };
}

export async function runAutoFixLint(deps: {
  exec: Exec;
  cwd: string;
  config: PipelineConfig;
}): Promise<boolean> {
  const cmd = deps.config.autoFixCommands?.lint;
  if (!cmd) return false;
  const r = await deps.exec(cmd, { cwd: deps.cwd });
  return r.code === 0;
}
