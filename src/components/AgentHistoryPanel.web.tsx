/** @jsxImportSource react */
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import type { AgentHistoryEntry, AgentNavigateMode, AgentTreeNode } from '../agents/agent-runtime-types.js';

/**
 * Conversation navigator. Two views over the same session tree:
 *  - History: the user-message checkpoints on the current branch. Click one to
 *    re-do it — the message leaves the transcript and its text returns to the
 *    composer (edit + re-send). The prior path is preserved as a branch.
 *  - Tree ("spine + fork groups"): the current branch rendered flat; at every
 *    fork an amber group lists ALL other branches (first message + length),
 *    expandable in place. Click any node to jump the conversation there — the
 *    spine re-roots around the new position.
 */
export function AgentHistoryPanel({
  entries,
  tree,
  treeAvailable,
  loading,
  onNavigate,
  onClose,
}: {
  entries: AgentHistoryEntry[];
  tree: AgentTreeNode[];
  treeAvailable: boolean;
  loading: boolean;
  onNavigate: (entryId: string, mode: AgentNavigateMode) => void;
  onClose: () => void;
}): ReactElement {
  const [view, setView] = useState<'history' | 'tree'>('history');
  const [filter, setFilter] = useState('');

  const rows = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return [...entries].reverse().filter((e) => !f || e.text.toLowerCase().includes(f));
  }, [entries, filter]);

  const tab = (id: 'history' | 'tree', label: string) => (
    <button
      type="button"
      onClick={() => setView(id)}
      className={`px-2.5 py-1 ${view === id ? 'border-b-2 border-[var(--gs-accent)] text-[var(--gs-accent)]' : 'text-[var(--gs-text-dim)] hover:text-[var(--gs-text)]'}`}
    >
      {label}
    </button>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/50" />
      <div
        className="relative z-10 flex max-h-[78vh] w-[min(760px,94vw)] flex-col border border-[var(--gs-border)] bg-[var(--gs-bg-elevated)] text-[12px] shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-[var(--gs-border)] px-4 py-2 text-[13px]">
          {tab('history', '↩ History')}
          {tab('tree', '⑂ Tree')}
          <span className="text-[11px] text-[var(--gs-text-ghost)]">
            {view === 'history' ? 'click a turn to re-do it' : 'flat = your branch · amber = other branches at their fork'}
          </span>
          <button type="button" onClick={onClose} className="ml-auto text-[var(--gs-text-dim)] hover:text-[var(--gs-text)]">✕</button>
        </div>

        {view === 'history' ? (
          <>
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
                    onClick={() => onNavigate(e.entryId, 'redo')}
                    className={`block w-full border-b border-[var(--gs-border-muted)] px-4 py-2 text-left last:border-b-0 ${e.current ? 'cursor-default bg-[var(--gs-bg)]' : 'hover:bg-[var(--gs-border)]'}`}
                    title={e.current ? 'Current turn' : 'Re-do this message (returns it to the composer)'}
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
          </>
        ) : !treeAvailable ? (
          <div className="px-4 py-4 text-center text-[var(--gs-text-dim)]">Tree view isn't available for this session.</div>
        ) : loading && tree.length === 0 ? (
          <div className="px-4 py-4 text-center text-[var(--gs-text-dim)]">Loading tree…</div>
        ) : (
          <SpineTree tree={tree} onNavigate={onNavigate} />
        )}
      </div>
    </div>
  );
}

/** Node text: preview, or a ghost "⚙ N tool calls" label for text-less turns. */
function nodeText(n: AgentTreeNode): ReactElement {
  if (n.preview) return <>{n.preview}</>;
  if (n.tools) return <span className="text-[var(--gs-text-ghost)]">⚙ {n.tools} tool call{n.tools > 1 ? 's' : ''} (no text)</span>;
  return <span className="text-[var(--gs-text-ghost)]">(empty)</span>;
}

