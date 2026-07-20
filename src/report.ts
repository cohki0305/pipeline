export type LintCandidate = { file: string; message: string };

export class RunReport {
  private stages: { name: string; summary: string }[] = [];
  private candidates: LintCandidate[] = [];
  private lows: LintCandidate[] = [];
  private seen = new Set<string>();

  constructor(
    private issueNumber: number,
    private date: string,
  ) {}

  addStage(name: string, summary: string): void {
    this.stages.push({ name, summary });
  }

  addLintCandidate(c: LintCandidate): void {
    if (this.remember(`lint:${c.file}:${c.message}`)) this.candidates.push(c);
  }

  addLowFinding(c: LintCandidate): void {
    if (this.remember(`low:${c.file}:${c.message}`)) this.lows.push(c);
  }

  private remember(key: string): boolean {
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    return true;
  }

  render(): string {
    const lines = [`# issue #${this.issueNumber} パイプライン実行レポート`, "", `日付: ${this.date}`, ""];
    for (const s of this.stages) lines.push(`## ${s.name}`, "", s.summary, "");
    if (this.candidates.length > 0) {
      lines.push("## custom lint 化候補", "");
      for (const c of this.candidates) lines.push(`- ${c.file}: ${c.message}`);
      lines.push("");
    }
    if (this.lows.length > 0) {
      lines.push("## 未対応の low 指摘", "");
      for (const c of this.lows) lines.push(`- ${c.file}: ${c.message}`);
      lines.push("");
    }
    return lines.join("\n");
  }
}
