// What a row's action holds for Undo (docs/INBOX-DESIGN.md decision 5a): the call waits in this tab for six seconds,
// then goes; it goes at once when the page is hidden or left. Undo inside the window drops it, and nothing was sent.
import { useSyncExternalStore } from 'react';

export const UNDO_MS = 6_000;

/** A held action: the cleared row's outcome and what it is about, when it was cleared, and the call it holds. */
export interface HeldAction { label: string; about: string; at: number; run(): Promise<void> }

/** The tab's held actions by row key; the keys whose call went (their rows stay cleared until the source's next report
 * drops them); and the calls that failed, with why, so their rows show again. */
export class HeldActions {
  private readonly held = new Map<string, HeldAction & { timer: number }>();
  private readonly sent = new Set<string>();
  private readonly failed = new Map<string, string>();
  private readonly listeners = new Set<() => void>();
  private version = 0;

  constructor(target: Pick<Window, 'addEventListener'> = window) {
    // Hidden or left: what is held goes now, since the tab may never run its timers again.
    target.addEventListener('pagehide', () => this.flush());
    target.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') this.flush(); });
  }

  /** Holds `run` for `UNDO_MS`, replacing an earlier hold of the same row. */
  hold(key: string, action: Omit<HeldAction, 'at'>): void {
    const previous = this.held.get(key);
    if (previous) window.clearTimeout(previous.timer);
    this.failed.delete(key);
    this.held.set(key, { ...action, at: Date.now(), timer: window.setTimeout(() => void this.send(key), UNDO_MS) });
    this.changed();
  }

  /** Drops a held action: nothing was sent. */
  undo(key: string): void {
    const entry = this.held.get(key);
    if (!entry) return;
    window.clearTimeout(entry.timer);
    this.held.delete(key);
    this.changed();
  }

  /** Sends every held action now. */
  flush(): void {
    for (const key of [...this.held.keys()]) void this.send(key);
  }

  private async send(key: string): Promise<void> {
    const entry = this.held.get(key);
    if (!entry) return;
    window.clearTimeout(entry.timer);
    this.held.delete(key);
    this.sent.add(key);
    this.changed();
    try { await entry.run(); }
    catch (cause) {
      this.sent.delete(key);
      this.failed.set(key, cause instanceof Error ? cause.message : String(cause));
      this.changed();
    }
  }

  /** The row's state in this tab: held (with its outcome), sent, failed (with why), or none. */
  state(key: string): { kind: 'held'; action: HeldAction } | { kind: 'sent' } | { kind: 'failed'; error: string } | null {
    const held = this.held.get(key);
    if (held) return { kind: 'held', action: held };
    if (this.sent.has(key)) return { kind: 'sent' };
    const error = this.failed.get(key);
    return error === undefined ? null : { kind: 'failed', error };
  }

  /** Held or sent: the row does not count, and shows only as cleared or not at all. */
  cleared(key: string): boolean {
    return this.held.has(key) || this.sent.has(key);
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  revision = (): number => this.version;

  private changed(): void {
    this.version += 1;
    for (const listener of [...this.listeners]) listener();
  }
}

let tabActions: HeldActions | null = null;

/** Re-renders on every change to the held actions; returns the tab's store, made on first use. */
export function useHeldActions(): HeldActions {
  tabActions ??= new HeldActions();
  useSyncExternalStore(tabActions.subscribe, tabActions.revision, tabActions.revision);
  return tabActions;
}
