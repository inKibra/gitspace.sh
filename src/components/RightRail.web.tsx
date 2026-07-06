/** @jsxImportSource react */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { PatchDiff } from '@pierre/diffs/react';
import { useFileTree, FileTree } from '@pierre/trees/react';
import type { GitStatusEntry } from '@pierre/trees';
import type { SessionBackend } from '../session/backend.js';
import type { ReviewChangedFile } from '../types/review.js';
import { langForPath } from './ArtifactPanel.web.js';
import { KIND_ICON, KIND_LABEL, KIND_ORDER, classifyArtifact, type ArtifactKind } from './artifact-kinds.js';
import { Highlighted } from '../blocks/render/highlight.web.js';
import { deriveNoteLabel } from './note-label.js';

/**
 * RightRail — the workspace view's persistent right column (mock: RightRail.tsx).
 * Repo mode: file tree with git status, diff-vs-base, Changes + commit box.
 * Artifacts mode: the workspace's artifacts mount, click → full viewer.
 * Collapsed state persists; the rail renders a thin reopen strip when closed.
 */

const RAIL_CLOSED_KEY = 'gssh:workspace-right-rail-closed';
const RAIL_MODE_KEY = 'gssh:workspace-right-rail-mode';

/** The repo file tree, backed by @pierre/trees (the mock's stated backing). */
function PierreRepoTree({ entries, changedSet, onOpenFile }: {
  entries: Array<{ path: string; status?: string }>;
  changedSet: Set<string>;
  onOpenFile: (file: RepoFileOpen) => void;
}): ReactElement {
  const paths = useMemo(() => entries.map((e) => e.path), [entries]);
  const fileSet = useMemo(() => new Set(paths), [paths]);
  const gitStatus = useMemo<GitStatusEntry[]>(() => {
    const map: Record<string, GitStatusEntry['status']> = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', '?': 'untracked' };
    return entries
      .filter((e) => e.status && map[e.status])
      .map((e) => ({ path: e.path, status: map[e.status!] }));
  }, [entries]);
  /** Mock parity: dirs that contain working-tree changes start expanded. */
  const expandedDirs = useMemo(() => {
    const dirs = new Set<string>();
    for (const e of gitStatus) {
      const segments = e.path.split('/');
      for (let i = 1; i < segments.length; i += 1) dirs.add(segments.slice(0, i).join('/'));
    }
    return [...dirs];
  }, [gitStatus]);
  const openRef = useRef(onOpenFile);
  openRef.current = onOpenFile;
  const changedRef = useRef(changedSet);
  changedRef.current = changedSet;
  const fileSetRef = useRef(fileSet);
  fileSetRef.current = fileSet;
  const { model } = useFileTree({
    paths,
    gitStatus,
    initialExpandedPaths: expandedDirs,
    density: 'compact',
    onSelectionChange: (selected) => {
      const path = selected.find((s) => fileSetRef.current.has(s));
      if (path) openRef.current({ path, changed: changedRef.current.has(path) });
    },
  });
  useEffect(() => {
    model.resetPaths(paths, { initialExpandedPaths: expandedDirs });
  }, [model, paths, expandedDirs]);
  /** useFileTree only reads options at construction — push git status (the
   *  right-aligned M/A/D/U letters) whenever the async repo listing lands. */
  useEffect(() => {
    model.setGitStatus(gitStatus);
  }, [model, gitStatus]);
  return <FileTree model={model} className="gs-pierre-tree" />;
}

const STATUS_TONE: Record<string, string> = {
  M: 'text-[var(--gs-warning)]',
  A: 'text-[var(--gs-success)]',
  D: 'text-[var(--gs-danger)]',
  R: 'text-[var(--gs-info)]',
  '?': 'text-[var(--gs-text-ghost)]',
};

export interface RepoFileOpen {
  path: string;
  changed: boolean;
  prevPath?: string;
}

