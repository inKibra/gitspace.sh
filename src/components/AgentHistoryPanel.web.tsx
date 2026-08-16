/** @jsxImportSource react */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactElement } from 'react';
import type { AgentHistoryEntry, AgentNavigateMode, AgentTreeNode } from '../agents/agent-runtime-types.js';

/**
 * Conversation navigator. Two views over the same session tree:
 *  - History: the user-message checkpoints on the current branch, oldest → newest
 *    (current at the bottom, like the transcript). Click/Enter re-does a turn —
 *    the message leaves the transcript and its text returns to the composer.
 *  - Tree ("spine + fork groups"): the current branch rendered flat; at every
 *    fork an amber group lists ALL other branches, expandable in place. Click/
 *    Enter jumps the conversation; the spine re-roots around the new position.
 * Keyboard: ↑/↓ move · Enter activate · / filter (history) · Esc close.
 * Focus starts on the current turn in both views.
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
  const wrapRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);

  // Oldest → newest (root → leaf), current at the bottom.
  const rows = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return entries.filter((e) => !f || e.text.toLowerCase().includes(f));
  }, [entries, filter]);

  // Enrich history rows with the tree's real creation order when available.
  const seqById = useMemo(() => new Map(tree.map((n) => [n.id, n.seq])), [tree]);

  // Focus + center the current turn whenever the view or data changes.
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const el = (wrap.querySelector('[data-cur="1"]') ?? wrap.querySelector('[data-nav]')) as HTMLElement | null;
    el?.focus();
    el?.scrollIntoView({ block: 'center' });
  }, [view, entries, tree]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') {
      onClose();
      e.preventDefault();
      return;
    }
    if (e.key === '/' && view === 'history' && document.activeElement !== filterRef.current) {
      filterRef.current?.focus();
      e.preventDefault();
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const wrap = wrapRef.current;
    if (!wrap) return;
    const items = Array.from(wrap.querySelectorAll<HTMLElement>('[data-nav]'));
    if (!items.length) return;
    const idx = items.indexOf(document.activeElement as HTMLElement);
    let next: number;
    if (idx === -1) {
      const cur = wrap.querySelector<HTMLElement>('[data-cur="1"]');
      next = cur ? items.indexOf(cur) : e.key === 'ArrowDown' ? 0 : items.length - 1;
    } else {
      next = e.key === 'ArrowDown' ? Math.min(items.length - 1, idx + 1) : Math.max(0, idx - 1);
    }
    items[next]?.focus();
    items[next]?.scrollIntoView({ block: 'nearest' });
    e.preventDefault();
  };

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
        ref={wrapRef}
        onKeyDown={onKeyDown}
        className="relative z-10 flex max-h-[78vh] w-[min(760px,94vw)] flex-col border border-[var(--gs-border)] bg-[var(--gs-bg-elevated)] text-[12px] shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-[var(--gs-border)] px-4 py-2 text-[13px]">
          {tab('history', '↩ History')}
          {tab('tree', '⑂ Tree')}
          <span className="text-[11px] text-[var(--gs-text-ghost)]">
            {view === 'history' ? 'Enter re-does a turn' : 'flat = your branch · amber = other branches at their fork'}
            {' · ↑↓ move · Esc close'}
          </span>
          <button type="button" onClick={onClose} className="ml-auto text-[var(--gs-text-dim)] hover:text-[var(--gs-text)]">✕</button>
        </div>

        {view === 'history' ? (
          <>
            <div className="border-b border-[var(--gs-border)] px-3 py-2">
              <input
                ref={filterRef}
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter turns…  ( / )"
                className="w-full border border-[var(--gs-border)] bg-[var(--gs-bg)] px-2 py-1 text-[var(--gs-text)] outline-none focus:border-[var(--gs-accent)]"
              />
            </div>
            <div className="overflow-y-auto py-1.5 font-[family-name:var(--gs-font-mono)]">
              {loading && entries.length === 0 ? (
                <div className="px-4 py-4 text-center text-[var(--gs-text-dim)]">Loading history…</div>
              ) : rows.length === 0 ? (
                <div className="px-4 py-4 text-center text-[var(--gs-text-dim)]">{entries.length === 0 ? 'No turns yet.' : 'No matching turns.'}</div>
              ) : (
                rows.map((e) => {
                  const seq = seqById.get(e.entryId);
                  return (
                    <button
                      key={e.entryId}
                      type="button"
                      data-nav
                      data-cur={e.current ? '1' : undefined}
                      onClick={() => { if (!e.current) onNavigate(e.entryId, 'redo'); }}
                      className={`flex w-full items-center gap-2 py-[3px] pl-3 pr-3 text-left outline-none ${
                        e.current
                          ? 'cursor-default bg-[color-mix(in_srgb,var(--gs-accent)_14%,transparent)] outline outline-1 outline-[color-mix(in_srgb,var(--gs-accent)_35%,transparent)]'
                          : 'hover:bg-[var(--gs-border)] focus:bg-[var(--gs-border)] focus:outline focus:outline-1 focus:outline-[var(--gs-text-dim)]'
                      }`}
                      title={e.current ? 'Current turn' : 'Re-do this message (returns it to the composer)'}
                    >
                      <span className="w-9 shrink-0 text-right text-[10px] text-[var(--gs-text-ghost)]">{seq !== undefined ? `#${seq}` : ''}</span>
                      <span className={`w-3 shrink-0 text-center ${e.current ? 'text-[var(--gs-accent)]' : 'text-[var(--gs-text-ghost)]'}`}>{e.current ? '●' : '↩'}</span>
                      <span className="shrink-0 rounded-full border border-[#1e3a5f] px-1.5 text-[10px] text-[#93c5fd]">you</span>
                      <span className="min-w-0 flex-1 truncate text-[var(--gs-text)]">{e.text || '(empty)'}</span>
                      {e.current && <span className="shrink-0 text-[10px] text-[var(--gs-accent)]">◀ current</span>}
                    </button>
                  );
                })
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

  const { byId, childrenOf, roots } = useMemo(() => {
    const byId = new Map(tree.map((n) => [n.id, n]));
    const kids = new Map<string | null, AgentTreeNode[]>();
    for (const n of tree) {
      const p = n.parentId && byId.has(n.parentId) ? n.parentId : null;
      (kids.get(p) ?? kids.set(p, []).get(p)!).push(n);
    }
    return { byId, childrenOf: kids, roots: kids.get(null) ?? [] };
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
          data-nav
          data-cur={n.current ? '1' : undefined}
          onClick={() => { if (!n.current) onNavigate(n.id, 'jump'); }}
          style={{ paddingLeft: 12 + depth * 16 }}
          className={`flex w-full items-center gap-2 py-[3px] pr-3 text-left outline-none ${
            n.current
              ? 'cursor-default bg-[color-mix(in_srgb,var(--gs-accent)_14%,transparent)] outline outline-1 outline-[color-mix(in_srgb,var(--gs-accent)_35%,transparent)]'
              : 'hover:bg-[var(--gs-border)] focus:bg-[var(--gs-border)] focus:outline focus:outline-1 focus:outline-[var(--gs-text-dim)]'
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
                  <button
                    type="button"
                    data-nav
                    onClick={() => toggle(o.id)}
                    className="flex w-full items-center gap-2 px-2.5 py-1 text-left outline-none hover:bg-[#171410] focus:bg-[#171410] focus:outline focus:outline-1 focus:outline-[var(--gs-text-dim)]"
                  >
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
    <div className="overflow-y-auto py-1.5 font-[family-name:var(--gs-font-mono)]">
      {out.length === 0 ? <div className="px-4 py-4 text-center text-[var(--gs-text-dim)]">No messages yet.</div> : out}
    </div>
  );
}
