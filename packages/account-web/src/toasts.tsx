import { createContext, useContext, useEffect, useId, useState, useSyncExternalStore, type ReactElement, type ReactNode } from 'react';
import { Button } from '@gitspace/ui';
import { XClose } from '@untitledui/icons';

/** The one way the main panel's chrome reports a notice, warning or error: a dismissable toast at the top of the app.
 * Toasts float over the page and never move its layout. */
export type ToastTone = 'info' | 'warning' | 'error';

export interface Toast {
  /** The condition's identity. Dismissing hides the toast while the caller keeps reporting this key; once the key is
   * no longer reported, the dismissal is forgotten and the toast shows again if the condition recurs. */
  key: string;
  tone: ToastTone;
  message: ReactNode;
  action?: { label: string; onClick(): void; pending?: boolean };
  /** A standing condition (offline, access missing) stays until dismissed or resolved. Without it the toast reports an
   * event (an action failed) and hides itself after `TOAST_HIDE_MS`. */
  persistent?: boolean;
  /** Called when the person dismisses the toast, e.g. to clear the state that reports it. */
  onDismiss?(): void;
}

export const TOAST_HIDE_MS = 8_000;
/** Toasts shown at once, newest first; the rest are counted. */
export const TOAST_VISIBLE = 3;

/** The workspace status dot's blue, orange and red. */
const TONE_COLOR: Record<ToastTone, string> = { info: '#3b82f6', warning: '#f97316', error: '#ef4444' };

interface Entry { owner: string; toast: Toast; seq: number; timer: number | null }

class ToastStore {
  private readonly owned = new Map<string, Map<string, Entry>>();
  private readonly dismissed = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private seq = 0;
  private shown: readonly Entry[] = [];

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  readonly current = (): readonly Entry[] => this.shown;

  /** Replaces what `owner` reports: new keys open, kept keys update in place, missing keys close. */
  sync(owner: string, toasts: readonly Toast[]): void {
    const before = this.owned.get(owner) ?? new Map<string, Entry>();
    const after = new Map<string, Entry>();
    for (const toast of toasts) {
      const kept = before.get(toast.key);
      if (kept) { kept.toast = toast; after.set(toast.key, kept); continue; }
      const entry: Entry = { owner, toast, seq: ++this.seq, timer: null };
      if (!toast.persistent) entry.timer = window.setTimeout(() => this.dismiss(toast.key), TOAST_HIDE_MS);
      after.set(toast.key, entry);
    }
    if (after.size) this.owned.set(owner, after);
    else this.owned.delete(owner);
    for (const [key, entry] of before) if (!after.has(key)) this.close(entry);
    this.publish();
  }

  drop(owner: string): void {
    const entries = this.owned.get(owner);
    this.owned.delete(owner);
    for (const entry of entries?.values() ?? []) this.close(entry);
    this.publish();
  }

  dismiss(key: string): void {
    this.dismissed.add(key);
    this.publish();
  }

  /** A dismissal is forgotten once no caller reports its key. */
  private close(entry: Entry): void {
    if (entry.timer !== null) window.clearTimeout(entry.timer);
    const key = entry.toast.key;
    if (![...this.owned.values()].some((entries) => entries.has(key))) this.dismissed.delete(key);
  }

  /** Newest first; callers reporting the same key show it once. */
  private publish(): void {
    const seen = new Set<string>();
    this.shown = [...this.owned.values()].flatMap((entries) => [...entries.values()])
      .filter((entry) => !this.dismissed.has(entry.toast.key))
      .sort((left, right) => right.seq - left.seq)
      .filter((entry) => {
        if (seen.has(entry.toast.key)) return false;
        seen.add(entry.toast.key);
        return true;
      });
    for (const listener of this.listeners) listener();
  }
}

const ToastContext = createContext<ToastStore | null>(null);

/** Provides the toast area. Nested inside another `Toasts` it adds nothing, so a view rendered on its own (a test, a
 * mock page) and the same view inside the app share one area. */
export function Toasts({ children }: { children: ReactNode }): ReactElement {
  const outer = useContext(ToastContext);
  const [store] = useState(() => new ToastStore());
  if (outer) return <>{children}</>;
  return <ToastContext.Provider value={store}>{children}<ToastStack store={store} /></ToastContext.Provider>;
}

/** Reports the caller's current conditions as toasts. Pass `null` for a condition that does not hold. */
export function useToasts(toasts: readonly (Toast | null)[]): void {
  const store = useContext(ToastContext);
  if (!store) throw new Error('useToasts needs a <Toasts> provider above it.');
  const owner = useId();
  useEffect(() => { store.sync(owner, toasts.filter((toast): toast is Toast => toast !== null)); });
  useEffect(() => () => store.drop(owner), [store, owner]);
}

function ToastStack({ store }: { store: ToastStore }): ReactElement | null {
  const entries = useSyncExternalStore(store.subscribe, store.current, store.current);
  if (!entries.length) return null;
  const hidden = entries.length - TOAST_VISIBLE;
  return <section aria-label="Notifications" data-toasts className="pointer-events-none fixed inset-x-0 top-[var(--app-notice-top)] z-50 mx-auto flex w-fit max-w-[calc(100%-1.5rem)] flex-col items-center gap-2">
    {entries.slice(0, TOAST_VISIBLE).map(({ owner, toast }) => <div key={`${owner}\u0000${toast.key}`} role={toast.tone === 'info' ? 'status' : 'alert'} data-tone={toast.tone} className="pointer-events-auto flex w-full max-w-2xl items-center gap-2 rounded-lg bg-surface-3 py-1 pl-3 pr-1 text-caption text-foreground shadow-surface-3">
      <span className="status-dot" style={{ color: TONE_COLOR[toast.tone] }} aria-hidden />
      <div className="max-h-40 min-w-0 flex-1 overflow-y-auto whitespace-pre-wrap py-1 [overflow-wrap:anywhere]">{toast.message}</div>
      {/* The label stays readable while the action runs (a spinner would replace it); a long label is cut at the cap and
          keeps its full text as the button's name and tooltip. */}
      {toast.action ? <Button variant="ghost" size="compact" className="max-w-56 shrink-0 [&_span_span]:block [&_span_span]:overflow-x-clip [&_span_span]:text-ellipsis [&_span_span]:whitespace-nowrap" title={toast.action.label} aria-label={toast.action.label} aria-busy={toast.action.pending || undefined} disabled={toast.action.pending} onClick={toast.action.onClick}>{toast.action.label}</Button> : null}
      <Button variant="ghost" size="icon-compact" className="shrink-0" aria-label="Dismiss" onClick={() => { store.dismiss(toast.key); toast.onDismiss?.(); }}><XClose width={14} height={14} strokeWidth={1.5} /></Button>
    </div>)}
    {hidden > 0 ? <p className="pointer-events-auto rounded-lg bg-surface-3 px-3 py-1 text-caption text-muted-foreground shadow-surface-3">{hidden} more</p> : null}
  </section>;
}
