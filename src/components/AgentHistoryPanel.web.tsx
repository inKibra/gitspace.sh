/** @jsxImportSource react */
import { useMemo, useState, type ReactElement } from 'react';
import type { AgentHistoryEntry, AgentNavigateMode, AgentTreeNode } from '../agents/agent-runtime-types.js';

/**
 * Conversation navigator. Two views over the same session tree:
 *  - History: the user-message checkpoints on the current branch. Click one to
 *    re-do it — the message leaves the transcript and its text returns to the
 *    composer (edit + re-send). The prior path is preserved as a branch.
 *  - Tree: the full branch graph. Click any node to jump the conversation there
 *    (return to a fork), non-destructively.
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

  // Build parent→children from the flat node list for the tree view.
  const { roots, childrenOf } = useMemo(() => {
    const byId = new Map(tree.map((n) => [n.id, n]));
    const kids = new Map<string | null, AgentTreeNode[]>();
    for (const n of tree) {
      const p = n.parentId && byId.has(n.parentId) ? n.parentId : null;
      const arr = kids.get(p) ?? [];
      arr.push(n);
      kids.set(p, arr);
    }
    return { roots: kids.get(null) ?? [], childrenOf: kids };
  }, [tree]);

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
        className="relative z-10 flex max-h-[72vh] w-[520px] flex-col border border-[var(--gs-border)] bg-[var(--gs-bg-elevated)] text-[12px] shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-[var(--gs-border)] px-4 py-2 text-[13px]">
          {tab('history', '↩ History')}
          {tab('tree', '⑂ Tree')}
          <span className="text-[11px] text-[var(--gs-text-ghost)]">
            {view === 'history' ? 'click a turn to re-do it' : 'click a node to jump there'}
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
        ) : (
          <div className="overflow-y-auto py-1.5 font-[family-name:var(--gs-font-mono)]">
            {!treeAvailable ? (
              <div className="px-4 py-4 text-center text-[var(--gs-text-dim)]">Tree view isn't available for this session.</div>
            ) : loading && tree.length === 0 ? (
              <div className="px-4 py-4 text-center text-[var(--gs-text-dim)]">Loading tree…</div>
            ) : roots.length === 0 ? (
              <div className="px-4 py-4 text-center text-[var(--gs-text-dim)]">No messages yet.</div>
            ) : (
              roots.map((r) => <TreeRow key={r.id} node={r} depth={0} childrenOf={childrenOf} onNavigate={onNavigate} />)
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function TreeRow({
  node,
  depth,
  childrenOf,
  onNavigate,
}: {
  node: AgentTreeNode;
  depth: number;
  childrenOf: Map<string | null, AgentTreeNode[]>;
  onNavigate: (entryId: string, mode: AgentNavigateMode) => void;
}): ReactElement {
  const kids = childrenOf.get(node.id) ?? [];
  const isFork = kids.length > 1;
  return (
    <>
      <button
        type="button"
        disabled={node.current}
        onClick={() => onNavigate(node.id, 'jump')}
        style={{ paddingLeft: 10 + depth * 16 }}
        className={`flex w-full items-center gap-2 py-1 pr-3 text-left ${
          node.current
            ? 'cursor-default bg-[color-mix(in_srgb,var(--gs-accent)_14%,transparent)] outline outline-1 outline-[color-mix(in_srgb,var(--gs-accent)_35%,transparent)]'
            : 'hover:bg-[var(--gs-border)]'
        } ${node.onPath || node.current ? '' : 'opacity-55'}`}
        title={node.current ? 'Current position' : 'Jump the conversation to this node'}
      >
        <span className={node.current ? 'text-[var(--gs-accent)]' : 'text-[var(--gs-text-ghost)]'}>{node.onPath || node.current ? '●' : '○'}</span>
        <span
          className={`shrink-0 rounded-full border px-1.5 text-[10px] ${
            node.role === 'user'
              ? 'border-[#1e3a5f] text-[#93c5fd]'
              : node.role === 'assistant'
                ? 'border-[#1f4a2f] text-[var(--gs-accent)]'
                : 'border-[var(--gs-border)] text-[var(--gs-text-dim)]'
          }`}
        >
          {node.role === 'user' ? 'you' : node.role === 'assistant' ? 'gpt' : '·'}
        </span>
        <span className="truncate text-[var(--gs-text)]">{node.preview || '(empty)'}</span>
        {node.current && <span className="ml-auto shrink-0 text-[10px] text-[var(--gs-accent)]">◀ current</span>}
        {isFork && !node.current && <span className="ml-auto shrink-0 text-[10px] text-[var(--gs-warning,#f0b429)]">⑂ {kids.length}</span>}
      </button>
      {kids.map((k) => (
        <TreeRow key={k.id} node={k} depth={depth + 1} childrenOf={childrenOf} onNavigate={onNavigate} />
      ))}
    </>
  );
}
