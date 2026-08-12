/** @jsxImportSource react */
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactElement } from 'react';
import { useFileTree, FileTree } from '@pierre/trees/react';
import type { GitStatusEntry } from '@pierre/trees';
import type { SessionBackend } from '../session/backend.js';
import type { ReviewChangedFile } from '../types/review.js';
import { KIND_ICON, KIND_LABEL, KIND_ORDER, classifyArtifact, toGoalRelative, type ArtifactKind, decodeBase64Utf8 } from './artifact-kinds.js';
import { shareArtifactToClipboard } from './share-artifact.web.js';
import { toast } from '../lib/sonner.web.js';
import { deriveNoteLabel } from './note-label.js';
import { ReviewDiffView, requestFileContext, useReviewThreads, fileViewPatch } from './review-diff-view.web.js';
import { documentKindFor, HtmlDocFrame, PdfDocFrame } from './document-preview.web.js';
import { filterRepoTreeEntries } from './repo-tree-search.js';
import { mediaKindFor } from '../core/media-types.js';
import { parseWith } from '../core/schema-parse.js';
import { reportSchema } from '../core/artifact-envelopes.js';

/**
 * RightRail — the workspace view's persistent right column (mock: RightRail.tsx).
 * Repo mode: file tree with git status, diff-vs-base, Changes + commit box.
 * Artifacts mode: the workspace's artifacts mount, click → full viewer.
 * Collapsed state persists; the rail renders a thin reopen strip when closed.
 */

const RAIL_CLOSED_KEY = 'gssh:workspace-right-rail-closed';
const RAIL_MODE_KEY = 'gssh:workspace-right-rail-mode';
const RAIL_WIDTH_KEY = 'gssh:workspace-right-rail-width';
const DEFAULT_RAIL_WIDTH = 320;
const MIN_RAIL_WIDTH = 240;
const MAX_RAIL_WIDTH = 640;

/** Stored rail width, clamped. An unset key reads back as `null`, and
 *  `Number(null)` is a finite `0` — so the absent case must be rejected
 *  before clamping or every fresh client silently starts at MIN. */
