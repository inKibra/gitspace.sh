/** @jsxImportSource react */
import { useMemo, useState, type ReactElement } from 'react';
import type { AgentHistoryEntry } from '../agents/agent-runtime-types.js';

/**
 * Conversation history — the user-message checkpoints in the current branch.
 * Click one to rewind the conversation to that turn (navigateTree); the prior
 * path is preserved as a branch, so this is non-destructive.
 */
export function AgentHistoryPanel({
  entries,
  loading,
  onNavigate,
  onClose,
}: {
  entries: AgentHistoryEntry[];
  loading: boolean;
  onNavigate: (entryId: string) => void;
  onClose: () => void;
}): ReactElement {
  const [filter, setFilter] = useState('');
  // newest first
  const rows = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return [...entries].reverse().filter((e) => !f || e.text.toLowerCase().includes(f));
  }, [entries, filter]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/50" />
      <div
        className="relative z-10 flex max-h-[72vh] w-[480px] flex-col border border-[var(--gs-border)] bg-[var(--gs-bg-elevated)] text-[12px] shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[var(--gs-border)] px-4 py-2.5 text-[13px]">
          <span className="font-[family-name:var(--gs-font)] text-[var(--gs-text)]">History — click a turn to rewind</span>
          <button type="button" onClick={onClose} className="text-[var(--gs-text-dim)] hover:text-[var(--gs-text)]">✕</button>
        </div>
        <div className="border-b border-[var(--gs-border)] px-3 py-2">
          <input
            autoFocus
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter turns…"
            className="w-full border border-[var(--gs-border)] bg-[var(--gs-bg)] px-2 py-1 text-[var(--gs-text)] outline-none focus:border-[var(--gs-accent)]"
          />
        </div>
        <div className="overflow-y-auto py-1">
          {loading && entries.length === 0 ? (
            <div className="px-4 py-4 text-center text-[var(--gs-text-dim)]">Loading history…</div>
          ) : rows.length === 0 ? (
            <div className="px-4 py-4 text-center text-[var(--gs-text-dim)]">{entries.length === 0 ? 'No turns yet.' : 'No matching turns.'}</div>
          ) : (
            rows.map((e) => (
              <button
                key={e.entryId}
                type="button"
                disabled={e.current}
                onClick={() => onNavigate(e.entryId)}
                className={`block w-full border-b border-[var(--gs-border-muted)] px-4 py-2 text-left last:border-b-0 ${e.current ? 'cursor-default bg-[var(--gs-bg)]' : 'hover:bg-[var(--gs-border)]'}`}
                title={e.current ? 'Current turn' : 'Rewind to this turn'}
              >
                <div className="flex items-start gap-2">
                  <span className={e.current ? 'text-[var(--gs-accent)]' : 'text-[var(--gs-text-dim)]'}>{e.current ? '●' : '↩'}</span>
                  <span className="line-clamp-2 flex-1 text-[var(--gs-text)]">{e.text || '(empty)'}</span>
                  {e.current && <span className="text-[10px] uppercase tracking-wide text-[var(--gs-text-ghost)]">current</span>}
                </div>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
