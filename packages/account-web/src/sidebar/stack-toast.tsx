import { AnimatePresence, motion } from 'framer-motion';
import { createContext, useContext, useEffect, useMemo, useState, type ReactElement, type ReactNode } from 'react';
import { STATUS_COLOR } from '../GitSpaceShell.js';
import { rpcErrorMessage } from '../rpc-error-message.js';
import { TOAST_HIDE_MS } from '../toasts.js';

/** How a change is taken back: resolves when it is, to what the pill says next (nothing: the pill hides). */
export type StackUndo = () => Promise<string | void>;

/** What the pill says: an applied change and how to take it back (null when it can't be), or why a change (or its
 * undo) was refused. `id` tells one change's pill from the next. */
type StackToast = { id: number; text: string; undo: StackUndo | null; refused: boolean };

/** Every stack, relation and phase change the person makes reports here. */
export interface StackToastApi {
  /** A change landed (or started): says what it did, with Undo when `undo` (the reverse, through the same API) is
   * given. Returns what rewrites the text while the pill still shows this change, its Undo kept. */
  applied(text: string, undo: StackUndo | null): (text: string) => void;
  /** A change or its undo was refused: says why. */
  refused(failure: unknown, operation: string): void;
  /** Hides the pill, as choosing in the list does. */
  clear(): void;
}

const StackToastContext = createContext<StackToastApi | null>(null);

/** The pill at the bottom left (across the bottom on a phone) that reports stack, relation and phase changes. Nested
 * inside another it adds nothing, so the sidebar and the pane header share one. A rewrite starts its time over. */
export function StackToasts({ children }: { children: ReactNode }): ReactElement {
  const outer = useContext(StackToastContext);
  const [toast, setToast] = useState<StackToast | null>(null);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), TOAST_HIDE_MS);
    return () => window.clearTimeout(timer);
  }, [toast]);
  const api = useMemo((): StackToastApi => {
    let shown = 0;
    return {
      applied: (text, undo) => {
        const id = ++shown;
        setToast({ id, text, undo, refused: false });
        return (revised) => setToast((current) => current?.id === id ? { ...current, text: revised } : current);
      },
      refused: (failure, operation) => setToast({ id: ++shown, text: rpcErrorMessage(failure, operation), undo: null, refused: true }),
      clear: () => setToast(null),
    };
  }, []);
  if (outer) return <>{children}</>;
  const undo = async (): Promise<void> => {
    if (!toast?.undo || pending) return;
    setPending(true);
    try {
      const after = await toast.undo();
      if (after) api.applied(after, null);
      else setToast(null);
    } catch (failure) { api.refused(failure, 'Undo'); } finally { setPending(false); }
  };
  return <StackToastContext.Provider value={api}>
    {children}
    {/* Above the phone drawer (the kit's sheet sits at z-50), so a change made in the drawer shows its Undo there. */}
    <div className="pointer-events-none fixed inset-x-3 bottom-3 z-[60] sm:right-auto sm:w-[280px] [&>*]:pointer-events-auto">
      <AnimatePresence>
        {toast ? <motion.div key="stack-toast" role={toast.refused ? 'alert' : 'status'} data-stack-toast="" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }} transition={{ duration: 0.18 }}
          className="flex min-h-9 items-center gap-3 rounded-[14px] bg-foreground px-3 py-1.5 text-caption text-background shadow-lg">
          {toast.refused ? <span className="size-1.5 shrink-0 rounded-full" style={{ background: STATUS_COLOR.red }} aria-hidden /> : null}
          <span className="min-w-0 flex-1 leading-snug">{toast.text}</span>
          {toast.undo ? <button type="button" className="shrink-0 font-medium opacity-90 hover:opacity-100 disabled:opacity-50" disabled={pending} onClick={() => void undo()}>Undo</button>
            : <button type="button" className="shrink-0 font-medium opacity-90 hover:opacity-100" onClick={api.clear}>Dismiss</button>}
        </motion.div> : null}
      </AnimatePresence>
    </div>
  </StackToastContext.Provider>;
}

export function useStackToast(): StackToastApi {
  const api = useContext(StackToastContext);
  if (!api) throw new Error('useStackToast needs a <StackToasts> provider above it.');
  return api;
}
