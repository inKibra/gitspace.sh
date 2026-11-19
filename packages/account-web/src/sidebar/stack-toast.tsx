import { AnimatePresence, motion } from 'framer-motion';
import { createContext, useContext, useEffect, useMemo, useState, type ReactElement, type ReactNode } from 'react';
import { STATUS_COLOR } from '../GitSpaceShell.js';
import { rpcErrorMessage } from '../rpc-error-message.js';
import { TOAST_HIDE_MS } from '../toasts.js';

/** What the pill says: an applied change and how to take it back (null when it can't be), or why a change (or its
 * undo) was refused. */
type StackToast = { text: string; undo: (() => Promise<void>) | null; refused: boolean };

/** Every stack, relation and phase change the person makes reports here. */
export interface StackToastApi {
  /** A change landed: says what it did, with Undo when `undo` (the reverse, through the same API) is given. */
  applied(text: string, undo: (() => Promise<void>) | null): void;
  /** A change or its undo was refused: says why. */
  refused(failure: unknown, operation: string): void;
  /** Hides the pill, as choosing in the list does. */
  clear(): void;
}

const StackToastContext = createContext<StackToastApi | null>(null);

/** The pill at the bottom left (across the bottom on a phone) that reports stack, relation and phase changes. Nested
 * inside another it adds nothing, so the sidebar and the pane header share one. */
export function StackToasts({ children }: { children: ReactNode }): ReactElement {
  const outer = useContext(StackToastContext);
  const [toast, setToast] = useState<StackToast | null>(null);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), TOAST_HIDE_MS);
    return () => window.clearTimeout(timer);
  }, [toast]);
  const api = useMemo((): StackToastApi => ({
    applied: (text, undo) => setToast({ text, undo, refused: false }),
    refused: (failure, operation) => setToast({ text: rpcErrorMessage(failure, operation), undo: null, refused: true }),
    clear: () => setToast(null),
  }), []);
  if (outer) return <>{children}</>;
  const undo = async (): Promise<void> => {
    if (!toast?.undo || pending) return;
    setPending(true);
    try { await toast.undo(); setToast(null); } catch (failure) { api.refused(failure, 'Undo'); } finally { setPending(false); }
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
