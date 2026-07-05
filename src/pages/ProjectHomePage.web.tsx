/** @jsxImportSource react */
/**
 * ProjectHomePage — the project-level home (mock: ProjectHome.tsx).
 *
 * Sidebar: Overview / In process / Chains / Reports & notes / Artifacts.
 * Center:  CHAINS (goal chains grouped, per-goal phase dots) → IN PROCESS
 *          (workspaces with live agent state) → REPORTS & NOTES (workspace
 *          notes + project reports/ artifacts).
 * Right:   project artifacts rail (the artifacts repo's main branch, mounted
 *          at the base clone — docs/ARTIFACTS-FS.md).
 */

import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import type { SessionBackend } from '../session/backend.js';
import type { KanbanGoalItem } from '../app/shared/board/types.js';
import type { WorkspaceRuntimeEntry } from '../app/shared/workspace-runtime/types.js';
import { ArtifactPanel } from '../components/ArtifactPanel.web.js';

interface ArtifactEntry {
  path: string;
  size: number;
  pointer: boolean;
}

interface FeedItem {
  kind: 'note' | 'report';
  title: string;
  detail: string;
  /** report path for click-through */
  path?: string;
}

const PHASE_TONE: Record<string, string> = {
  plan: 'bg-[#1e3a5f]',
  code: 'bg-[#4a3a1f]',
  review: 'bg-[#3a2a4a]',
  ship: 'bg-[#1f4a2f]',
};

