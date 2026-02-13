export interface FeedTarget {
  feed(data: Buffer): void;
}

/**
 * Buffers script output until the terminal mount is available.
 *
 * Important: only pending (not-yet-rendered) output is buffered, so ref churn
 * or rerenders do not replay already-rendered content.
 */
export class ScriptTerminalBuffer {
  private target: FeedTarget | null = null;
  private pending: Buffer[] = [];

  setTarget(next: FeedTarget | null): void {
    const justMounted = this.target === null && next !== null;
    this.target = next;

    if (!next || !justMounted || this.pending.length === 0) {
      return;
    }

    const buffered = Buffer.concat(this.pending);
    this.pending = [];
    next.feed(buffered);
  }

  feed(data: Uint8Array): void {
    const chunk = Buffer.from(data);
    if (this.target) {
      this.target.feed(chunk);
      return;
    }

    this.pending.push(chunk);
  }
}
