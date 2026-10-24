/**
 * One screencast per tab (docs/SIMPLIFICATION.md Batch 16 item 4): the extension has one debugger session per tab,
 * and Chrome runs one `Page.startScreencast` per session, so every consumer shares it. It runs at the largest size
 * and quality any consumer asks for, starts again at a new size when consumers come or go, and stops when none
 * remain. Consumers: the 1×1 screencast that keeps a background tab painting (it takes no frames), a capture
 * recording frames, and anything else that wants a live image of the tab.
 *
 * Frames are acknowledged only while a consumer takes them, so the painting screencast alone sends a few frames and
 * then waits, as it always has. Script events never see them: the extension handles `Page.screencastFrame` before
 * anything reaches a script.
 */

/** One `Page.screencastFrame` event's parameters. */
export type ScreencastFrame = { data: string; sessionId: number; metadata?: Record<string, unknown> };
/** A screencast consumer: the size and JPEG quality it needs, and its frames (none for one that only keeps the tab
 * painting). */
export type ScreencastConsumer = { maxWidth: number; maxHeight: number; quality: number; frame?: (frame: ScreencastFrame) => void };
type Running = { format: 'jpeg'; quality: number; maxWidth: number; maxHeight: number };

/** Sends one DevTools command on the tab's debugger session. */
export type ScreencastSend = (method: string, params?: Record<string, unknown>) => Promise<unknown>;

export class TabScreencast {
  private readonly consumers = new Set<ScreencastConsumer>();
  private running: Running | null = null;
  private changes: Promise<void> = Promise.resolve();
  constructor(private readonly send: ScreencastSend) {}

  /** Adds a consumer; resolves once the screencast runs at a size that covers it. */
  add(consumer: ScreencastConsumer): Promise<void> { this.consumers.add(consumer); return this.update(); }
  /** Removes a consumer; resolves once the screencast runs at the size those left need, or stopped. */
  remove(consumer: ScreencastConsumer): Promise<void> { this.consumers.delete(consumer); return this.update(); }

  /** A `Page.screencastFrame` event: acknowledged once, then given to each consumer that takes frames. */
  frame(frame: ScreencastFrame): void {
    const takers = [...this.consumers].filter(consumer => consumer.frame);
    if (!takers.length) return;
    void this.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {});
    for (const consumer of takers) consumer.frame?.(frame);
  }

  /** Changes run one at a time, each comparing what runs with what the consumers need then. */
  private update(): Promise<void> {
    const change = this.changes.then(async () => {
      const wanted = this.wanted();
      const running = this.running;
      if (wanted && running && wanted.maxWidth === running.maxWidth && wanted.maxHeight === running.maxHeight && wanted.quality === running.quality) return;
      if (!wanted && !running) return;
      if (running) { this.running = null; await this.send('Page.stopScreencast'); }
      if (wanted) { await this.send('Page.startScreencast', wanted); this.running = wanted; }
    });
    this.changes = change.catch(() => {});
    return change;
  }

  private wanted(): Running | null {
    if (!this.consumers.size) return null;
    const all = [...this.consumers];
    return { format: 'jpeg', quality: Math.max(...all.map(consumer => consumer.quality)), maxWidth: Math.max(...all.map(consumer => consumer.maxWidth)), maxHeight: Math.max(...all.map(consumer => consumer.maxHeight)) };
  }
}