function readStoredRailWidth(): number {
  try {
    const raw = window.localStorage.getItem(RAIL_WIDTH_KEY);
    if (raw === null) return DEFAULT_RAIL_WIDTH;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) return DEFAULT_RAIL_WIDTH;
    return Math.min(MAX_RAIL_WIDTH, Math.max(MIN_RAIL_WIDTH, value));
  } catch {
    return DEFAULT_RAIL_WIDTH;
  }
}

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
  /** Opened from a search hit — the viewer scrolls to this 1-based line. */
  line?: number;
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
  const [width, setWidth] = useState(readStoredRailWidth);
  useEffect(() => { try { window.localStorage.setItem(RAIL_WIDTH_KEY, String(width)); } catch { /* */ } }, [width]);

  /** The handle sits on the rail's LEFT edge, so dragging left (negative
   *  delta) must widen it — hence `initialWidth - delta`, mirrored from the
   *  workspace sidebar's handle, which sits on its right and adds. */
  const handleResizeStart = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    const initialClientX = event.clientX;
    const initialWidth = width;
    const handleMove = (moveEvent: MouseEvent) => {
      setWidth(Math.min(MAX_RAIL_WIDTH, Math.max(MIN_RAIL_WIDTH, initialWidth - (moveEvent.clientX - initialClientX))));
    };
    const handleUp = () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
  }, [width]);

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
    <>
      <div
        className="hidden sm:block w-1.5 flex-shrink-0 cursor-col-resize border-l border-r border-[var(--gs-border-muted)] bg-[var(--gs-bg)] hover:bg-[var(--gs-bg-active)]"
        onMouseDown={handleResizeStart}
        title="Resize rail"
      />
      <aside className="gs-ui flex h-full flex-shrink-0 flex-col border-l border-[var(--gs-border-muted)] bg-[var(--gs-bg)]" style={{ width }}>
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
    </>
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
  const [branches, setBranches] = useState<string[]>([]);
  /** Tree scope: 'all' shows the full working directory (tracked + untracked
   *  on disk); 'changed' filters to files that differ from base. Defaults to
   *  changed while reviewing, full otherwise. */
  const [treeFilter, setTreeFilter] = useState<'all' | 'changed'>(reviewing ? 'changed' : 'all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [commitMsg, setCommitMsg] = useState('');
  const [committing, setCommitting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  /* File-name search filters the already-loaded tree immediately. Content
     search replaces it after an explicit Enter-triggered backend query. */
  const [searchScope, setSearchScope] = useState<'files' | 'contents'>('files');
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState<{ hits: RepoSearchHit[]; truncated: boolean; query: string } | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const runSearch = useCallback(async (raw: string): Promise<void> => {
    const q = raw.trim();
    if (!q) { setSearch(null); setSearchError(null); return; }
    if (!backend?.searchRepoContent) { setSearchError('Search is unavailable on this connection.'); return; }
    setSearching(true);
    setSearchError(null);
    try {
      const r = await backend.searchRepoContent(workspaceId, q);
      setSearch({ hits: r.hits, truncated: r.truncated, query: q });
    } catch (e) {
      setSearchError(e instanceof Error ? e.message : 'Search failed');
      setSearch(null);
    } finally {
      setSearching(false);
    }
  }, [backend, workspaceId]);

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
          setBranches((r as { branches?: string[] }).branches ?? []);
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
  const treeEntries = useMemo(() => {
    const fileQuery = searchScope === 'files' ? query : '';
    return filterRepoTreeEntries(entries, changedSet, treeFilter, fileQuery);
  }, [changedSet, entries, query, searchScope, treeFilter]);

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
          {treeFilter === 'changed' ? 'Diffs' : 'Files'}
          {reviewing && <span className="rounded-full border border-[#4a3a1f] px-1.5 normal-case tracking-normal text-[var(--gs-warning)]">review</span>}
          {/* Scope toggle: full working dir (on disk, incl. untracked) vs only-changed. */}
          <span className="ml-auto flex items-center gap-0.5 normal-case tracking-normal">
            {(['all', 'changed'] as const).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setTreeFilter(f)}
                className={`px-1.5 py-0.5 text-[10px] ${treeFilter === f ? 'bg-[var(--gs-bg-active)] text-[var(--gs-text)]' : 'text-[var(--gs-text-dim)] hover:text-[var(--gs-text)]'}`}
                title={f === 'all' ? 'All files on disk (tracked + untracked)' : 'Only files changed vs base'}
              >
                {f === 'all' ? 'All' : 'Changed'}
              </button>
            ))}
          </span>
        </div>
        <div className="flex flex-shrink-0 items-center gap-2 border-b border-[var(--gs-border-muted)] px-3 py-1.5 text-[11px]">
          <span className="text-[var(--gs-text-dim)]">diff vs</span>
          <select
            value={baseOverride || baseBranch}
            onChange={(e) => setBaseOverride(e.target.value === baseBranch ? '' : e.target.value)}
            className="border border-[var(--gs-border)] bg-[var(--gs-bg-elevated)] px-1.5 py-0.5 text-[11px] text-[var(--gs-text)]"
          >
            {[...new Set([baseBranch, ...branches].filter(Boolean))].map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
        </div>
        <div className="flex flex-shrink-0 items-center gap-1.5 border-b border-[var(--gs-border-muted)] px-3 py-1.5 text-[11px]">
          <span className="text-[var(--gs-text-dim)]">⌕</span>
          <span className="flex flex-shrink-0 border border-[var(--gs-border)] font-[family-name:var(--gs-font-mono)] text-[9px]">
            {(['files', 'contents'] as const).map((scope) => (
              <button
                key={scope}
                type="button"
                onClick={() => {
                  setSearchScope(scope);
                  setSearch(null);
                  setSearchError(null);
                }}
                className={`px-1.5 py-0.5 uppercase ${
                  searchScope === scope
                    ? 'bg-[var(--gs-bg-active)] text-[var(--gs-text)]'
                    : 'text-[var(--gs-text-dim)] hover:text-[var(--gs-text)]'
                }`}
                title={scope === 'files' ? 'Filter filenames and paths' : 'Search file contents'}
              >
                {scope}
              </button>
            ))}
          </span>
          <input
            value={query}
            onChange={(e) => {
              const next = e.target.value;
              setQuery(next);
              if (!next.trim() || searchScope === 'files') {
                setSearch(null);
                setSearchError(null);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && searchScope === 'contents') void runSearch(query);
              if (e.key === 'Escape') {
                setQuery('');
                setSearch(null);
                setSearchError(null);
              }
            }}
            placeholder={searchScope === 'files' ? 'Filter filenames…' : 'Search file contents…'}
            title={searchScope === 'files' ? 'Filter filenames and paths as you type' : 'Repo-wide content search — press Enter'}
            className="min-w-0 flex-1 border border-[var(--gs-border)] bg-[var(--gs-bg-elevated)] px-1.5 py-0.5 text-[11px] text-[var(--gs-text)] outline-none focus:border-[var(--gs-accent)]"
          />
          {(query.trim() || search || searching) && (
            <button
              type="button"
              onClick={() => {
                setQuery('');
                setSearch(null);
                setSearchError(null);
              }}
              title="Clear search"
              className="flex-shrink-0 px-1 text-[var(--gs-text-dim)] hover:text-[var(--gs-text)]"
            >
              ✕
            </button>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto pb-1 text-[11.5px]">
          {searchScope === 'contents' && searching ? (
            <div className="px-3 py-3 text-center text-[var(--gs-text-dim)]">Searching…</div>
          ) : searchScope === 'contents' && searchError ? (
            <div className="px-3 py-3 text-center text-[var(--gs-danger)]">{searchError}</div>
          ) : searchScope === 'contents' && search ? (
            <RepoSearchResults hits={search.hits} truncated={search.truncated} query={search.query} onOpenFile={onOpenFile} />
          ) : loading && entries.length === 0 ? (
            <div className="px-3 py-3 text-center text-[var(--gs-text-dim)]">Loading…</div>
          ) : error ? (
            <div className="px-3 py-3 text-center text-[var(--gs-danger)]">{error}</div>
          ) : searchScope === 'files' && query.trim() && treeEntries.length === 0 ? (
            <div className="px-3 py-3 text-center text-[var(--gs-text-dim)]">No matching files</div>
          ) : (
            <PierreRepoTree
              entries={treeEntries}
              changedSet={changedSet}
              onOpenFile={onOpenFile}
            />
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

/* ── Repo content search ──────────────────────────────────────────────────── */

interface RepoSearchHit { path: string; line: number; text: string }

/**
 * Repo-wide content search, rendered in place of the file tree while a query is
 * active. A hit opens the SAME viewer the tree opens, scrolled to the matching
 * line — so search is a way into the repo view, not a separate reader.
 */
function RepoSearchResults({ hits, truncated, query, onOpenFile }: {
  hits: RepoSearchHit[];
  truncated: boolean;
  query: string;
  onOpenFile: (file: RepoFileOpen) => void;
}): ReactElement {
  /* Group by file: 30 hits across 3 files should read as 3 files. */
  const byFile = useMemo(() => {
    const map = new Map<string, RepoSearchHit[]>();
    for (const hit of hits) {
      const list = map.get(hit.path);
      if (list) list.push(hit); else map.set(hit.path, [hit]);
    }
    return [...map.entries()];
  }, [hits]);

  if (hits.length === 0) {
    return <div className="px-3 py-3 text-center text-[var(--gs-text-ghost)]">No matches for “{query}”.</div>;
  }

  return (
    <div className="pb-2">
      <div className="px-3 py-1 text-[10px] uppercase tracking-[.1em] text-[var(--gs-text-muted)]">
        {hits.length}{truncated ? '+' : ''} match{hits.length === 1 ? '' : 'es'} in {byFile.length} file{byFile.length === 1 ? '' : 's'}
      </div>
      {byFile.map(([filePath, fileHits]) => (
        <div key={filePath} className="mb-1">
          <div className="truncate px-3 py-[2px] font-[family-name:var(--gs-font-mono)] text-[10.5px] text-[var(--gs-text-dim)]" title={filePath}>
            {filePath}
          </div>
          {fileHits.map((hit) => (
            <button
              key={`${hit.line}`}
              type="button"
              onClick={() => onOpenFile({ path: hit.path, changed: false, line: hit.line })}
              className="flex w-full items-start gap-2 px-3 py-[1px] text-left hover:bg-[var(--gs-bg-active)]"
              title={`${filePath}:${hit.line}`}
            >
              <span className="w-8 flex-shrink-0 text-right font-[family-name:var(--gs-font-mono)] text-[10px] tabular-nums text-[var(--gs-text-ghost)]">{hit.line}</span>
              <span className="min-w-0 flex-1 truncate font-[family-name:var(--gs-font-mono)] text-[10.5px] text-[var(--gs-text)]">{hit.text.trim()}</span>
            </button>
          ))}
        </div>
      ))}
      {truncated && <div className="px-3 py-1 text-[10px] text-[var(--gs-text-ghost)]">Showing the first results — narrow the query for more.</div>}
    </div>
  );
}

/* ── Repo file panel (dock tab content) ───────────────────────────────────────
   VIEW is the default: clicking a file shows the FILE, the way an editor does.
   Diff-vs-a-ref is a toggle on top of it, not the landing state — diff-first is
   the Change Guide's job, and a reader browsing the tree is usually reading,
   not reviewing a change. Both modes render through the SAME ReviewDiffView, so
   line comments, the hover '+', drag-select and inline threads work identically
   whether or not a diff is on screen (see fileViewPatch). */

/** Lines above which View mode waits for a click before highlighting.
 *  shiki runs on the main thread; a 20k-line file would freeze the pane. */
const VIEW_RENDER_GATE = 2000;
/** Hard cap on what View mode will render even after the gate is accepted. */
const VIEW_MAX_LINES = 6000;

export function RepoFilePanel({ backend, workspaceId, projectName, workspaceName, path, changed, prevPath, line }: {
  backend: SessionBackend | null;
  workspaceId: string;
  projectName: string;
  workspaceName: string;
  path: string;
  changed: boolean;
  prevPath?: string;
  /** Scroll target when opened from a search hit. */
  line?: number;
}): ReactElement {
  const [mode, setMode] = useState<'view' | 'diff'>('view');
  /** '' = the workspace's base branch (whatever the server resolves). */
  const [diffRef, setDiffRef] = useState('');
  const [refDraft, setRefDraft] = useState('');
  const [baseBranch, setBaseBranch] = useState('');
  const [docView, setDocView] = useState<'doc' | 'source'>('doc');
  const [gateAccepted, setGateAccepted] = useState(false);

  const [read, setRead] = useState<{ base64: string | null; size: number; truncated: boolean } | null>(null);
  const [patch, setPatch] = useState<string | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [diffState, setDiffState] = useState<'idle' | 'loading' | 'ready' | 'empty' | 'error'>('idle');

  const docKind = documentKindFor(path);
  const scrollRef = useRef<HTMLDivElement>(null);

  /* One get_threads for the pane; both modes annotate from it. A file opened
     from the tree is a REVIEW surface, not a preview — same threads, same
     affordances as the Change Guide. */
  const { threads, actions } = useReviewThreads(backend, projectName, workspaceName);
  /* Context must come from the SAME ref the diff did, or expanding a gap would
     splice in text from a different version of the file. */
  const requestContext = useCallback(
    () => requestFileContext(backend, projectName, workspaceName, path, prevPath, diffRef || undefined),
    [backend, projectName, workspaceName, path, prevPath, diffRef],
  );

  /* ── View: the file's current content ─────────────────────────────────── */
  useEffect(() => {
    let alive = true;
    setState('loading');
    setRead(null);
    setGateAccepted(false);
    setDocView('doc');
    void (async () => {
      try {
        const r = await backend?.readRepoFile?.(workspaceId, path);
        if (!alive) return;
        if (!r || r.base64 === null) { setState('error'); return; }
        setRead(r);
        setState('ready');
      } catch {
        if (alive) setState('error');
      }
    })();
    return () => { alive = false; };
  }, [backend, workspaceId, path]);

  /* ── Diff: fetched only once the toggle is actually used ──────────────── */
  useEffect(() => {
    if (mode !== 'diff' || !backend?.sendReviewRequest) return;
    let alive = true;
    setDiffState('loading');
    setPatch(null);
    void (async () => {
      try {
        const r = await backend.sendReviewRequest!({
          op: 'get_file_diff', projectName, workspaceName, filePath: path, prevFilePath: prevPath,
          base: diffRef || undefined,
        });
        if (!alive) return;
        const payload = (r as { diff?: string; patch?: string; baseBranch?: string }) ?? {};
        if (payload.baseBranch) setBaseBranch(payload.baseBranch);
        const text = payload.patch ?? payload.diff;
        if (text && text.trim()) { setPatch(text); setDiffState('ready'); }
        else setDiffState('empty');
      } catch {
        if (alive) setDiffState('error');
      }
    })();
    return () => { alive = false; };
  }, [mode, diffRef, backend, projectName, workspaceName, path, prevPath]);

  /* Learn the base branch's real name so the ref picker can name it. */
  useEffect(() => {
    if (baseBranch || !backend?.sendReviewRequest) return;
    let alive = true;
    void backend.sendReviewRequest({ op: 'get_changed_files', projectName, workspaceName })
      .then((r) => {
        if (alive && r && 'op' in r && r.op === 'changed_files') setBaseBranch((r as { baseBranch?: string }).baseBranch ?? '');
      })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [backend, projectName, workspaceName, baseBranch]);

  const text = useMemo(() => {
    if (!read?.base64) return null;
    try { return decodeBase64Utf8(read.base64); } catch { return null; }
  }, [read]);

  /* The whole file, expressed as an all-context patch so the review surface
     renders it. Only built once the size gate is satisfied. */
  const viewPatch = useMemo(() => {
    if (text === null) return null;
    const total = text.split('\n').length;
    if (total > VIEW_RENDER_GATE && !gateAccepted) return null;
    return fileViewPatch(path, text, VIEW_MAX_LINES);
  }, [text, path, gateAccepted]);

  /* Scroll to the line a search hit pointed at, once it has actually rendered.
     The rows live inside the renderer's SHADOW root, so a light-DOM query never
     sees them — the lookup has to hop through the host's shadowRoot. Rows are
     also built asynchronously, so this polls briefly rather than assuming the
     line exists on the first frame. */
  useEffect(() => {
    if (!line || mode !== 'view' || !viewPatch) return;
    let tries = 0;
    const timer = window.setInterval(() => {
      tries += 1;
      const host = scrollRef.current;
      if (!host || tries > 60) { window.clearInterval(timer); return; }
      const shadowHost = host.querySelector('diffs-container');
      const row = shadowHost?.shadowRoot?.querySelector(`[data-line="${line}"]`);
      if (row instanceof HTMLElement) {
        row.scrollIntoView({ block: 'center' });
        // A brief tint so the eye lands on the matched line, not just its region.
        row.style.background = 'var(--gs-bg-active)';
        window.setTimeout(() => { row.style.background = ''; }, 2200);
        window.clearInterval(timer);
      }
    }, 50);
    return () => window.clearInterval(timer);
  }, [line, mode, viewPatch]);

  const totalLines = text === null ? 0 : text.split('\n').length;
  const showingDoc = docKind !== null && docView === 'doc' && mode === 'view';

  return (
    <div className="flex h-full min-h-0 flex-col text-[12px]">
      <div className="flex flex-shrink-0 flex-wrap items-center gap-2 border-b border-[var(--gs-border-muted)] px-3 py-1.5">
        <span className="truncate font-[family-name:var(--gs-font-mono)] text-[12px] text-[var(--gs-text)]">{path}</span>
        {changed && <span className="flex-shrink-0 rounded-full border border-[#4a3a1f] px-1.5 text-[10px] text-[var(--gs-warning)]">changed</span>}

        {/* View / Diff — the mode toggle. View is where a file opens. */}
        <span className="ml-auto inline-flex flex-shrink-0 border border-[var(--gs-border)] text-[10.5px]">
          {(['view', 'diff'] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              title={m === 'view' ? 'Show the file as it is now' : 'Compare this file against a ref'}
              className={`px-2 py-[2px] ${mode === m ? 'bg-[var(--gs-bg-active)] text-[var(--gs-text)]' : 'text-[var(--gs-text-dim)]'}`}
            >
              {m === 'view' ? 'view' : 'diff'}
            </button>
          ))}
        </span>

        {/* Document / source, for the file types that ARE documents. */}
        {docKind && mode === 'view' && (
          <span className="inline-flex flex-shrink-0 border border-[var(--gs-border)] text-[10.5px]">
            {(['doc', 'source'] as const).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setDocView(v)}
                disabled={v === 'source' && docKind === 'pdf'}
                className={`px-2 py-[2px] disabled:opacity-30 ${docView === v ? 'bg-[var(--gs-bg-active)] text-[var(--gs-text)]' : 'text-[var(--gs-text-dim)]'}`}
              >
                {v === 'doc' ? (docKind === 'pdf' ? '▤ document' : '▸ page') : 'source'}
              </button>
            ))}
          </span>
        )}
      </div>

      {/* Ref picker — only meaningful in diff mode. Base branch, HEAD, or any
          ref typed in; there is deliberately no commit browser in v1. */}
      {mode === 'diff' && (
        <div className="flex flex-shrink-0 flex-wrap items-center gap-1.5 border-b border-[var(--gs-border-muted)] px-3 py-1.5 text-[11px]">
          <span className="text-[var(--gs-text-dim)]">diff vs</span>
          {[
            { value: '', label: baseBranch || 'base branch' },
            { value: 'HEAD', label: 'HEAD' },
          ].map((opt) => (
            <button
              key={opt.value || 'base'}
              type="button"
              onClick={() => { setDiffRef(opt.value); setRefDraft(''); }}
              className={`border px-1.5 py-[1px] ${diffRef === opt.value
                ? 'border-[var(--gs-accent)] text-[var(--gs-accent)]'
                : 'border-[var(--gs-border)] text-[var(--gs-text-dim)] hover:border-[var(--gs-border-active)]'}`}
            >
              {opt.label}
            </button>
          ))}
          <input
            value={refDraft}
            onChange={(e) => setRefDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && refDraft.trim()) setDiffRef(refDraft.trim()); }}
            placeholder="branch, tag or sha…"
            title="Any ref git understands — press Enter"
            className="w-[170px] border border-[var(--gs-border)] bg-[var(--gs-bg-elevated)] px-1.5 py-[1px] text-[11px] text-[var(--gs-text)] outline-none focus:border-[var(--gs-accent)]"
          />
          {diffRef && diffRef !== 'HEAD' && (
            <span className="font-[family-name:var(--gs-font-mono)] text-[10.5px] text-[var(--gs-accent)]">@ {diffRef}</span>
          )}
        </div>
      )}

      <div ref={scrollRef} className={`min-h-0 flex-1 overflow-auto ${showingDoc ? '' : 'p-2'}`}>
        {mode === 'diff' ? (
          diffState === 'loading' ? (
            <div className="flex h-full items-center justify-center text-[var(--gs-text-dim)]">Loading diff…</div>
          ) : diffState === 'error' ? (
            <div className="flex h-full items-center justify-center text-[var(--gs-danger)]">Could not diff {path} against {diffRef || baseBranch || 'base'}.</div>
          ) : diffState === 'empty' || !patch ? (
            <div className="flex h-full items-center justify-center text-[var(--gs-text-ghost)]">No changes vs {diffRef || baseBranch || 'base'}.</div>
          ) : (
            <ReviewDiffView
              patch={patch}
              filePath={path}
              prevFilePath={prevPath}
              threads={threads}
              actions={actions}
              onRequestContext={requestContext}
              contextKey={`${projectName}/${workspaceName}/${path}@${diffRef || 'base'}`}
            />
          )
        ) : state === 'loading' ? (
          <div className="flex h-full items-center justify-center text-[var(--gs-text-dim)]">Loading…</div>
        ) : state === 'error' || !read ? (
          <div className="flex h-full items-center justify-center text-[var(--gs-danger)]">Failed to load {path}</div>
        ) : showingDoc && docKind === 'pdf' ? (
          <PdfDocFrame base64={read.base64 ?? ''} title={path} />
        ) : showingDoc && docKind === 'html' ? (
          <HtmlDocFrame html={text ?? ''} title={path} />
        ) : text === null ? (
          <div className="flex h-full items-center justify-center text-[var(--gs-text-dim)]">Binary file — no inline view.</div>
        ) : viewPatch === null ? (
          /* Size gate: shiki blocks the main thread, so a big file waits for
             an explicit click rather than freezing the pane on open. */
          <div className="flex h-full flex-col items-center justify-center gap-2 text-[var(--gs-text-dim)]">
            <span>{totalLines.toLocaleString()} lines — large file.</span>
            <button
              type="button"
              onClick={() => setGateAccepted(true)}
              className="border border-[var(--gs-border)] px-2 py-1 text-[11px] text-[var(--gs-accent)] hover:border-[var(--gs-accent)]"
            >
              Render {Math.min(totalLines, VIEW_MAX_LINES).toLocaleString()} lines
            </button>
          </div>
        ) : (
          <>
            <ReviewDiffView
              plain
              patch={viewPatch.patch}
              filePath={path}
              threads={threads}
              actions={actions}
              contextKey={`${projectName}/${workspaceName}/${path}@view`}
            />
            {viewPatch.truncated && (
              <div className="px-2 py-1 text-[10.5px] text-[var(--gs-text-dim)]">
                Showing the first {viewPatch.shownLines.toLocaleString()} of {viewPatch.totalLines.toLocaleString()} lines.
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/* ── Artifacts mode ────────────────────────────────────────────────────────── */

function rowMeta(path: string): string {
  const ext = path.includes('.') ? path.slice(path.lastIndexOf('.') + 1).toLowerCase() : '';
  if (ext === 'md') return 'doc';
  if (ext === 'json') return 'json';
  const kind = mediaKindFor(path);
  if (kind === 'image') return 'img';
  if (kind === 'video') return 'video';
  if (kind === 'audio') return 'audio';
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
  // Favorites are DURABLE now: a `.favorites.json` manifest committed to the
  // workspace's artifacts branch, read/written through the daemon (survives a
  // machine move, syncs with the artifacts, and is readable by the rollup CLI).
  // `favs` holds MOUNT-relative paths (same basis as entries[].path).
  const legacyFavKey = `gssh:artifact-favs:${projectName}`;
  const [favs, setFavs] = useState<Set<string>>(new Set());
  const toggleFav = (id: string): void => {
    const fn = backend?.toggleWorkspaceFavorite;
    if (!fn) return;
    // Optimistic flip; the RPC returns the authoritative list and we reconcile.
    setFavs((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    fn.call(backend, workspaceId, id)
      .then((res) => {
        setFavs(new Set(res.favorites));
        // Favoriting a report snapshots its attachments server-side; refs whose
        // target could not be found are skipped (favorite still stuck) — say so.
        if (res.snapshotSkipped && res.snapshotSkipped.length > 0) {
          toast.warning(`Favorited, but ${res.snapshotSkipped.length} attachment${res.snapshotSkipped.length === 1 ? '' : 's'} could not be snapshotted: ${res.snapshotSkipped.join(', ')}`);
        }
      })
      .catch(() => setFavs((prev) => { // revert on failure (e.g. out-of-goal-scope)
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }));
  };

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
            const result = parseWith(reportSchema, JSON.parse(decodeBase64Utf8(raw.base64)));
            if (!result.ok) return null;
            const doc = result.data;
            return { path: e.path, kind: doc.kind, surface: doc.surface, note: doc.note, rating: doc.rating } as ReportRow;
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

  // Load favorites from the manifest (via RPC) and RECONCILE any legacy
  // browser-localStorage favorites into it once per browser. Reconciliation is
  // a server-side UNION that normalizes both path bases (old flat pre-goal-keyed
  // paths and new mount-relative `goals/<id>/…`) to the same goal-relative key,
  // so it dedups correctly and is idempotent. After merging, THIS browser's key
  // is cleared so it never re-injects stale entries.
  useEffect(() => {
    let alive = true;
    const listFn = backend?.listWorkspaceFavorites;
    if (!listFn) return;
    let legacy: string[] = [];
    try { legacy = JSON.parse(window.localStorage.getItem(legacyFavKey) ?? '[]') as string[]; } catch { legacy = []; }
    const mergeFn = backend?.mergeWorkspaceFavorites;
    const load = legacy.length > 0 && mergeFn
      ? mergeFn.call(backend, workspaceId, legacy).then((list) => {
          // Clear localStorage ONLY when every legacy favorite provably survived
          // into the manifest. The merge is existence-gated server-side, so a
          // reconcile that runs BEFORE this machine's artifacts migration (files
          // still flat, goal-keyed paths not yet on disk) would drop favorites —
          // clearing then would make that loss permanent. Keeping the key lets a
          // later reload (post-migration, files present) recover them. A dead
          // favorite (file genuinely gone) harmlessly keeps the key around.
          const survived = new Set(list.map(toGoalRelative));
          const allPreserved = legacy.every((p) => survived.has(toGoalRelative(p)));
          if (allPreserved) {
            try { window.localStorage.removeItem(legacyFavKey); } catch { /* */ }
          }
          return list;
        })
      : listFn.call(backend, workspaceId);
    load.then((list) => { if (alive) setFavs(new Set(list)); }).catch(() => { /* leave empty */ });
    return () => { alive = false; };
  }, [backend, workspaceId, legacyFavKey]);

  // Special files open their DEDICATED viewers, never the raw JSON pane — a
  // rubric is the ☰ rubric pane, a workflow the ⟜ workflow pane, the goal doc
  // the ◇ goal pane. This holds even for a favorited special file opened from
  // the Favorites view, so "rubric.json is just a json file" can't recur there.
  const openByKind = (path: string, kind: ArtifactKind): void => {
    if (kind === 'dashboard') onOpenDashboard(path);
    else if (kind === 'workflow' && onOpenWorkflowPane) onOpenWorkflowPane();
    else if (kind === 'rubric' && onOpenRubricPane) onOpenRubricPane();
    else if (kind === 'goal' && onOpenGoalPane) onOpenGoalPane();
    else onOpenArtifact(path);
  };

  const ql = query.trim().toLowerCase();
  const matches = (text: string): boolean => !ql || text.toLowerCase().includes(ql);

  // Which special files actually exist as artifacts (classified on the SAME
  // normalized basis as everything else, so a goal-keyed `goals/<id>/rubric.json`
  // counts). The GOAL section is the single curated home for these; the generic
  // kind groups must not re-list them (that duplication is the reported bug:
  // a second star-able goal.md and a raw-JSON rubric.json / workflow row).
  const specialPresent = useMemo(() => {
    let goal = false, rubric = false, workflow = false;
    for (const e of entries) {
      if (e.path === 'README.md' || e.path.endsWith('.report.json')) continue;
      const k = classifyArtifact(e.path);
      if (k === 'goal') goal = true;
      else if (k === 'rubric') rubric = true;
      else if (k === 'workflow') workflow = true;
    }
    return { goal, rubric, workflow };
  }, [entries]);

  // A kind is CURATED (surfaced only in the GOAL section) exactly when the GOAL
  // section shows a row for it — so nothing is ever hidden, only de-duplicated.
  const curatedGoal = Boolean(onOpenGoalPane);
  const curatedRubric = Boolean(onOpenRubricPane) && ((goalSummary?.reqCount ?? 0) > 0 || specialPresent.rubric);
  const curatedWorkflow = Boolean(onOpenWorkflowPane) && specialPresent.workflow;

  const groups = useMemo(() => {
    const byKind = new Map<ArtifactKind, Array<{ path: string; kind: ArtifactKind }>>();
    for (const e of entries) {
      if (e.path === 'README.md' || e.path.endsWith('.report.json')) continue;
      const kind = classifyArtifact(e.path);
      if ((kind === 'goal' && curatedGoal) || (kind === 'rubric' && curatedRubric) || (kind === 'workflow' && curatedWorkflow)) continue;
      if (!matches(`${kind} ${e.path}`)) continue;
      (byKind.get(kind) ?? byKind.set(kind, []).get(kind)!).push({ path: e.path, kind });
    }
    return KIND_ORDER.map((k) => [k, byKind.get(k) ?? []] as const).filter(([, a]) => a.length > 0);
  }, [entries, ql, curatedGoal, curatedRubric, curatedWorkflow]);

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
          onClick={() => void shareArtifactToClipboard(backend, projectName, workspaceName, a.path)}
          title="Share — copy a public link to this artifact (requires serve)"
          className="flex-shrink-0 px-0.5 text-[var(--gs-text-ghost)] opacity-0 hover:text-[var(--gs-accent)] group-hover:opacity-100"
        >
          ↗
        </button>
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
            {/* GOAL group (mock artifactTree Goal rows) — the SINGLE curated home
                for the goal doc, its rubric and its workflow spec. Each of those
                special files is excluded from the generic kind groups above, so it
                shows here exactly once, opening its dedicated pane (never raw JSON).
                Rows gate on their own search terms so the section stays findable. */}
            {(() => {
              const goalRow = curatedGoal && matches('goal doc goal.md');
              const chainRow = Boolean(goalSummary && goalSummary.chainLength > 1) && matches('chain goals');
              const rubricRow = curatedRubric && matches('rubric requirements rubric.json');
              const workflowRow = curatedWorkflow && matches('workflow spec');
              if (!goalRow && !chainRow && !rubricRow && !workflowRow) return null;
              return (
                <>
                  <div className="px-3 pb-1 pt-2.5 text-[10px] uppercase tracking-[.12em] text-[var(--gs-text-dim)]">Goal</div>
                  {goalRow && (
                    <button type="button" onClick={onOpenGoalPane} className="flex w-full items-center gap-1.5 px-3 py-[2px] text-left hover:bg-[var(--gs-bg-active)]">
                      <span className="w-4 flex-shrink-0 text-center text-[var(--gs-text-ghost)]">◇</span>
                      <span className="min-w-0 flex-1 truncate text-[var(--gs-text)]">goal.md</span>
                      <span className="ml-auto flex-shrink-0 text-[10.5px] text-[var(--gs-text-dim)]">doc</span>
                    </button>
                  )}
                  {chainRow && (
                    <button type="button" onClick={onOpenGoalPane} className="flex w-full items-center gap-1.5 px-3 py-[2px] text-left hover:bg-[var(--gs-bg-active)]">
                      <span className="w-4 flex-shrink-0 text-center text-[var(--gs-text-ghost)]">⛓</span>
                      <span className="min-w-0 flex-1 truncate text-[var(--gs-text)]">chain · {goalSummary!.chainLength} goals</span>
                      <span className="ml-auto flex-shrink-0 text-[10.5px] tabular-nums text-[var(--gs-text-dim)]">{goalSummary!.chainPosition} of {goalSummary!.chainLength}</span>
                    </button>
                  )}
                  {rubricRow && (
                    <button type="button" onClick={onOpenRubricPane} className="flex w-full items-center gap-1.5 px-3 py-[2px] text-left hover:bg-[var(--gs-bg-active)]">
                      <span className="w-4 flex-shrink-0 text-center text-[var(--gs-text-ghost)]">☰</span>
                      <span className="min-w-0 flex-1 truncate text-[var(--gs-text)]">{(goalSummary?.reqCount ?? 0) > 0 ? `${goalSummary!.reqCount} requirements` : 'rubric.json'}</span>
                      <span className="ml-auto flex-shrink-0 text-[10.5px] text-[var(--gs-text-dim)]">rubric</span>
                    </button>
                  )}
                  {workflowRow && (
                    <button type="button" onClick={onOpenWorkflowPane} className="flex w-full items-center gap-1.5 px-3 py-[2px] text-left hover:bg-[var(--gs-bg-active)]">
                      <span className="w-4 flex-shrink-0 text-center text-[var(--gs-text-ghost)]">⟜</span>
                      <span className="min-w-0 flex-1 truncate text-[var(--gs-text)]">workflow</span>
                      <span className="ml-auto flex-shrink-0 text-[10.5px] text-[var(--gs-text-dim)]">spec</span>
                    </button>
                  )}
                </>
              );
            })()}
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
            {groups.length === 0 && entries.length === 0 && (
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
              <div key={r.path} className="group flex w-full items-center gap-1.5 px-3 py-[2px] hover:bg-[var(--gs-bg-active)]">
                <button type="button" onClick={() => onOpenReport?.(r.path)} title={r.note}
                  className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
                  <span className={`flex-shrink-0 rounded-full border px-1 text-[9px] uppercase ${REPORT_TONE[r.kind] ?? 'border-[var(--gs-border)] text-[var(--gs-text-dim)]'}`}>{r.kind}</span>
                  <span className="min-w-0 flex-1 truncate text-[var(--gs-text)]">{r.surface}</span>
                </button>
                {/* Reports are favorite-gated for roll-up (docs/ARTIFACTS-FS.md):
                    an un-favorited report never reaches the corpus, so the ★ must
                    be reachable here — reports are excluded from the generic
                    artifact groups that carry it. */}
                <button type="button" onClick={() => toggleFav(r.path)} title="favorite — roll this report up into the corpus"
                  className={`flex-shrink-0 px-0.5 ${favs.has(r.path) ? 'text-[#f0b429]' : 'text-[var(--gs-text-ghost)] opacity-0 group-hover:opacity-100'}`}>
                  ★
                </button>
              </div>
            ))}
            {/* "Rated precedents" removed: it only read THIS workspace's own
                reports and clicking opened THIS workspace's goal doc, so it was
                self-referential, not precedents from past work. If reinstated it
                must read rated reports across every goal folder (inherited from
                main) and open the precedent itself. */}
          </>
        )}
      </div>
    </div>
  );
}
