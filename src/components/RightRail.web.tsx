/** @jsxImportSource react */
import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import { PatchDiff } from '@pierre/diffs/react';
import type { SessionBackend } from '../session/backend.js';
import type { ReviewChangedFile } from '../types/review.js';
import { ArtifactsBrowser } from './ArtifactsBrowser.web.js';

/**
 * RightRail — the workspace view's persistent right column (mock: RightRail.tsx).
 * Repo mode: file tree with git status, diff-vs-base, Changes + commit box.
 * Artifacts mode: the workspace's artifacts mount, click → full viewer.
 * Collapsed state persists; the rail renders a thin reopen strip when closed.
 */

const RAIL_CLOSED_KEY = 'gssh:workspace-right-rail-closed';
const RAIL_MODE_KEY = 'gssh:workspace-right-rail-mode';

interface TreeNode {
  name: string;
  path: string;
  children?: Map<string, TreeNode>;
  status?: string;
}

function buildTree(entries: Array<{ path: string; status?: string }>): TreeNode {
  const root: TreeNode = { name: '', path: '', children: new Map() };
  for (const e of entries) {
    const parts = e.path.split('/');
    let node = root;
    let acc = '';
    for (let i = 0; i < parts.length; i++) {
      acc = acc ? `${acc}/${parts[i]}` : parts[i];
      const leaf = i === parts.length - 1;
      if (!node.children) node.children = new Map();
      let child = node.children.get(parts[i]);
      if (!child) {
        child = { name: parts[i], path: acc, ...(leaf ? {} : { children: new Map() }) };
        node.children.set(parts[i], child);
      }
      if (leaf) child.status = e.status;
      node = child;
    }
  }
  return root;
}

const STATUS_TONE: Record<string, string> = {
  M: 'text-[var(--gs-warning)]',
  A: 'text-[var(--gs-success)]',
  D: 'text-[var(--gs-danger)]',
  R: 'text-[var(--gs-info)]',
  '?': 'text-[var(--gs-text-ghost)]',
};

export function RightRail({
  backend,
  workspaceId,
  projectName,
  workspaceName,
}: {
  backend: SessionBackend | null;
  workspaceId: string;
  projectName: string;
  workspaceName: string;
}): ReactElement {
  const [closed, setClosed] = useState(() => {
    try { return window.localStorage.getItem(RAIL_CLOSED_KEY) === '1'; } catch { return false; }
  });
  const [mode, setMode] = useState<'repo' | 'artifacts'>(() => {
    try { return window.localStorage.getItem(RAIL_MODE_KEY) === 'artifacts' ? 'artifacts' : 'repo'; } catch { return 'repo'; }
  });
  useEffect(() => { try { window.localStorage.setItem(RAIL_CLOSED_KEY, closed ? '1' : '0'); } catch { /* */ } }, [closed]);
  useEffect(() => { try { window.localStorage.setItem(RAIL_MODE_KEY, mode); } catch { /* */ } }, [mode]);

  if (closed) {
    return (
      <button
        type="button"
        onClick={() => setClosed(false)}
        title="Open the repo/artifacts rail"
        className="flex h-full w-6 flex-shrink-0 flex-col items-center gap-2 border-l border-[var(--gs-border-muted)] bg-[var(--gs-bg)] pt-3 text-[10px] text-[var(--gs-text-ghost)] hover:text-[var(--gs-text)]"
      >
        <span>◧</span>
        <span style={{ writingMode: 'vertical-rl' }}>rail</span>
      </button>
    );
  }

  return (
    <aside className="flex h-full w-[320px] flex-shrink-0 flex-col border-l border-[var(--gs-border-muted)] bg-[var(--gs-bg)]">
      <div className="flex items-center gap-1 border-b border-[var(--gs-border-muted)] px-2 py-1.5 text-[11px]">
        {(['repo', 'artifacts'] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            className={`rounded px-2 py-0.5 capitalize ${mode === m ? 'bg-[var(--gs-bg-active)] text-[var(--gs-accent)]' : 'text-[var(--gs-text-dim)] hover:text-[var(--gs-text)]'}`}
          >
            {m}
          </button>
        ))}
        <button type="button" onClick={() => setClosed(true)} title="Collapse rail" className="ml-auto px-1 text-[var(--gs-text-ghost)] hover:text-[var(--gs-text)]">◨</button>
      </div>
      {mode === 'repo'
        ? <RepoMode backend={backend} workspaceId={workspaceId} projectName={projectName} workspaceName={workspaceName} />
        : <ArtifactsMode backend={backend} workspaceId={workspaceId} workspaceName={workspaceName} />}
    </aside>
  );
}

