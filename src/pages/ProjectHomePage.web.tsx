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
import { DashboardPanel } from '../components/DashboardPanel.web.js';
import { KIND_ICON, KIND_LABEL, KIND_ORDER, classifyArtifact, type ArtifactKind } from '../components/artifact-kinds.js';

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

function WorkspaceCombo({ value, options, onChange }: {
  value: string;
  options: Array<{ value: string; label: string; chain: string }>;
  onChange: (value: string) => void;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const cur = options.find((o) => o.value === value);
  const ql = q.toLowerCase();
  const filtered = options.filter((o) => `${o.chain} ${o.label}`.toLowerCase().includes(ql));
  const chains = [...new Set(filtered.map((o) => o.chain))];
  return (
    <div className="relative border-b border-[var(--gs-border)] px-2.5 py-2">
      <div className="relative flex items-center">
        <span className="pointer-events-none absolute left-2 text-[11px] text-[var(--gs-text-ghost)]">⛓</span>
        <input
          value={open ? q : (cur ? `${cur.chain} · ${cur.label}` : '')}
          placeholder="find chain / workspace…"
          onFocus={() => { setOpen(true); setQ(''); }}
          onChange={(e) => setQ(e.target.value)}
          onBlur={() => setTimeout(() => setOpen(false), 130)}
          className="w-full border border-[var(--gs-border)] bg-[var(--gs-bg-elevated)] py-1 pl-7 pr-6 font-[family-name:var(--gs-font-mono)] text-[11px] text-[var(--gs-text)] outline-none placeholder:text-[var(--gs-text-ghost)] focus:border-[var(--gs-border-active)]"
        />
        <span className="pointer-events-none absolute right-2 text-[10px] text-[var(--gs-text-dim)]">▾</span>
      </div>
      {open && (
        <div className="absolute inset-x-2.5 top-[38px] z-30 max-h-[240px] overflow-auto border border-[var(--gs-border-active)] bg-[var(--gs-bg-overlay)] shadow-[0_8px_24px_rgba(0,0,0,.6)]">
          {chains.map((chain) => (
            <div key={chain}>
              <div className="px-[9px] pb-[3px] pt-[7px] text-[10px] uppercase tracking-[.1em] text-[var(--gs-text-dim)]">{chain}</div>
              {filtered.filter((o) => o.chain === chain).map((o) => (
                <button
                  key={o.value}
                  type="button"
                  onMouseDown={() => { onChange(o.value); setOpen(false); }}
                  className={`block w-full px-[9px] py-1.5 text-left font-[family-name:var(--gs-font-mono)] text-[11px] ${o.value === value ? 'bg-[var(--gs-bg-active)] text-[var(--gs-text)]' : 'text-[var(--gs-text-muted)] hover:bg-[var(--gs-bg-hover)]'}`}
                >
                  {o.label}
                </button>
              ))}
            </div>
          ))}
          {filtered.length === 0 && <div className="px-[9px] py-2 text-[11px] text-[var(--gs-text-dim)]">no matches</div>}
        </div>
      )}
    </div>
  );
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

  // Artifact SOURCE: 'main' (the project's rolled-up branch) or a workspace's
  // branch — the mock's chain·workspace combo.
  const [artifactSource, setArtifactSource] = useState<string>('main');
  const sourceOptions = useMemo(() => {
    const wsOpts = workspaces.map((w) => {
      const chain = goals.find((g) => g.workspaceName === w.workspace.name)?.chainTitle ?? 'workspaces';
      return { value: w.workspace.selectionKey, label: w.workspace.name, chain, workspaceId: w.workspace.id };
    });
    return [{ value: 'main', label: 'main (rolled up)', chain: 'project', workspaceId: null as string | null }, ...wsOpts];
  }, [workspaces, goals]);
  const loadArtifacts = useCallback(() => {
    const src = sourceOptions.find((o) => o.value === artifactSource) ?? sourceOptions[0];
    const req = src.workspaceId === null
      ? backend?.listProjectArtifacts?.(projectName)
      : backend?.listWorkspaceArtifacts?.(src.workspaceId);
    if (!req) {
      setArtifactsError('Artifacts unavailable on this backend.');
      return;
    }
    req
      .then((list) => { setArtifacts(list); setArtifactsError(null); })
      .catch((e) => setArtifactsError(e instanceof Error ? e.message : 'Failed to load artifacts'));
  }, [backend, projectName, artifactSource, sourceOptions]);
  useEffect(() => { loadArtifacts(); }, [loadArtifacts]);
  const readArtifactFromSource = useCallback((path: string) => {
    const src = sourceOptions.find((o) => o.value === artifactSource) ?? sourceOptions[0];
    if (src.workspaceId === null) {
      return backend?.readProjectArtifact ? backend.readProjectArtifact(projectName, path) : Promise.reject(new Error('unavailable'));
    }
    return backend?.readWorkspaceArtifact ? backend.readWorkspaceArtifact(src.workspaceId, path) : Promise.reject(new Error('unavailable'));
  }, [backend, projectName, artifactSource, sourceOptions]);
  // Favorites (shared key with the workspace rail).
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
  const [railView, setRailView] = useState<'sel' | 'fav'>('sel');
  const [dashboardPath, setDashboardPath] = useState<string | null>(null);

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

  const kindGroups = useMemo(() => {
    const byKind = new Map<ArtifactKind, ArtifactEntry[]>();
    for (const e of artifacts) {
      if (e.path === 'README.md') continue;
      const k = classifyArtifact(e.path);
      (byKind.get(k) ?? byKind.set(k, []).get(k)!).push(e);
    }
    return KIND_ORDER.map((k) => [k, byKind.get(k) ?? []] as const).filter(([, a]) => a.length > 0);
  }, [artifacts]);
  const favEntries = useMemo(() => artifacts.filter((e) => favs.has(e.path)), [artifacts, favs]);
  const dashboards = useMemo(() => artifacts.filter((e) => classifyArtifact(e.path) === 'dashboard'), [artifacts]);

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

  const railRow = (e: ArtifactEntry, sub?: string): ReactElement => {
    const kind = classifyArtifact(e.path);
    const name = e.path.split('/').pop() ?? e.path;
    return (
      <div
        key={`${sub ?? ''}:${e.path}`}
        onClick={() => { if (kind === 'dashboard') { setViewerPath(null); setDashboardPath(e.path); } else { setDashboardPath(null); setViewerPath(e.path); } }}
        title={e.path}
        className="flex w-full cursor-pointer items-center gap-2 px-3 py-1 text-[11.5px] text-[var(--gs-text-muted)] hover:bg-[var(--gs-bg-hover)] hover:text-[var(--gs-text)]"
      >
        <span className="w-4 flex-shrink-0 text-center text-[var(--gs-text-ghost)]">{KIND_ICON[kind]}</span>
        <span className="min-w-0 flex-1 truncate">
          {name}
          {sub && <span className="text-[10px] text-[var(--gs-text-dim)]"> · {sub}</span>}
        </span>
        {e.pointer && <span className="flex-shrink-0 rounded-full border border-[#2a2413] px-1 text-[9px] text-[var(--gs-warning)]">lfs</span>}
        <button
          type="button"
          onClick={(ev) => { ev.stopPropagation(); toggleFav(e.path); }}
          title="favorite"
          className={`flex-shrink-0 px-0.5 text-[12px] ${favs.has(e.path) ? 'text-[var(--gs-warning)]' : 'text-[var(--gs-text-ghost)] hover:text-[var(--gs-text-muted)]'}`}
        >
          ★
        </button>
      </div>
    );
  };

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
          <div className="px-2 pb-1 pt-3 text-[10px] uppercase tracking-wider text-[var(--gs-text-ghost)]">Dashboards</div>
          {dashboards.length === 0 && <div className="px-2 text-[10px] text-[var(--gs-text-ghost)]">none in {artifactSource === 'main' ? 'main' : 'workspace'}</div>}
          {dashboards.map((d) => (
            <button
              key={d.path}
              type="button"
              onClick={() => { setViewerPath(null); setDashboardPath(d.path); }}
              className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs text-[var(--gs-text-muted)] hover:bg-[var(--gs-bg-active)]"
            >
              <span className="text-[var(--gs-accent)]">▦</span>
              <span className="min-w-0 flex-1 truncate">{(d.path.split('/').pop() ?? d.path).replace('.dashboard.json', '')}</span>
            </button>
          ))}
        </div>

        {/* center */}
        <div className="min-w-0 flex-1 overflow-y-auto p-4">
          {viewerPath !== null || dashboardPath !== null ? (
            <div className="flex h-full min-h-0 flex-col">
              <button
                type="button"
                onClick={() => { setViewerPath(null); setDashboardPath(null); }}
                className="mb-2 self-start text-xs text-[var(--gs-text-dim)] hover:text-[var(--gs-text)]"
              >
                ← back
              </button>
              <div className="min-h-0 flex-1 border border-[var(--gs-border)]">
                {dashboardPath !== null ? (
                  <DashboardPanel dashboardPath={dashboardPath} scopeLabel={artifactSource === 'main' ? 'project · main' : 'workspace'} read={readArtifactFromSource} />
                ) : (
                  <ArtifactPanel path={viewerPath!} read={readArtifactFromSource} />
                )}
              </div>
            </div>
          ) : section === 'artifacts' ? (
            <div className="max-w-[620px]">
              {kindGroups.map(([kind, files]) => (
                <div key={kind}>
                  <div className="px-1 pb-0.5 pt-2 text-[10px] uppercase tracking-wider text-[var(--gs-text-ghost)]">{KIND_LABEL[kind]}</div>
                  {files.map((e) => railRow(e))}
                </div>
              ))}
              {kindGroups.length === 0 && <div className="px-2 py-4 text-xs text-[var(--gs-text-dim)]">No artifacts in this source yet.</div>}
            </div>
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

        {/* right: project artifacts rail (mock: ProjectArtifactsRail) */}
        {section !== 'artifacts' && (
          <div className="gs-ui hidden w-[300px] flex-shrink-0 flex-col overflow-hidden border-l border-[var(--gs-border-muted)] lg:flex">
            <WorkspaceCombo
              value={artifactSource}
              options={sourceOptions.map((o) => ({ value: o.value, label: o.label, chain: o.chain }))}
              onChange={(v) => { setArtifactSource(v); setViewerPath(null); setDashboardPath(null); }}
            />
            <div className="flex border-b border-[var(--gs-border)]">
              <button type="button" onClick={() => setRailView('sel')} className={`flex-1 py-[7px] text-[11px] ${railView === 'sel' ? 'bg-[var(--gs-bg-elevated)] text-[var(--gs-text)] shadow-[inset_0_-2px_0_var(--gs-accent)]' : 'text-[var(--gs-text-muted)]'}`}>Artifacts</button>
              <button type="button" onClick={() => setRailView('fav')} className={`flex-1 py-[7px] text-[11px] ${railView === 'fav' ? 'bg-[var(--gs-bg-elevated)] text-[var(--gs-text)] shadow-[inset_0_-2px_0_var(--gs-accent)]' : 'text-[var(--gs-text-muted)]'}`}>★ Favorites <span className="text-[var(--gs-text-ghost)]">{favs.size > 0 ? favs.size : ''}</span></button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto py-1.5">
            {artifactsError ? (
              <div className="px-3 py-3 text-[11px] text-[var(--gs-danger)]">{artifactsError}</div>
            ) : (railView === 'fav' ? (
              favEntries.length === 0
                ? <div className="px-3 py-[18px] text-[12px] text-[var(--gs-text-dim)]">No favorites yet — ★ an artifact to pin it across the project.</div>
                : favEntries.map((e) => railRow(e))
            ) : kindGroups.length === 0 ? (
              <div className="px-3 py-[18px] text-[12px] text-[var(--gs-text-dim)]">
                No artifacts in this source yet.
                <div className="mt-1 text-[10px] text-[var(--gs-text-ghost)]">Roll up a workspace to promote artifacts to main.</div>
              </div>
            ) : (
              kindGroups.map(([kind, files]) => (
                <div key={kind}>
                  <div className="px-3 pb-[3px] pt-[9px] text-[10px] uppercase tracking-[.12em] text-[var(--gs-text-dim)]">{KIND_LABEL[kind]}</div>
                  {files.map((e) => railRow(e))}
                </div>
              ))
            ))}
            </div>
          </div>
        )}
      </div>

    </div>
  );
}
