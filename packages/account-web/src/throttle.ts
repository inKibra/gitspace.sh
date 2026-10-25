/** Sends at most once per interval; the latest value waiting is sent when the interval ends. */
export class Throttle<T> {
  private last = Number.NEGATIVE_INFINITY;
  private timer: number | undefined;
  private waiting: { value: T } | null = null;
  constructor(private readonly interval: number, private readonly emit: (value: T) => void) {}
  push(value: T): void {
    const wait = this.last + this.interval - Date.now();
    if (wait <= 0 && this.timer === undefined) {
      this.last = Date.now();
      this.emit(value);
      return;
    }
    this.waiting = { value };
    this.timer ??= window.setTimeout(() => {
      this.timer = undefined;
      const waiting = this.waiting;
      this.waiting = null;
      if (!waiting) return;
      this.last = Date.now();
      this.emit(waiting.value);
    }, Math.max(0, wait));
  }
  cancel(): void {
    window.clearTimeout(this.timer);
    this.timer = undefined;
    this.waiting = null;
  }
}