/* ── Repo mode ─────────────────────────────────────────────────────────────── */

function RepoMode({ backend, workspaceId, projectName, workspaceName }: {
  backend: SessionBackend | null;
  workspaceId: string;
  projectName: string;
  workspaceName: string;
}): ReactElement {
  const [entries, setEntries] = useState<Array<{ path: string; status?: string }>>([]);
  const [changed, setChanged] = useState<ReviewChangedFile[]>([]);
  const [baseBranch, setBaseBranch] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [commitMsg, setCommitMsg] = useState('');
  const [committing, setCommitting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [viewer, setViewer] = useState<{ path: string; changed: boolean; prevPath?: string } | null>(null);

  const refresh = useCallback(() => {
    if (!backend || !workspaceId) return;
    setLoading(true);
    setError(null);
    const tree = backend.listRepoFiles?.(workspaceId).then(setEntries);
    const changes = backend.sendReviewRequest?.({ op: 'get_changed_files', projectName, workspaceName })
      .then((r) => {
        if (r && 'op' in r && r.op === 'changed_files') {
          setChanged((r as { files: ReviewChangedFile[] }).files ?? []);
          setBaseBranch((r as { baseBranch?: string }).baseBranch ?? '');
        }
      });
    void Promise.allSettled([tree, changes])
      .then((results) => {
        const failed = results.find((x) => x.status === 'rejected') as PromiseRejectedResult | undefined;
        if (failed && entriesEmpty()) setError(failed.reason instanceof Error ? failed.reason.message : 'Failed to load repo');
      })
      .finally(() => setLoading(false));
    function entriesEmpty(): boolean { return true; }
  }, [backend, workspaceId, projectName, workspaceName]);

  useEffect(() => { refresh(); }, [refresh]);

  const changedSet = useMemo(() => new Set(changed.map((f) => f.filePath)), [changed]);
  const tree = useMemo(() => buildTree(entries), [entries]);

  const toggleDir = (path: string): void =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const renderNode = (node: TreeNode, depth: number, out: ReactElement[]): void => {
    const dirs = [...(node.children?.values() ?? [])].filter((n) => n.children).sort((a, b) => a.name.localeCompare(b.name));
    const files = [...(node.children?.values() ?? [])].filter((n) => !n.children).sort((a, b) => a.name.localeCompare(b.name));
    for (const d of dirs) {
      const isCollapsed = collapsed.has(d.path);
      out.push(
        <button key={d.path} type="button" onClick={() => toggleDir(d.path)} style={{ paddingLeft: 8 + depth * 12 }}
          className="flex w-full items-center gap-1.5 py-[2px] text-left text-[var(--gs-text-muted)] hover:bg-[var(--gs-bg-active)]">
          <span className="text-[var(--gs-text-ghost)]">{isCollapsed ? '▸' : '▾'}</span>
          <span className="truncate">{d.name}</span>
        </button>,
      );
      if (!isCollapsed) renderNode(d, depth + 1, out);
    }
    for (const f of files) {
      out.push(
        <button key={f.path} type="button" onClick={() => setViewer({ path: f.path, changed: changedSet.has(f.path) })} style={{ paddingLeft: 8 + depth * 12 }}
          className="flex w-full items-center gap-1.5 py-[2px] text-left hover:bg-[var(--gs-bg-active)]" title={f.path}>
          <span className="text-[var(--gs-text-ghost)]">▤</span>
          <span className={`min-w-0 flex-1 truncate ${f.status ? 'text-[var(--gs-text)]' : 'text-[var(--gs-text-muted)]'}`}>{f.name}</span>
          {f.status && <span className={`flex-shrink-0 text-[10px] ${STATUS_TONE[f.status] ?? 'text-[var(--gs-text-dim)]'}`}>{f.status}</span>}
        </button>,
      );
    }
  };

  const treeRows: ReactElement[] = [];
  renderNode(tree, 0, treeRows);

  const commit = async (): Promise<void> => {
    if (!backend?.commitWorkspaceChanges || !commitMsg.trim() || committing) return;
    setCommitting(true);
    setNotice(null);
    try {
      const sha = await backend.commitWorkspaceChanges(workspaceId, commitMsg.trim());
      setNotice(sha ? `Committed ${sha.slice(0, 8)}` : 'Nothing to commit');
      if (sha) setCommitMsg('');
      refresh();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : 'Commit failed');
    } finally {
      setCommitting(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col text-[12px]">
      {/* Files */}
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex items-center gap-2 px-2 py-1 text-[10px] uppercase tracking-wider text-[var(--gs-text-ghost)]">
          Files
          <span className="ml-auto normal-case tracking-normal">
            diff vs <span className="text-[var(--gs-text-dim)]">{baseBranch || '…'}</span>
          </span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto pb-1 font-[family-name:var(--gs-font-mono)] text-[11px]">
          {loading && entries.length === 0 ? (
            <div className="px-3 py-3 text-center text-[var(--gs-text-dim)]">Loading…</div>
          ) : error ? (
            <div className="px-3 py-3 text-center text-[var(--gs-danger)]">{error}</div>
          ) : treeRows}
        </div>
      </div>
      {/* Changes + commit */}
      <div className="flex max-h-[45%] min-h-[120px] flex-col border-t border-[var(--gs-border-muted)]">
        <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-[var(--gs-text-ghost)]">
          Changes <span className="text-[var(--gs-text-dim)]">{changed.length}</span>
        </div>
        <div className="flex gap-1 px-2 pb-1">
          <input
            value={commitMsg}
            onChange={(e) => setCommitMsg(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void commit(); }}
            placeholder="Commit message…"
            className="min-w-0 flex-1 border border-[var(--gs-border)] bg-[var(--gs-bg-elevated)] px-1.5 py-0.5 text-[11px] text-[var(--gs-text)] outline-none focus:border-[var(--gs-accent)]"
          />
          <button
            type="button"
            onClick={() => void commit()}
            disabled={!commitMsg.trim() || committing}
            className="border border-[#1f4a2f] px-2 py-0.5 text-[11px] text-[var(--gs-accent)] disabled:opacity-40"
          >
            {committing ? '…' : 'Commit'}
          </button>
        </div>
        {notice && <div className="px-2 pb-1 text-[10px] text-[var(--gs-text-dim)]">{notice}</div>}
        <div className="min-h-0 flex-1 overflow-y-auto pb-1 font-[family-name:var(--gs-font-mono)] text-[11px]">
          {changed.length === 0 ? (
            <div className="px-3 py-2 text-center text-[var(--gs-text-ghost)]">No changes vs {baseBranch || 'base'}.</div>
          ) : (
            changed.map((f) => {
              const letter = f.changeType === 'new' ? 'A' : f.changeType === 'deleted' ? 'D' : f.changeType === 'renamed' ? 'R' : 'M';
              return (
                <button key={f.filePath} type="button" onClick={() => setViewer({ path: f.filePath, changed: true, prevPath: f.prevFilePath })}
                  className="flex w-full items-center gap-1.5 px-2 py-[2px] text-left hover:bg-[var(--gs-bg-active)]" title={f.filePath}>
                  <span className={`w-3 flex-shrink-0 text-[10px] ${STATUS_TONE[letter] ?? 'text-[var(--gs-warning)]'}`}>{letter}</span>
                  <span className="min-w-0 flex-1 truncate text-[var(--gs-text)]">{f.filePath}</span>
                </button>
              );
            })
          )}
        </div>
      </div>
      {viewer && (
        <FileViewer
          backend={backend}
          workspaceId={workspaceId}
          projectName={projectName}
          workspaceName={workspaceName}
          path={viewer.path}
          changed={viewer.changed}
          prevPath={viewer.prevPath}
          onClose={() => setViewer(null)}
        />
      )}
    </div>
  );
}

/* ── File viewer (Pierre diff for changed files, content otherwise) ────────── */

function FileViewer({ backend, workspaceId, projectName, workspaceName, path, changed, prevPath, onClose }: {
  backend: SessionBackend | null;
  workspaceId: string;
  projectName: string;
  workspaceName: string;
  path: string;
  changed: boolean;
  prevPath?: string;
  onClose: () => void;
}): ReactElement {
  const [patch, setPatch] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    let alive = true;
    setState('loading');
    setPatch(null);
    setContent(null);
    void (async () => {
      try {
        if (changed && backend?.sendReviewRequest) {
          const r = await backend.sendReviewRequest({ op: 'get_file_diff', projectName, workspaceName, filePath: path, prevFilePath: prevPath });
          const diff = (r as { diff?: string; patch?: string }) ?? {};
          const text = diff.patch ?? diff.diff;
          if (text && text.trim()) {
            if (alive) { setPatch(text); setState('ready'); }
            return;
          }
        }
        const read = await backend?.readRepoFile?.(workspaceId, path);
        if (!alive) return;
        if (!read || read.base64 === null) { setState('error'); return; }
        setContent(atob(read.base64));
        setState('ready');
      } catch {
        if (alive) setState('error');
      }
    })();
    return () => { alive = false; };
  }, [backend, workspaceId, projectName, workspaceName, path, changed, prevPath]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/50" />
      <div className="relative z-10 flex h-[80vh] w-[min(1100px,95vw)] flex-col border border-[var(--gs-border)] bg-[var(--gs-bg-elevated)] text-[12px] shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 border-b border-[var(--gs-border)] px-4 py-2.5 text-[13px]">
          <span className="font-[family-name:var(--gs-font-mono)] text-[var(--gs-text)]">{path}</span>
          {changed && <span className="rounded-full border border-[#4a3a1f] px-1.5 text-[10px] text-[var(--gs-warning)]">changed</span>}
          <button type="button" onClick={onClose} className="ml-auto text-[var(--gs-text-dim)] hover:text-[var(--gs-text)]">✕</button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-2">
          {state === 'loading' ? (
            <div className="flex h-full items-center justify-center text-[var(--gs-text-dim)]">Loading…</div>
          ) : state === 'error' ? (
            <div className="flex h-full items-center justify-center text-[var(--gs-danger)]">Failed to load {path}</div>
          ) : patch ? (
            <PatchDiff patch={patch} options={{ diffStyle: 'unified', theme: 'pierre-dark' }} />
          ) : (
            <pre className="whitespace-pre-wrap font-[family-name:var(--gs-font-mono)] text-[11px] text-[var(--gs-text)]">{content}</pre>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Artifacts mode ────────────────────────────────────────────────────────── */

function ArtifactsMode({ backend, workspaceId, workspaceName }: {
  backend: SessionBackend | null;
  workspaceId: string;
  workspaceName: string;
}): ReactElement {
  const [entries, setEntries] = useState<Array<{ path: string; size: number; pointer: boolean }>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const fn = backend?.listWorkspaceArtifacts;
    if (!fn) { setLoading(false); setError('Artifacts not available.'); return; }
    fn.call(backend, workspaceId)
      .then((list) => { if (alive) setEntries(list); })
      .catch((e) => { if (alive) setError(e instanceof Error ? e.message : 'Failed to list artifacts'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [backend, workspaceId]);

  const groups = useMemo(() => {
    const byDir = new Map<string, Array<{ path: string; size: number; pointer: boolean }>>();
    for (const e of entries) {
      const dir = e.path.includes('/') ? e.path.slice(0, e.path.indexOf('/')) : '·';
      (byDir.get(dir) ?? byDir.set(dir, []).get(dir)!).push(e);
    }
    return [...byDir.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [entries]);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto pb-2 font-[family-name:var(--gs-font-mono)] text-[11px]">
      {loading ? (
        <div className="px-3 py-3 text-center text-[var(--gs-text-dim)]">Loading…</div>
      ) : error ? (
        <div className="px-3 py-3 text-center text-[var(--gs-danger)]">{error}</div>
      ) : entries.length === 0 ? (
        <div className="px-3 py-4 text-center text-[var(--gs-text-dim)]">
          No artifacts yet.
          <div className="mt-1 text-[10px] text-[var(--gs-text-ghost)]">Goal evidence, demos and reports land here.</div>
        </div>
      ) : (
        groups.map(([dir, files]) => (
          <div key={dir}>
            <div className="px-2 pb-0.5 pt-2 text-[10px] uppercase tracking-wider text-[var(--gs-text-ghost)]">{dir}/</div>
            {files.map((e) => (
              <button key={e.path} type="button" onClick={() => setOpen(e.path)}
                className="flex w-full items-center gap-1.5 px-2 py-[2px] text-left hover:bg-[var(--gs-bg-active)]" title={e.path}>
                <span className="min-w-0 flex-1 truncate text-[var(--gs-text)]">{e.path.includes('/') ? e.path.slice(e.path.indexOf('/') + 1) : e.path}</span>
                {e.pointer && <span className="flex-shrink-0 rounded-full border border-[#2a2413] px-1 text-[9px] text-[#f0b429]">lfs</span>}
              </button>
            ))}
          </div>
        ))
      )}
      {open && (
        <ArtifactsBrowser
          backend={backend}
          workspaceId={workspaceId}
          workspaceLabel={workspaceName}
          initialSelected={open}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}