export function ProjectHomePage({
  projectName,
  goals,
  workspaces,
  backend,
  onBack,
  onOpenWorkspace,
  onOpenGoal,
}: {
  projectName: string;
  goals: KanbanGoalItem[];
  workspaces: WorkspaceRuntimeEntry[];
  backend: SessionBackend | null;
  onBack: () => void;
  onOpenWorkspace: (workspaceId: string) => void;
  onOpenGoal: (goal: KanbanGoalItem) => void;
}): ReactElement {
  const [artifacts, setArtifacts] = useState<ArtifactEntry[]>([]);
  const [artifactsError, setArtifactsError] = useState<string | null>(null);
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [viewerPath, setViewerPath] = useState<string | null>(null);
  const [section, setSection] = useState<'overview' | 'in-process' | 'chains' | 'reports' | 'artifacts'>('overview');

  // Chains grouped from the board's goal items.
  const chains = useMemo(() => {
    const map = new Map<string, { chainId: string; title: string; goals: KanbanGoalItem[] }>();
    for (const g of goals) {
      const existing = map.get(g.chainId);
      const list = [...(existing?.goals ?? []), g].sort((a, b) => a.chainPosition - b.chainPosition);
      map.set(g.chainId, { chainId: g.chainId, title: g.chainTitle, goals: list });
    }
    return [...map.values()].sort((a, b) => a.title.localeCompare(b.title));
  }, [goals]);

  const inProcess = useMemo(
    () => workspaces.filter((w) => w.agentSessionCount > 0 || w.sessions.length > 0 || (w.workspace.phase ?? 'code') !== 'ship'),
    [workspaces],
  );

  // Project artifacts (main branch via base mount).
  const loadArtifacts = useCallback(() => {
    const fn = backend?.listProjectArtifacts;
    if (!fn) {
      setArtifactsError('Project artifacts unavailable on this backend.');
      return;
    }
    fn.call(backend, projectName)
      .then((list) => { setArtifacts(list); setArtifactsError(null); })
      .catch((e) => setArtifactsError(e instanceof Error ? e.message : 'Failed to load artifacts'));
  }, [backend, projectName]);
  useEffect(() => { loadArtifacts(); }, [loadArtifacts]);

  // Reports & notes feed: project reports/ artifacts + notes across workspaces.
  useEffect(() => {
    let alive = true;
    void (async () => {
      const items: FeedItem[] = [];
      for (const a of artifacts) {
        if (a.path.startsWith('reports/')) {
          items.push({ kind: 'report', title: a.path.slice('reports/'.length), detail: 'project artifact', path: a.path });
        }
      }
      if (backend?.listWorkspaceNotes) {
        const results = await Promise.allSettled(
          workspaces.map(async (w) => ({
            ws: w.workspace.name,
            notes: await backend.listWorkspaceNotes!(projectName, w.workspace.name),
          })),
        );
        for (const r of results) {
          if (r.status !== 'fulfilled') continue;
          for (const n of r.value.notes) {
            const rec = n as { title?: string; name?: string; content?: string };
            items.push({
              kind: 'note',
              title: rec.title ?? rec.name ?? 'note',
              detail: `note · ${r.value.ws}`,
            });
          }
        }
      }
      if (alive) setFeed(items);
    })();
    return () => { alive = false; };
  }, [artifacts, backend, workspaces, projectName]);

  const artifactGroups = useMemo(() => {
    const byDir = new Map<string, ArtifactEntry[]>();
    for (const e of artifacts) {
      const dir = e.path.includes('/') ? e.path.slice(0, e.path.indexOf('/')) : '·';
      (byDir.get(dir) ?? byDir.set(dir, []).get(dir)!).push(e);
    }
    return [...byDir.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [artifacts]);

  const navItem = (id: typeof section, label: string, count?: number): ReactElement => (
    <button
      key={id}
      type="button"
      onClick={() => setSection(id)}
      className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs ${
        section === id ? 'bg-[var(--gs-bg-active)] text-[var(--gs-text)]' : 'text-[var(--gs-text-muted)] hover:bg-[var(--gs-bg-active)]'
      }`}
    >
      <span className="flex-1">{label}</span>
      {count !== undefined && <span className="text-[10px] text-[var(--gs-text-ghost)]">{count}</span>}
    </button>
  );

  const showChains = section === 'overview' || section === 'chains';
  const showInProcess = section === 'overview' || section === 'in-process';
  const showReports = section === 'overview' || section === 'reports';

  return (
    <div className="flex h-screen w-screen flex-col bg-[var(--gs-bg)] text-[13px]">
      {/* header */}
      <div className="flex flex-shrink-0 items-center gap-3 border-b border-[var(--gs-border)] bg-[var(--gs-bg-elevated)] px-3 py-2">
        <button type="button" onClick={onBack} className="text-xs text-[var(--gs-text-dim)] hover:text-[var(--gs-text)]">← Board</button>
        <span className="font-[family-name:var(--gs-font-mono)] text-sm font-medium text-[var(--gs-text)]">{projectName}</span>
        <span className="text-xs text-[var(--gs-text-ghost)]">project home · {chains.length} chain{chains.length === 1 ? '' : 's'} · {workspaces.length} workspace{workspaces.length === 1 ? '' : 's'}</span>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* sidebar */}
        <div className="flex w-[190px] flex-shrink-0 flex-col gap-0.5 border-r border-[var(--gs-border-muted)] p-2">
          <div className="px-2 pb-1 text-[10px] uppercase tracking-wider text-[var(--gs-text-ghost)]">Project</div>
          {navItem('overview', 'Overview')}
          {navItem('in-process', 'In process', inProcess.length)}
          {navItem('chains', 'Chains', chains.length)}
          {navItem('reports', 'Reports & notes', feed.length)}
          {navItem('artifacts', 'Artifacts', artifacts.length)}
        </div>

        {/* center */}
        <div className="min-w-0 flex-1 overflow-y-auto p-4">
          {viewerPath !== null ? (
            <div className="flex h-full min-h-0 flex-col">
              <button
                type="button"
                onClick={() => setViewerPath(null)}
                className="mb-2 self-start text-xs text-[var(--gs-text-dim)] hover:text-[var(--gs-text)]"
              >
                ← back
              </button>
              <div className="min-h-0 flex-1 border border-[var(--gs-border)]">
                <ArtifactPanel
                  path={viewerPath}
                  read={(p) => backend?.readProjectArtifact ? backend.readProjectArtifact(projectName, p) : Promise.reject(new Error('unavailable'))}
                />
              </div>
            </div>
          ) : section === 'artifacts' ? (
            <ProjectArtifactsList groups={artifactGroups} error={artifactsError} onOpen={setViewerPath} full />
          ) : (
            <>
              {showChains && (
                <section className="mb-5">
                  <div className="mb-2 text-[10px] uppercase tracking-wider text-[var(--gs-text-ghost)]">Chains</div>
                  {chains.length === 0 ? (
                    <div className="text-xs text-[var(--gs-text-dim)]">No goal chains yet — plan one from the board.</div>
                  ) : (
                    <div className="flex flex-col gap-2">
                      {chains.map((c) => (
                        <div key={c.chainId} className="border border-[var(--gs-border)] bg-[var(--gs-bg-elevated)] px-3 py-2">
                          <div className="mb-1.5 flex items-center gap-2">
                            <span className="text-[var(--gs-text)]">⛓ {c.title}</span>
                            <span className="text-[10px] text-[var(--gs-text-ghost)]">{c.goals.length} goal{c.goals.length === 1 ? '' : 's'}</span>
                          </div>
                          <div className="flex flex-wrap gap-1.5">
                            {c.goals.map((g) => (
                              <button
                                key={g.id}
                                type="button"
                                onClick={() => onOpenGoal(g)}
                                title={`${g.title} · ${g.phase}${g.status === 'planned' ? ' · planned' : ''}`}
                                className={`flex items-center gap-1.5 rounded-full border border-[var(--gs-border)] px-2 py-0.5 text-[11px] ${g.status === 'planned' ? 'text-[var(--gs-text-dim)]' : 'text-[var(--gs-text)]'} hover:border-[var(--gs-text-dim)]`}
                              >
                                <span className={`h-1.5 w-1.5 rounded-full ${PHASE_TONE[g.phase] ?? 'bg-[var(--gs-border)]'}`} />
                                <span className="max-w-[220px] truncate">{g.title}</span>
                              </button>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </section>
              )}

              {showInProcess && (
                <section className="mb-5">
                  <div className="mb-2 text-[10px] uppercase tracking-wider text-[var(--gs-text-ghost)]">In process</div>
                  {inProcess.length === 0 ? (
                    <div className="text-xs text-[var(--gs-text-dim)]">Nothing in flight.</div>
                  ) : (
                    <div className="flex flex-col gap-1">
                      {inProcess.map((w) => (
                        <button
                          key={w.workspace.selectionKey}
                          type="button"
                          onClick={() => onOpenWorkspace(w.workspace.selectionKey)}
                          className="flex items-center gap-2 border border-[var(--gs-border)] bg-[var(--gs-bg-elevated)] px-3 py-1.5 text-left hover:border-[var(--gs-text-dim)]"
                        >
                          <span className={`h-2 w-2 flex-shrink-0 rounded-full ${w.stripStatus.primaryColor === 'red' ? 'bg-[var(--gs-danger)]' : w.stripStatus.primaryColor === 'orange' ? 'bg-[var(--gs-warning)]' : w.stripStatus.primaryColor === 'blue' ? 'bg-[var(--gs-info)]' : 'bg-[var(--gs-border)]'}`} />
                          <span className="min-w-0 flex-1 truncate font-[family-name:var(--gs-font-mono)] text-[12px] text-[var(--gs-text)]">{w.workspace.name}</span>
                          {w.workspace.phase && <span className="rounded-full border border-[var(--gs-border)] px-1.5 text-[10px] uppercase text-[var(--gs-text-dim)]">{w.workspace.phase}</span>}
                          {w.agentSessionCount > 0 && <span className="text-[10px] text-[var(--gs-accent)]">✦ {w.agentSessionCount} agent{w.agentSessionCount === 1 ? '' : 's'}</span>}
                          {w.pendingPermissionCount > 0 && <span className="text-[10px] text-[var(--gs-warning)]">⚡ {w.pendingPermissionCount}</span>}
                        </button>
                      ))}
                    </div>
                  )}
                </section>
              )}

              {showReports && (
                <section className="mb-5">
                  <div className="mb-2 text-[10px] uppercase tracking-wider text-[var(--gs-text-ghost)]">Reports & notes</div>
                  {feed.length === 0 ? (
                    <div className="text-xs text-[var(--gs-text-dim)]">No reports or notes yet — roll-ups and workspace notes land here.</div>
                  ) : (
                    <div className="flex flex-col gap-1">
                      {feed.map((f, i) => (
                        <button
                          key={`${f.kind}:${f.title}:${i}`}
                          type="button"
                          disabled={!f.path}
                          onClick={() => f.path && setViewerPath(f.path)}
                          className={`flex items-center gap-2 border border-[var(--gs-border-muted)] px-3 py-1.5 text-left ${f.path ? 'hover:border-[var(--gs-text-dim)]' : 'cursor-default'}`}
                        >
                          <span className={`rounded-full border px-1.5 text-[9px] uppercase ${f.kind === 'report' ? 'border-[#1f4a2f] text-[var(--gs-accent)]' : 'border-[var(--gs-border)] text-[var(--gs-text-dim)]'}`}>{f.kind}</span>
                          <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--gs-text)]">{f.title}</span>
                          <span className="text-[10px] text-[var(--gs-text-ghost)]">{f.detail}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </section>
              )}
            </>
          )}
        </div>

        {/* right: project artifacts rail */}
        {section !== 'artifacts' && (
          <div className="hidden w-[280px] flex-shrink-0 flex-col overflow-y-auto border-l border-[var(--gs-border-muted)] p-2 lg:flex">
            <div className="px-1 pb-1 text-[10px] uppercase tracking-wider text-[var(--gs-text-ghost)]">Project artifacts · main</div>
            <ProjectArtifactsList groups={artifactGroups} error={artifactsError} onOpen={setViewerPath} />
          </div>
        )}
      </div>

    </div>
  );
}

function ProjectArtifactsList({ groups, error, onOpen, full = false }: {
  groups: Array<[string, ArtifactEntry[]]>;
  error: string | null;
  onOpen: (path: string) => void;
  full?: boolean;
}): ReactElement {
  if (error) return <div className={`px-2 py-3 text-xs text-[var(--gs-danger)] ${full ? '' : 'text-center'}`}>{error}</div>;
  if (groups.length === 0) {
    return (
      <div className="px-2 py-4 text-center text-xs text-[var(--gs-text-dim)]">
        No project artifacts yet.
        <div className="mt-1 text-[10px] text-[var(--gs-text-ghost)]">Roll up a workspace to promote its artifacts to main.</div>
      </div>
    );
  }
  return (
    <div className={full ? 'max-w-[560px]' : ''}>
      {groups.map(([dir, files]) => (
        <div key={dir}>
          <div className="px-1 pb-0.5 pt-2 text-[10px] uppercase tracking-wider text-[var(--gs-text-ghost)]">{dir}/</div>
          {files.map((e) => (
            <button
              key={e.path}
              type="button"
              onClick={() => onOpen(e.path)}
              className="flex w-full items-center gap-1.5 rounded px-1.5 py-[3px] text-left font-[family-name:var(--gs-font-mono)] text-[11px] hover:bg-[var(--gs-bg-active)]"
              title={e.path}
            >
              <span className="min-w-0 flex-1 truncate text-[var(--gs-text)]">{e.path.includes('/') ? e.path.slice(e.path.indexOf('/') + 1) : e.path}</span>
              {e.pointer && <span className="flex-shrink-0 rounded-full border border-[#2a2413] px-1 text-[9px] text-[#f0b429]">lfs</span>}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