export function RightRail({
  backend,
  workspaceId,
  projectName,
  workspaceName,
  onOpenFile,
  onOpenArtifact,
  onOpenDashboard,
  onOpenNote,
  phase,
  onOpenEvents,
  goalEvidence,
  onOpenEvidence,
  onOpenReport,
  onOpenGoalPane,
  onOpenRubricPane,
  onOpenWorkflowPane,
  goalSummary,
}: {
  backend: SessionBackend | null;
  workspaceId: string;
  projectName: string;
  workspaceName: string;
  /** Open a repo file as a dock tab in the workspace multi-view. */
  onOpenFile: (file: RepoFileOpen) => void;
  /** Open an artifact as a dock tab in the workspace multi-view. */
  onOpenArtifact: (path: string) => void;
  /** Open a .dashboard.json artifact as a ▦ dock tab. */
  onOpenDashboard: (path: string) => void;
  /** Open a note (or a new-note composer when id is null) as a ✎ dock tab. */
  onOpenNote?: (noteId: string | null, title: string) => void;
  /** Workspace kanban phase — review stage switches the repo header to Diffs. */
  phase?: import('../types/config.js').WorkspacePhase;
  onOpenEvents?: () => void;
  /** Evidence rows from the bound goal (open as ▸ ev: tabs). */
  goalEvidence?: Array<{ requirementId: string; evidenceId: string; name: string; requirementTitle: string }>;
  onOpenEvidence?: (requirementId: string, evidenceId: string) => void;
  onOpenReport?: (path: string) => void;
  onOpenGoalPane?: () => void;
  onOpenRubricPane?: () => void;
  onOpenWorkflowPane?: () => void;
  /** Bound-goal summary for the rail's Goal group (mock: chain · N goals / N requirements). */
  goalSummary?: { chainTitle: string; chainLength: number; chainPosition: number; reqCount: number };
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
    <aside className="gs-ui flex h-full w-[320px] flex-shrink-0 flex-col border-l border-[var(--gs-border-muted)] bg-[var(--gs-bg)]">
      <div className="relative flex flex-shrink-0 border-b border-[var(--gs-border)]">
        {(['repo', 'artifacts'] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            className={`flex-1 py-[7px] text-[11px] uppercase tracking-[.08em] ${mode === m ? 'bg-[var(--gs-bg-elevated)] text-[var(--gs-text)] shadow-[inset_0_-2px_0_var(--gs-accent)]' : 'text-[var(--gs-text-muted)] hover:text-[var(--gs-text)]'}`}
          >
            {m}
          </button>
        ))}
        <button type="button" onClick={() => setClosed(true)} title="Collapse rail" className="absolute right-1 top-1/2 -translate-y-1/2 px-1 text-[11px] text-[var(--gs-text-ghost)] hover:text-[var(--gs-text)]">◨</button>
      </div>
      {mode === 'repo'
        ? <RepoMode backend={backend} workspaceId={workspaceId} projectName={projectName} workspaceName={workspaceName} onOpenFile={onOpenFile} reviewing={phase === 'review'} />
        : <ArtifactsMode backend={backend} workspaceId={workspaceId} projectName={projectName} workspaceName={workspaceName} onOpenArtifact={onOpenArtifact} onOpenDashboard={onOpenDashboard} onOpenNote={onOpenNote} onOpenEvents={onOpenEvents} goalEvidence={goalEvidence} onOpenEvidence={onOpenEvidence} onOpenReport={onOpenReport} onOpenGoalPane={onOpenGoalPane} onOpenRubricPane={onOpenRubricPane} onOpenWorkflowPane={onOpenWorkflowPane} goalSummary={goalSummary} />}
    </aside>
  );
}

/* ── Repo mode ─────────────────────────────────────────────────────────────── */