function SpineTree({ tree, onNavigate }: { tree: AgentTreeNode[]; onNavigate: (entryId: string, mode: AgentNavigateMode) => void }): ReactElement {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const scrollRef = useRef<HTMLDivElement>(null);

  const { byId, childrenOf, roots } = useMemo(() => {
    const byId = new Map(tree.map((n) => [n.id, n]));
    const kids = new Map<string | null, AgentTreeNode[]>();
    for (const n of tree) {
      const p = n.parentId && byId.has(n.parentId) ? n.parentId : null;
      (kids.get(p) ?? kids.set(p, []).get(p)!).push(n);
    }
    return { byId, childrenOf: kids, roots: kids.get(null) ?? [] };
  }, [tree]);

  // Center the current node when the tree opens / re-roots.
  useEffect(() => {
    scrollRef.current?.querySelector('[data-cur="1"]')?.scrollIntoView({ block: 'center' });
  }, [tree]);

  const kids = (id: string): AgentTreeNode[] => childrenOf.get(id) ?? [];
  const chainLen = (startId: string): number => {
    let c = 0;
    let x: string | null = startId;
    while (x) {
      c++;
      const ks = kids(x);
      x = ks.length ? ks[0].id : null;
    }
    return c;
  };
  const toggle = (id: string): void =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // Render a chain (a branch) flat; recurse into fork groups.
  const renderChain = (startId: string, depth: number, out: ReactElement[]): void => {
    let x: string | null = startId;
    while (x) {
      const n = byId.get(x);
      if (!n) break;
      const ks = kids(x);
      const isFork = ks.length > 1;
      out.push(
        <button
          key={n.id}
          type="button"
          disabled={n.current}
          data-cur={n.current ? '1' : undefined}
          onClick={() => onNavigate(n.id, 'jump')}
          style={{ paddingLeft: 12 + depth * 16 }}
          className={`flex w-full items-center gap-2 py-[3px] pr-3 text-left ${
            n.current
              ? 'cursor-default bg-[color-mix(in_srgb,var(--gs-accent)_14%,transparent)] outline outline-1 outline-[color-mix(in_srgb,var(--gs-accent)_35%,transparent)]'
              : 'hover:bg-[var(--gs-border)]'
          }`}
          title={n.current ? 'Current position' : 'Jump the conversation to this message'}
        >
          <span className="w-9 shrink-0 text-right text-[10px] text-[var(--gs-text-ghost)]">{n.seq !== undefined ? `#${n.seq}` : ''}</span>
          <span className={`w-3 shrink-0 text-center ${n.current ? 'text-[var(--gs-accent)]' : 'text-[var(--gs-text-ghost)]'}`}>{n.onPath || n.current ? '●' : '○'}</span>
          <span
            className={`shrink-0 rounded-full border px-1.5 text-[10px] ${
              n.role === 'user' ? 'border-[#1e3a5f] text-[#93c5fd]' : 'border-[#1f4a2f] text-[var(--gs-accent)]'
            }`}
          >
            {n.role === 'user' ? 'you' : 'gpt'}
          </span>
          <span className={`min-w-0 flex-1 truncate ${n.onPath || n.current ? 'text-[var(--gs-text)]' : 'text-[var(--gs-text-dim)]'}`}>{nodeText(n)}</span>
          {isFork && <span className="shrink-0 text-[10px] text-[#f0b429]">⑂ fork</span>}
          {n.current && <span className="shrink-0 text-[10px] text-[var(--gs-accent)]">◀ current</span>}
        </button>,
      );
      let main: AgentTreeNode | null = ks.length ? ks[0] : null;
      if (isFork) {
        const onp = ks.find((k) => k.onPath || k.current);
        if (onp) main = onp;
        const others = ks.filter((k) => k.id !== main!.id);
        out.push(
          <div key={`${n.id}:forks`} className="my-1 mr-3 rounded border border-[#2a2413] bg-[#12100a]" style={{ marginLeft: 46 + depth * 16 }}>
            <div className="border-b border-[#221d10] px-2.5 py-1 text-[11px] text-[#f0b429]">
              ⑂ {others.length} other branch{others.length > 1 ? 'es' : ''} from {n.seq !== undefined ? `#${n.seq}` : 'here'} — main path continues below
            </div>
            {others.map((o) => {
              const open = expanded.has(o.id);
              const inner: ReactElement[] = [];
              if (open) renderChain(o.id, depth + 1, inner);
              return (
                <div key={o.id} className="border-t border-[#1c1810] first:border-t-0">
                  <button type="button" onClick={() => toggle(o.id)} className="flex w-full items-center gap-2 px-2.5 py-1 text-left hover:bg-[#171410]">
                    <span className="shrink-0 text-[var(--gs-text-dim)]">{open ? '▾' : '▸'}</span>
                    <span className="w-9 shrink-0 text-right text-[10px] text-[var(--gs-text-ghost)]">{o.seq !== undefined ? `#${o.seq}` : ''}</span>
                    <span
                      className={`shrink-0 rounded-full border px-1.5 text-[10px] ${
                        o.role === 'user' ? 'border-[#1e3a5f] text-[#93c5fd]' : 'border-[#1f4a2f] text-[var(--gs-accent)]'
                      }`}
                    >
                      {o.role === 'user' ? 'you' : 'gpt'}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[var(--gs-text-dim)]">{nodeText(o)}</span>
                    <span className="shrink-0 text-[10px] text-[var(--gs-text-ghost)]">· {chainLen(o.id)} msg{chainLen(o.id) > 1 ? 's' : ''} ↓</span>
                  </button>
                  {open && <div className="mb-1 ml-4 border-l-2 border-[#2a2413]">{inner}</div>}
                </div>
              );
            })}
          </div>,
        );
      }
      x = main ? main.id : null;
    }
  };

  const out: ReactElement[] = [];
  for (const r of roots) renderChain(r.id, 0, out);
  return (
    <div ref={scrollRef} className="overflow-y-auto py-1.5 font-[family-name:var(--gs-font-mono)]">
      {out.length === 0 ? <div className="px-4 py-4 text-center text-[var(--gs-text-dim)]">No messages yet.</div> : out}
    </div>
  );
}
