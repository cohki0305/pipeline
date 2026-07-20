// イベントのバースト（レビュー提出 = コメント N 件が同時到着）を 1 回の実行にまとめる
export class RunCoalescer {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private pending = false;

  constructor(
    private run: () => Promise<void>,
    private debounceMs: number,
  ) {}

  trigger(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.start();
    }, this.debounceMs);
  }

  private async start(): Promise<void> {
    if (this.running) {
      this.pending = true;
      return;
    }
    this.running = true;
    try {
      await this.run();
    } finally {
      this.running = false;
      if (this.pending) {
        this.pending = false;
        void this.start();
      }
    }
  }
}