function RepoMode({ backend, workspaceId, projectName, workspaceName, onOpenFile, reviewing = false }: {
  backend: SessionBackend | null;
  workspaceId: string;
  projectName: string;
  workspaceName: string;
  onOpenFile: (file: RepoFileOpen) => void;
  reviewing?: boolean;
}): ReactElement {
  const [entries, setEntries] = useState<Array<{ path: string; status?: string }>>([]);
  const [changed, setChanged] = useState<ReviewChangedFile[]>([]);
  const [baseBranch, setBaseBranch] = useState<string>('');
  const [baseOverride, setBaseOverride] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [commitMsg, setCommitMsg] = useState('');
  const [committing, setCommitting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(() => {
    if (!backend || !workspaceId) return;
    setLoading(true);
    setError(null);
    const tree = backend.listRepoFiles?.(workspaceId).then(setEntries);
    const changes = backend.sendReviewRequest?.({ op: 'get_changed_files', projectName, workspaceName, base: baseOverride || undefined })
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
  }, [backend, workspaceId, projectName, workspaceName, baseOverride]);

  useEffect(() => { refresh(); }, [refresh]);

  const changedSet = useMemo(() => new Set(changed.map((f) => f.filePath)), [changed]);

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
        <div className="flex h-[30px] flex-shrink-0 items-center gap-[7px] border-b border-[var(--gs-border-muted)] px-3 text-[10px] uppercase tracking-[.1em] text-[var(--gs-text-muted)]">
          <span>▾</span>
          {reviewing ? 'Diffs' : 'Files'}
          {reviewing && <span className="rounded-full border border-[#4a3a1f] px-1.5 normal-case tracking-normal text-[var(--gs-warning)]">review</span>}
          <span className="ml-auto normal-case tracking-normal text-[var(--gs-text-ghost)]">backed by <span className="text-[var(--gs-text-dim)]">@pierre/trees</span></span>
        </div>
        <div className="flex flex-shrink-0 items-center gap-2 border-b border-[var(--gs-border-muted)] px-3 py-1.5 text-[11px]">
          <span className="text-[var(--gs-text-dim)]">diff vs</span>
          <select
            value={baseOverride || baseBranch}
            onChange={(e) => setBaseOverride(e.target.value === baseBranch ? '' : e.target.value)}
            className="border border-[var(--gs-border)] bg-[var(--gs-bg-elevated)] px-1.5 py-0.5 text-[11px] text-[var(--gs-text)]"
          >
            {[...new Set([baseBranch || 'main', 'main', 'develop'])].map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto pb-1 text-[11.5px]">
          {loading && entries.length === 0 ? (
            <div className="px-3 py-3 text-center text-[var(--gs-text-dim)]">Loading…</div>
          ) : error ? (
            <div className="px-3 py-3 text-center text-[var(--gs-danger)]">{error}</div>
          ) : (
            <PierreRepoTree entries={entries} changedSet={changedSet} onOpenFile={onOpenFile} />
          )}
        </div>
      </div>
      {/* Changes + commit */}
      <div className="flex max-h-[45%] min-h-[120px] flex-col border-t border-[var(--gs-border-muted)]">
        <div className="flex h-[30px] flex-shrink-0 items-center gap-[7px] px-3 text-[10px] uppercase tracking-[.1em] text-[var(--gs-text-muted)]">
          <span>▾</span>
          Changes <span className="ml-auto tabular-nums text-[var(--gs-text-dim)]">{changed.length}</span>
        </div>
        <div className="flex gap-1 px-3 pb-1.5">
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
        <div className="min-h-0 flex-1 overflow-y-auto pb-1 text-[11.5px]">
          {changed.length === 0 ? (
            <div className="px-3 py-2 text-center text-[var(--gs-text-ghost)]">No changes vs {baseBranch || 'base'}.</div>
          ) : (
            changed.map((f) => {
              const letter = f.changeType === 'new' ? 'A' : f.changeType === 'deleted' ? 'D' : f.changeType === 'renamed' ? 'R' : 'M';
              return (
                <button key={f.filePath} type="button" onClick={() => onOpenFile({ path: f.filePath, changed: true, prevPath: f.prevFilePath })}
                  className="flex w-full items-center gap-1.5 px-3 py-[2px] text-left hover:bg-[var(--gs-bg-active)]" title={f.filePath}>
                  <span className={`w-3 flex-shrink-0 text-[10px] ${STATUS_TONE[letter] ?? 'text-[var(--gs-warning)]'}`}>{letter}</span>
                  <span className="min-w-0 flex-1 truncate text-[var(--gs-text)]">{f.filePath}</span>
                  {(f.additions !== undefined || f.deletions !== undefined) && (
                    <span className="flex-shrink-0 text-[10px] tabular-nums text-[var(--gs-text-dim)]">+{f.additions ?? 0} −{f.deletions ?? 0}</span>
                  )}
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Repo file panel (dock tab content): Pierre diff for changed files ─────── */

export function RepoFilePanel({ backend, workspaceId, projectName, workspaceName, path, changed, prevPath }: {
  backend: SessionBackend | null;
  workspaceId: string;
  projectName: string;
  workspaceName: string;
  path: string;
  changed: boolean;
  prevPath?: string;
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
    <div className="flex h-full min-h-0 flex-col text-[12px]">
      <div className="flex flex-shrink-0 items-center gap-2 border-b border-[var(--gs-border-muted)] px-3 py-1.5">
        <span className="truncate font-[family-name:var(--gs-font-mono)] text-[12px] text-[var(--gs-text)]">{path}</span>
        {changed && <span className="flex-shrink-0 rounded-full border border-[#4a3a1f] px-1.5 text-[10px] text-[var(--gs-warning)]">changed</span>}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-2">
        {state === 'loading' ? (
          <div className="flex h-full items-center justify-center text-[var(--gs-text-dim)]">Loading…</div>
        ) : state === 'error' ? (
          <div className="flex h-full items-center justify-center text-[var(--gs-danger)]">Failed to load {path}</div>
        ) : patch ? (
          <PatchDiff patch={patch} options={{ diffStyle: 'unified', theme: 'pierre-dark' }} />
        ) : langForPath(path) ? (
          <Highlighted text={(content ?? '').slice(0, 300_000)} lang={langForPath(path)} name={path} />
        ) : (
          <pre className="whitespace-pre-wrap font-[family-name:var(--gs-font-mono)] text-[11px] text-[var(--gs-text)]">{content}</pre>
        )}
      </div>
    </div>
  );
}

/* ── Artifacts mode ────────────────────────────────────────────────────────── */

function rowMeta(path: string): string {
  const ext = path.includes('.') ? path.slice(path.lastIndexOf('.') + 1).toLowerCase() : '';
  if (ext === 'md') return 'doc';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) return 'img';
  if (['webm', 'mp4', 'mov'].includes(ext)) return 'video';
  if (ext === 'json') return 'json';
  return ext || '';
}

interface ReportRow {
  path: string;
  kind: string;
  surface: string;
  note: string;
  rating?: number;
}

const REPORT_TONE: Record<string, string> = {
  praise: 'border-[rgba(91,155,255,.4)] text-[var(--gs-info)]',
  'good-pattern': 'border-[rgba(0,255,102,.4)] text-[var(--gs-success)]',
  frustration: 'border-[rgba(255,80,80,.4)] text-[var(--gs-danger)]',
  'workflow-quirk': 'border-[rgba(255,204,0,.4)] text-[var(--gs-warning)]',
  'gitspace-quirk': 'border-[rgba(188,140,255,.4)] text-[#bc8cff]',
};

function ArtifactsMode({ backend, workspaceId, projectName, workspaceName, onOpenArtifact, onOpenDashboard, onOpenNote, onOpenEvents, goalEvidence, onOpenEvidence, onOpenReport, onOpenGoalPane, onOpenRubricPane, onOpenWorkflowPane, goalSummary }: {
  backend: SessionBackend | null;
  workspaceId: string;
  projectName: string;
  workspaceName: string;
  onOpenArtifact: (path: string) => void;
  onOpenDashboard: (path: string) => void;
  onOpenNote?: (noteId: string | null, title: string) => void;
  onOpenEvents?: () => void;
  goalEvidence?: Array<{ requirementId: string; evidenceId: string; name: string; requirementTitle: string }>;
  onOpenEvidence?: (requirementId: string, evidenceId: string) => void;
  onOpenReport?: (path: string) => void;
  onOpenGoalPane?: () => void;
  onOpenRubricPane?: () => void;
  onOpenWorkflowPane?: () => void;
  /** Bound-goal summary for the rail's Goal group (mock: chain · N goals / N requirements). */
  goalSummary?: { chainTitle: string; chainLength: number; chainPosition: number; reqCount: number };
}): ReactElement {
  const [entries, setEntries] = useState<Array<{ path: string; size: number; pointer: boolean }>>([]);
  const [notes, setNotes] = useState<Array<{ id: string; title: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<'sel' | 'fav'>('sel');
  const [query, setQuery] = useState('');
  const [reports, setReports] = useState<ReportRow[]>([]);
  const favKey = `gssh:artifact-favs:${projectName}`;
  const [favs, setFavs] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(window.localStorage.getItem(favKey) ?? '[]') as string[]); } catch { return new Set(); }
  });
  const toggleFav = (id: string): void => setFavs((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    try { window.localStorage.setItem(favKey, JSON.stringify([...next])); } catch { /* */ }
    return next;
  });

  useEffect(() => {
    let alive = true;
    const fn = backend?.listWorkspaceArtifacts;
    if (!fn) { setLoading(false); setError('Artifacts not available.'); return; }
    Promise.allSettled([
      fn.call(backend, workspaceId).then(async (list) => {
        if (alive) setEntries(list);
        // Parse report artifacts (reports/*.report.json) for the Reports group.
        const reportPaths = list.filter((e) => e.path.endsWith('.report.json'));
        const parsed = await Promise.all(reportPaths.map(async (e) => {
          try {
            const raw = await backend!.readWorkspaceArtifact!(workspaceId, e.path);
            const doc = JSON.parse(atob(raw.base64)) as { kind?: string; surface?: string; note?: string; rating?: number };
            return { path: e.path, kind: doc.kind ?? 'praise', surface: doc.surface ?? e.path, note: doc.note ?? '', rating: doc.rating } as ReportRow;
          } catch { return null; }
        }));
        if (alive) setReports(parsed.filter((r): r is ReportRow => r !== null));
      }),
      backend?.listWorkspaceNotes?.(projectName, workspaceName).then((n) => {
        if (alive) setNotes((n as Array<{ id: string; body?: string }>).map((x) => ({ id: x.id, title: deriveNoteLabel(x.body ?? '') })));
      }),
    ]).then((results) => {
      if (!alive) return;
      const first = results[0];
      if (first.status === 'rejected') setError(first.reason instanceof Error ? first.reason.message : 'Failed to list artifacts');
      setLoading(false);
    });
    return () => { alive = false; };
  }, [backend, workspaceId, projectName, workspaceName]);

  const openByKind = (path: string, kind: ArtifactKind): void => {
    if (kind === 'dashboard') onOpenDashboard(path);
    else if (kind === 'workflow' && onOpenWorkflowPane) onOpenWorkflowPane();
    else onOpenArtifact(path);
  };

  const ql = query.trim().toLowerCase();
  const matches = (text: string): boolean => !ql || text.toLowerCase().includes(ql);
  const groups = useMemo(() => {
    const byKind = new Map<ArtifactKind, Array<{ path: string; kind: ArtifactKind }>>();
    for (const e of entries) {
      if (e.path === 'README.md' || e.path.endsWith('.report.json')) continue;
      const kind = classifyArtifact(e.path);
      if (!matches(`${kind} ${e.path}`)) continue;
      (byKind.get(kind) ?? byKind.set(kind, []).get(kind)!).push({ path: e.path, kind });
    }
    return KIND_ORDER.map((k) => [k, byKind.get(k) ?? []] as const).filter(([, a]) => a.length > 0);
  }, [entries, ql]);

  const favList = useMemo(
    () => entries.filter((e) => favs.has(e.path)).map((e) => ({ path: e.path, kind: classifyArtifact(e.path) })),
    [entries, favs],
  );

  const row = (a: { path: string; kind: ArtifactKind }): ReactElement => {
    const name = a.path.split('/').pop() ?? a.path;
    return (
      <div key={a.path} className="group flex w-full items-center gap-1.5 px-2 py-[2px] hover:bg-[var(--gs-bg-active)]">
        <button type="button" onClick={() => openByKind(a.path, a.kind)} className="flex min-w-0 flex-1 items-center gap-1.5 text-left" title={a.path}>
          <span className="w-4 flex-shrink-0 text-center text-[var(--gs-text-ghost)]">{KIND_ICON[a.kind]}</span>
          <span className="min-w-0 flex-1 truncate text-[var(--gs-text)]">{name}</span>
        </button>
        <span className="ml-auto flex-shrink-0 text-[10.5px] text-[var(--gs-text-dim)]">{rowMeta(a.path)}</span>
        <button
          type="button"
          onClick={() => toggleFav(a.path)}
          title="favorite"
          className={`flex-shrink-0 px-0.5 ${favs.has(a.path) ? 'text-[#f0b429]' : 'text-[var(--gs-text-ghost)] opacity-0 group-hover:opacity-100'}`}
        >
          ★
        </button>
      </div>
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col text-[11.5px]">
      <div className="flex flex-shrink-0 items-center gap-1 px-2 pt-1.5 text-[11px]">
        <button type="button" onClick={() => setView('sel')} className={`rounded px-2 py-0.5 ${view === 'sel' ? 'bg-[var(--gs-bg-active)] text-[var(--gs-text)]' : 'text-[var(--gs-text-dim)] hover:text-[var(--gs-text)]'}`}>Artifacts</button>
        <button type="button" onClick={() => setView('fav')} className={`rounded px-2 py-0.5 ${view === 'fav' ? 'bg-[var(--gs-bg-active)] text-[var(--gs-text)]' : 'text-[var(--gs-text-dim)] hover:text-[var(--gs-text)]'}`}>
          ★ Favorites {favs.size > 0 && <span className="text-[var(--gs-text-ghost)]">{favs.size}</span>}
        </button>
      </div>
      <div className="px-2 pb-1 pt-1.5">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="search project artifacts…"
          className="w-full border border-[var(--gs-border)] bg-black px-[9px] py-[5px] text-[11px] text-[var(--gs-text)] outline-none placeholder:text-[var(--gs-text-ghost)] focus:border-[var(--gs-accent)]"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-2">
        {loading ? (
          <div className="px-3 py-3 text-center text-[var(--gs-text-dim)]">Loading…</div>
        ) : error ? (
          <div className="px-3 py-3 text-center text-[var(--gs-danger)]">{error}</div>
        ) : view === 'fav' ? (
          favList.length === 0
            ? <div className="px-3 py-4 text-center text-[var(--gs-text-dim)]">No favorites yet — ★ an artifact to pin it.</div>
            : favList.map(row)
        ) : (
          <>
            {/* GOAL group (mock artifactTree Goal rows) */}
            {onOpenGoalPane && matches('goal doc') && (
              <>
                <div className="px-3 pb-1 pt-2.5 text-[10px] uppercase tracking-[.12em] text-[var(--gs-text-dim)]">Goal</div>
                <button type="button" onClick={onOpenGoalPane} className="flex w-full items-center gap-1.5 px-3 py-[2px] text-left hover:bg-[var(--gs-bg-active)]">
                  <span className="w-4 flex-shrink-0 text-center text-[var(--gs-text-ghost)]">◇</span>
                  <span className="min-w-0 flex-1 truncate text-[var(--gs-text)]">goal.md</span>
                  <span className="ml-auto flex-shrink-0 text-[10.5px] text-[var(--gs-text-dim)]">doc</span>
                </button>
                {goalSummary && goalSummary.chainLength > 1 && (
                  <button type="button" onClick={onOpenGoalPane} className="flex w-full items-center gap-1.5 px-3 py-[2px] text-left hover:bg-[var(--gs-bg-active)]">
                    <span className="w-4 flex-shrink-0 text-center text-[var(--gs-text-ghost)]">⛓</span>
                    <span className="min-w-0 flex-1 truncate text-[var(--gs-text)]">chain · {goalSummary.chainLength} goals</span>
                    <span className="ml-auto flex-shrink-0 text-[10.5px] tabular-nums text-[var(--gs-text-dim)]">{goalSummary.chainPosition} of {goalSummary.chainLength}</span>
                  </button>
                )}
                {goalSummary && goalSummary.reqCount > 0 && onOpenRubricPane && (
                  <button type="button" onClick={onOpenRubricPane} className="flex w-full items-center gap-1.5 px-3 py-[2px] text-left hover:bg-[var(--gs-bg-active)]">
                    <span className="w-4 flex-shrink-0 text-center text-[var(--gs-text-ghost)]">☰</span>
                    <span className="min-w-0 flex-1 truncate text-[var(--gs-text)]">{goalSummary.reqCount} requirements</span>
                    <span className="ml-auto flex-shrink-0 text-[10.5px] text-[var(--gs-text-dim)]">rubric</span>
                  </button>
                )}
              </>
            )}
            {onOpenEvents && matches('event log') && (
              <>
              <div className="px-3 pb-1 pt-2.5 text-[10px] uppercase tracking-[.12em] text-[var(--gs-text-dim)]">Events</div>
              <button type="button" onClick={onOpenEvents} className="flex w-full items-center gap-1.5 px-3 py-[2px] text-left hover:bg-[var(--gs-bg-active)]">
                <span className="w-4 flex-shrink-0 text-center text-[var(--gs-text-ghost)]">⚑</span>
                <span className="min-w-0 flex-1 truncate text-[var(--gs-text)]">event log</span>
                <span className="ml-auto flex-shrink-0 text-[10.5px] text-[var(--gs-text-dim)]">live</span>
              </button>
              </>
            )}
            {(goalEvidence ?? []).filter((e) => matches(`evidence ${e.name} ${e.requirementTitle}`)).length > 0 && (
              <div className="px-3 pb-1 pt-2.5 text-[10px] uppercase tracking-[.12em] text-[var(--gs-text-dim)]">Evidence</div>
            )}
            {(goalEvidence ?? []).filter((e) => matches(`evidence ${e.name} ${e.requirementTitle}`)).map((e) => (
              <button key={e.evidenceId} type="button" onClick={() => onOpenEvidence?.(e.requirementId, e.evidenceId)} title={e.requirementTitle}
                className="flex w-full items-center gap-1.5 px-3 py-[2px] text-left hover:bg-[var(--gs-bg-active)]">
                <span className="w-4 flex-shrink-0 text-center text-[var(--gs-text-ghost)]">▸</span>
                <span className="min-w-0 flex-1 truncate text-[var(--gs-text)]">{e.name}</span>
                <span className="ml-auto flex-shrink-0 truncate text-[10.5px] text-[var(--gs-text-dim)]">{e.requirementTitle.slice(0, 18)}</span>
              </button>
            ))}
            {(groups.find(([k]) => k === 'evidence')?.[1] ?? []).map(row)}
            {groups.length === 0 && (
              <div className="px-3 py-4 text-center text-[var(--gs-text-dim)]">
                No artifacts yet.
                <div className="mt-1 text-[10px] text-[var(--gs-text-ghost)]">Goal evidence, demos and reports land here.</div>
              </div>
            )}
            {groups.filter(([kind]) => kind !== 'evidence').map(([kind, arts]) => (
              <div key={kind}>
                <div className="px-3 pb-1 pt-2.5 text-[10px] uppercase tracking-[.12em] text-[var(--gs-text-dim)]">{KIND_LABEL[kind]}</div>
                {arts.map(row)}
              </div>
            ))}
            <div className="px-3 pb-1 pt-2.5 text-[10px] uppercase tracking-[.12em] text-[var(--gs-text-dim)]">Notes</div>
            {notes.map((n) => (
              <button key={n.id} type="button" onClick={() => onOpenNote?.(n.id, n.title)} className="flex w-full items-center gap-1.5 px-3 py-[2px] text-left hover:bg-[var(--gs-bg-active)]">
                <span className="w-4 flex-shrink-0 text-center text-[var(--gs-text-ghost)]">✎</span>
                <span className="min-w-0 flex-1 truncate text-[var(--gs-text-dim)]">{n.title}</span>
              </button>
            ))}
            {onOpenNote && (
              <button type="button" onClick={() => onOpenNote(null, 'New note')} className="flex w-full items-center gap-1.5 px-3 py-[2px] text-left text-[var(--gs-text-dim)] hover:bg-[var(--gs-bg-active)]">
                <span className="w-4 flex-shrink-0 text-center">＋</span>New note
              </button>
            )}
            {reports.filter((r) => matches(`${r.kind} ${r.surface} ${r.note}`)).length > 0 && (
              <div className="px-3 pb-1 pt-2.5 text-[10px] uppercase tracking-[.12em] text-[var(--gs-text-dim)]">Reports · good + bad</div>
            )}
            {reports.filter((r) => matches(`${r.kind} ${r.surface} ${r.note}`)).map((r) => (
              <button key={r.path} type="button" onClick={() => onOpenReport?.(r.path)} title={r.note}
                className="flex w-full items-center gap-1.5 px-3 py-[2px] text-left hover:bg-[var(--gs-bg-active)]">
                <span className={`flex-shrink-0 rounded-full border px-1 text-[9px] uppercase ${REPORT_TONE[r.kind] ?? 'border-[var(--gs-border)] text-[var(--gs-text-dim)]'}`}>{r.kind}</span>
                <span className="min-w-0 flex-1 truncate text-[var(--gs-text)]">{r.surface}</span>
              </button>
            ))}
            {reports.filter((r) => r.rating !== undefined && matches(`${r.surface}`)).length > 0 && (
              <div className="px-3 pb-1 pt-2.5 text-[10px] uppercase tracking-[.12em] text-[var(--gs-text-dim)]">Rated precedents · seed from these</div>
            )}
            {reports.filter((r) => r.rating !== undefined && matches(`${r.surface}`)).map((r) => (
              <button key={`prec:${r.path}`} type="button" onClick={onOpenGoalPane} title={r.surface}
                className="flex w-full items-center gap-1.5 px-3 py-[2px] text-left hover:bg-[var(--gs-bg-active)]">
                <span className="w-4 flex-shrink-0 text-center text-[var(--gs-text-ghost)]">⛓</span>
                <span className="min-w-0 flex-1 truncate text-[var(--gs-text)]">{r.surface}</span>
                <span className="ml-auto flex-shrink-0 text-[10px] tracking-[1px] text-[var(--gs-warning)]">{'★'.repeat(Math.min(5, r.rating ?? 0))}{'☆'.repeat(Math.max(0, 5 - (r.rating ?? 0)))}</span>
              </button>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
