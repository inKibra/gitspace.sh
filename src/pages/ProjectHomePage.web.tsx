/** @jsxImportSource react */
/**
 * ProjectHomePage — the project-level home (mock: ProjectHome.tsx).
 *
 * Sidebar: AGENT (stubs) / PROJECT (Overview, In process, Reports & notes,
 *          Chains, Crons & triggers) / DASHBOARDS / CONFIG (stub).
 * Center:  multi-tab shell (34px tabstrip) — Overview tab (three .ph-card
 *          sections) plus closable tabs for process/chains/reports feeds,
 *          dashboards and artifact viewers.
 * Right:   project artifacts rail (the artifacts repo's main branch, mounted
 *          at the base clone — docs/ARTIFACTS-FS.md) + Recently shipped queue.
 */

import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import type { DockviewApi } from 'dockview-react';
import type { BackendKey, SessionBackend } from '../session/backend.js';
import { NotePanel } from '../components/NotePanel.web.js';
import { CronsPaneConnected } from '../components/CronsPaneConnected.web.js';
import { PaneTerminalPanel } from '../components/PaneTerminalPanel.web.js';
import { DockviewWorkspaceShell, type DockviewTerminalPanel } from '../components/DockviewWorkspaceShell.web.js';
import type { RemoteSessionPtyBackend } from '../session/useRemoteSessionClient.js';
import { ReportPanel } from '../components/ReportPanel.web.js';
import type { KanbanGoalItem } from '../app/shared/board/types.js';
import type { WorkspaceRuntimeEntry } from '../app/shared/workspace-runtime/types.js';
import { ArtifactPanel } from '../components/ArtifactPanel.web.js';
import { DashboardPanel } from '../components/DashboardPanel.web.js';
import { KIND_ICON, KIND_LABEL, KIND_ORDER, classifyArtifact, type ArtifactKind, decodeBase64Utf8 } from '../components/artifact-kinds.js';

function ProjectReportTab({ path, read }: { path: string; read: (p: string) => Promise<{ base64: string }> }): ReactElement {
  const [report, setReport] = useState<unknown>(undefined);
  const [err, setErr] = useState(false);
  useEffect(() => {
    let alive = true;
    read(path).then((r) => { if (alive) setReport(JSON.parse(decodeBase64Utf8(r.base64))); }).catch(() => { if (alive) setErr(true); });
    return () => { alive = false; };
  }, [path, read]);
  if (err) return <div className="p-4 text-[12px] text-[var(--gs-text-dim)]">Not a structured report — open it from the rail to view as a document.</div>;
  if (report === undefined) return <div className="p-4 text-[12px] text-[var(--gs-text-dim)]">Loading…</div>;
  return <ReportPanel report={report} />;
}

interface ArtifactEntry {
  path: string;
  size: number;
  pointer: boolean;
}

interface FeedItem {
  kind: 'note' | 'todo' | 'report';
  /** mono surface line (workspace name or report file) */
  surface: string;
  /** note body paragraph */
  body?: string;
  /** report path for click-through */
  path?: string;
  /** note click-through: owning workspace + note id */
  noteId?: string;
  noteWorkspace?: string;
}

const FEED_CHIP: Record<FeedItem['kind'], { cls: string; label: string }> = {
  report: { cls: 'bg-[var(--gs-chip-green-bg)] text-[var(--gs-chip-green-text)]', label: 'report' },
  note: { cls: 'bg-[var(--gs-chip-blue-bg)] text-[var(--gs-chip-blue-text)]', label: 'note' },
  todo: { cls: 'bg-[var(--gs-chip-amber-bg)] text-[var(--gs-chip-amber-text)]', label: 'todo' },
};

const XS_BTN = 'border border-[var(--gs-border)] bg-transparent px-1.5 py-0.5 text-[10px] text-[var(--gs-text-muted)] transition-colors enabled:hover:bg-[var(--gs-bg-active)] enabled:hover:text-[var(--gs-text)] disabled:cursor-default';
const CHIP = 'inline-flex items-center gap-[5px] self-start whitespace-nowrap border border-[var(--gs-border)] px-[7px] py-[2px] text-[10.5px] uppercase leading-[1.4] tracking-[.05em]';

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
          className="w-full border border-[var(--gs-border)] bg-[var(--gs-bg-elevated)] py-1 pl-7 pr-6 font-[family-name:var(--gs-font)] text-[11px] text-[var(--gs-text)] outline-none placeholder:text-[var(--gs-text-ghost)] focus:border-[var(--gs-border-active)]"
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
                  className={`block w-full px-[9px] py-1.5 text-left font-[family-name:var(--gs-font)] text-[11px] ${o.value === value ? 'bg-[var(--gs-bg-active)] text-[var(--gs-text)]' : 'text-[var(--gs-text-muted)] hover:bg-[var(--gs-bg-hover)]'}`}
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

/** CONFIG → Artifacts repo: wizard — sharing is OPTIONAL; local always works. */
function ArtifactsRepoTab({ projectName, backend }: { projectName: string; backend: SessionBackend | null }): ReactElement {
  const [status, setStatus] = useState<{ repoPath: string; remote: string | null; branches: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [choice, setChoice] = useState<'github' | 'byo' | null>(null);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  const refresh = useCallback(() => {
    const fn = backend?.getProjectArtifactsStatus;
    if (!fn) { setError('Artifacts status unavailable on this backend.'); return; }
    fn.call(backend, projectName)
      .then((st) => { setStatus(st); setError(null); })
      .catch((e) => setError(e instanceof Error ? e.message : 'status unavailable'));
  }, [backend, projectName]);
  useEffect(() => { refresh(); }, [refresh]);

  const kicker = 'text-[10px] uppercase tracking-[0.09em] text-[var(--gs-text-dim)]';
  const mono = 'font-[family-name:var(--gs-font)]';

  const enable = async (run: () => Promise<string>) => {
    setBusy(true); setNote(null);
    try { setNote(await run()); } catch (e) { setNote(e instanceof Error ? e.message : 'failed'); }
    finally { setBusy(false); refresh(); }
  };

  const OPTIONS: Array<{ key: 'github' | 'byo'; icon: string; title: string; badge?: string; desc: string; available: boolean }> = [
    { key: 'github', icon: '⚡', title: 'GitHub private repo', badge: 'recommended', desc: 'One click via your existing gh login: creates <owner>/<repo>-artifacts, mirrors your code-repo collaborators, large files ride GitHub LFS.', available: Boolean(backend?.provisionProjectArtifacts) },
    { key: 'byo', icon: '⛓', title: 'Bring your own remote', desc: 'Any git URL you control (GitLab, self-hosted, a bare repo on a server). Access is whatever the host enforces; large files stay local to each machine.', available: Boolean(backend?.setProjectArtifactsRemote) },
  ];

  const PLAN: Record<'github' | 'byo', string[]> = {
    github: ['Create a private <owner>/<repo>-artifacts on your GitHub', 'Mirror the code repo\u2019s collaborators onto it', 'Commit the pointer to the code repo — teammates adopt automatically', 'Push all branches + upload large files to GitHub LFS, then auto-sync every 5 minutes'],
    byo: ['Set your URL as the artifacts remote', 'Commit the pointer to the code repo — teammates adopt automatically (their git auth must reach the host)', 'Push all branches now, then auto-sync every 5 minutes'],
  };

  return (
    <div className="h-full overflow-y-auto p-5">
      <div className="max-w-[720px]">
        <div className="text-[15px] font-semibold text-[var(--gs-text)]">Artifacts sharing</div>
        <p className="mt-1 text-[12px] leading-[1.55] text-[var(--gs-text-muted)]">
          Everything already works locally — journals, evidence, dashboards and review guides are versioned in a
          project-local repo{status ? <> at <code className={`${mono} text-[11px]`}>{status.repoPath}</code></> : null}.
          Sharing is an <span className="text-[var(--gs-text)]">optional step for teams</span>: connect a remote once and
          every teammate and machine syncs automatically.
        </p>

        {error && <div className="mt-4 text-[12px] text-[var(--gs-danger)]">{error}</div>}

        {status?.remote ? (
          <div className="mt-4 border border-[#1f4a2f] bg-[var(--gs-bg-elevated)] px-4 py-3">
            <div className="flex items-baseline gap-2">
              <span className="text-[var(--gs-accent)]">✓</span>
              <span className={kicker}>sharing enabled</span>
              <span className={`min-w-0 flex-1 truncate ${mono} text-[11.5px] text-[var(--gs-success)]`}>{status.remote}</span>
              <button type="button" disabled={busy} onClick={() => void enable(async () => { const r = await backend!.syncProjectArtifacts!(projectName); return `synced — ${r.pushed ? 'pushed' : 'up to date'}`; })} className={XS_BTN}>{busy ? 'Syncing…' : '⟳ Sync now'}</button>
              <button type="button" onClick={() => setEditing((v) => !v)} className={XS_BTN}>{editing ? 'Close' : '✎ Change'}</button>
            </div>
            <div className={`mt-2 ${mono} text-[11px] text-[var(--gs-text-dim)]`}>branches: {status.branches.join(' · ') || '(none yet)'}</div>
            <div className="mt-2 border-t border-[var(--gs-border-muted)] pt-2 text-[11px] leading-[1.5] text-[var(--gs-text-muted)]">
              Teammates do nothing: the committed pointer in the code repo wires them up on their first workspace. Auto-sync runs every 5 minutes on every machine.
            </div>
            {note && <div className="pt-1.5 text-[11px] text-[var(--gs-text-dim)]">{note}</div>}
          </div>
        ) : null}
        {(!status?.remote || editing) && (
          <>
            {editing && <div className="mt-4 text-[11.5px] text-[var(--gs-warning)]">Choosing a new path replaces the current remote (history stays local; the pointer commit updates for teammates).</div>}
            <div className={`mt-5 ${kicker}`}>1 · choose how to share</div>
            <div className="mt-2 flex flex-col gap-2">
              {OPTIONS.map((o) => (
                <button
                  key={o.key}
                  type="button"
                  disabled={!o.available}
                  onClick={() => setChoice(o.key)}
                  className={`border px-3.5 py-2.5 text-left transition-colors disabled:opacity-40 ${choice === o.key ? 'border-[var(--gs-accent)] bg-[var(--gs-bg-elevated)]' : 'border-[var(--gs-border)] hover:border-[var(--gs-border-active)]'}`}
                >
                  <div className="flex items-baseline gap-2">
                    <span className="text-[var(--gs-accent)]">{o.icon}</span>
                    <span className="text-[12.5px] font-semibold text-[var(--gs-text)]">{o.title}</span>
                    {o.badge && <span className="border border-[#1f4a2f] px-1.5 py-px text-[9.5px] uppercase tracking-[0.06em] text-[var(--gs-accent)]">{o.badge}</span>}
                    {!o.available && <span className="text-[10px] text-[var(--gs-text-ghost)]">unavailable on this backend</span>}
                  </div>
                  <div className="mt-1 text-[11.5px] leading-[1.5] text-[var(--gs-text-muted)]">{o.desc}</div>
                </button>
              ))}
            </div>

            {choice && (
              <>
                {choice === 'byo' && (
                  <div className="mt-3">
                    <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="git@github.com:you/proj-artifacts.git" className={`w-full border border-[var(--gs-border)] bg-black px-2 py-1.5 ${mono} text-[11.5px] text-[var(--gs-text)] outline-none focus:border-[var(--gs-accent)]`} />
                  </div>
                )}
                <div className={`mt-4 ${kicker}`}>2 · what will happen</div>
                <ul className="mt-1.5 flex flex-col gap-1">
                  {PLAN[choice].map((step, i) => (
                    <li key={i} className="flex gap-2 text-[11.5px] leading-[1.5] text-[var(--gs-text-muted)]"><span className={`${mono} text-[var(--gs-text-dim)]`}>{i + 1}.</span>{step}</li>
                  ))}
                </ul>
                <div className={`mt-4 ${kicker}`}>3 · enable</div>
                <button
                  type="button"
                  disabled={busy || (choice === 'byo' && !url.trim())}
                  onClick={() => void enable(async () => {
                    if (choice === 'github') { const r = await backend!.provisionProjectArtifacts!(projectName); return `${r.created ? 'created' : 'reusing'} ${r.slug} — pushed, ${r.blobsUploaded} blobs, ${r.collaboratorsCopied} collaborators`; }
                    const r = await backend!.setProjectArtifactsRemote!(projectName, url.trim()); return `connected — ${r.pushed ? 'branches pushed' : 'adopted remote'}`;
                  })}
                  className="mt-1.5 border border-[#1f4a2f] px-4 py-1.5 text-[12px] text-[var(--gs-accent)] disabled:opacity-40"
                >
                  {busy ? 'Enabling…' : '⚡ Enable sharing'}
                </button>
                {note && <div className="mt-2 text-[11.5px] text-[var(--gs-text-muted)]">{note}</div>}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** small star rater for the roll-up rate step (mock: Stars) */
/**
 * Project-agent tab: the full agent pane (header + transcript + composer)
 * against the `<project>:@base` pseudo-workspace. PaneTerminalPanel's agent
 * branch only touches SessionBackend methods, so the pty-backend cast is safe.
 */
function ProjectAgentPane({ backend, backendKey, workspaceId, agentSessionId, paneId }: {
  backend: SessionBackend | null;
  backendKey: BackendKey | null;
  workspaceId: string;
  agentSessionId: string;
  paneId: string;
}): ReactElement {
  const [modifiers, setModifiers] = useState({ ctrl: false, shift: false, alt: false });
  const pane = useMemo(() => ({
    paneId,
    streamId: 0,
    sessionId: '',
    sessionName: null,
    meta: null,
    workspaceId,
    agentSessionId,
    viewOnly: false,
  }), [paneId, workspaceId, agentSessionId]);
  return (
    <PaneTerminalPanel
      pane={pane}
      backend={backend as RemoteSessionPtyBackend | null}
      backendKey={backendKey}
      showMobileControls={false}
      inputMode={false}
      keyboardVisible={false}
      onToggleInputMode={() => {}}
      inputButtonClassName=""
      terminalContainerClassName=""
      modifiers={modifiers}
      onModifiersChange={setModifiers}
      showFloatingControls={false}
    />
  );
}

function Stars({ value, onChange }: { value: number; onChange: (n: number) => void }): ReactElement {
  return (
    <span className="inline-flex gap-0.5">
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          onClick={() => onChange(n)}
          className={`px-px text-[16px] leading-none transition-colors active:scale-90 ${n <= value ? 'text-[var(--gs-warning)]' : 'text-[var(--gs-text-ghost)] hover:text-[var(--gs-warning)]'}`}
        >
          ★
        </button>
      ))}
    </span>
  );
}

/** per-goal status dot on chain rows (mock: .cs-dot) */
function goalDotClass(g: KanbanGoalItem): string {
  const base = 'h-2 w-2 flex-none rounded-full border-2';
  if (g.status === 'planned') return `${base} border-[var(--gs-border-active)] bg-[var(--gs-bg)]`;
  if (g.phase === 'ship') return `${base} border-[var(--gs-success)] bg-[var(--gs-success)]`;
  return `${base} border-[var(--gs-accent)] bg-[var(--gs-accent)] shadow-[0_0_8px_var(--gs-accent)]`;
}

const FIXED_TAB_LABEL: Record<string, string> = {
  overview: 'Overview',
  process: 'In process',
  chains: 'Chains',
  reports: 'Reports & notes',
  crons: '◷ Crons & triggers',
  'artifacts-repo': 'Artifacts repo',
};
const isDashTab = (t: string): boolean => t.startsWith('dash:');
const isArtTab = (t: string): boolean => t.startsWith('art:');

export function ProjectHomePage({
  projectName,
  goals,
  workspaces,
  backend,
  backendKey,
  onBack,
  onOpenWorkspace,
  onOpenGoal,
  shippedWorkspaces,
  onRollup,
}: {
  projectName: string;
  goals: KanbanGoalItem[];
  workspaces: WorkspaceRuntimeEntry[];
  backend: SessionBackend | null;
  backendKey?: string | null;
  onBack: () => void;
  onOpenWorkspace: (workspaceId: string) => void;
  onOpenGoal: (goal: KanbanGoalItem) => void;
  /** shipped workspaces queued for roll-up (integrator wires from backend rollup) */
  shippedWorkspaces?: Array<{ name: string; chain: string }>;
  onRollup?: (workspaceName: string) => Promise<void>;
}): ReactElement {
  const [artifacts, setArtifacts] = useState<ArtifactEntry[]>([]);
  const [newDashName, setNewDashName] = useState<string | null>(null);
  const baseWorkspaceId = `${projectName}:@base`;
  const [agentThreads, setAgentThreads] = useState<Array<{ id: string; title: string }>>([]);
  const [threadsTick, setThreadsTick] = useState(0);
  useEffect(() => {
    let alive = true;
    backend?.listAgentSessions?.(baseWorkspaceId)
      // closedAt just means "not open in a UI right now" — after a daemon
      // restart every known session starts closed. Only archived threads hide.
      .then((list) => { if (alive) setAgentThreads(list.filter((x) => !x.archivedAt).map((x) => ({ id: x.id, title: x.title }))); })
      .catch(() => { /* no threads yet / backend down */ });
    return () => { alive = false; };
  }, [backend, baseWorkspaceId, threadsTick]);
  const [artifactsError, setArtifactsError] = useState<string | null>(null);
  const [feed, setFeed] = useState<FeedItem[]>([]);

  // Center dock — the same DockviewWorkspaceShell as workspace panes, so
  // project tabs (agent threads, reports, dashboards) get splits, drag, and
  // focus-on-reopen. `tabs` is the open-panel list; dockview owns activation.
  const tabsStorageKey = `gssh:ph-tabs:${projectName}`;
  const layoutStorageKey = `gssh:ph-layout:${projectName}`;
  const [tabs, setTabs] = useState<string[]>(() => {
    try {
      const saved = JSON.parse(window.localStorage.getItem(tabsStorageKey) ?? '[]') as string[];
      return saved.includes('overview') ? saved : ['overview', ...saved];
    } catch { return ['overview']; }
  });
  useEffect(() => {
    try { window.localStorage.setItem(tabsStorageKey, JSON.stringify(tabs)); } catch { /* storage unavailable */ }
  }, [tabs, tabsStorageKey]);
  const initialDockLayout = useMemo<unknown>(() => {
    try {
      const raw = window.localStorage.getItem(layoutStorageKey);
      return raw ? JSON.parse(raw) : undefined;
    } catch { return undefined; }
  }, [layoutStorageKey]);
  const handleDockLayoutChange = useCallback((layout: unknown) => {
    try { window.localStorage.setItem(layoutStorageKey, JSON.stringify(layout)); } catch { /* storage unavailable */ }
  }, [layoutStorageKey]);
  const [focusRequest, setFocusRequest] = useState<{ id: string; nonce: number } | null>(null);
  const [dockApi, setDockApi] = useState<DockviewApi | null>(null);
  const [active, setActive] = useState<string>('overview');
  useEffect(() => {
    if (!dockApi) return;
    setActive(dockApi.activePanel?.id ?? 'overview');
    const sub = dockApi.onDidActivePanelChange((panel) => setActive(panel?.id ?? 'overview'));
    return () => sub.dispose();
  }, [dockApi]);
  const openTab = useCallback((t: string): void => {
    setTabs((s) => (s.includes(t) ? s : [...s, t]));
    // Focus whether new or already open (new panels also self-activate).
    setFocusRequest((prev) => ({ id: t, nonce: (prev?.nonce ?? 0) + 1 }));
  }, []);
  const closePane = useCallback((t: string): void => {
    setTabs((s) => s.filter((x) => x !== t));
  }, []);

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

  // Recently shipped roll-up flow (mock: rolled/rating/stars).
  const shipped = shippedWorkspaces ?? [];
  const [rolled, setRolled] = useState<Record<string, boolean>>({});
  const [ratingWs, setRatingWs] = useState<string | null>(null);
  const [stars, setStars] = useState<Record<string, number>>({});
  const [rollBusy, setRollBusy] = useState<string | null>(null);
  const doRollUp = async (name: string): Promise<void> => {
    if (rollBusy !== null) return;
    if (!onRollup) {
      setRolled((r) => ({ ...r, [name]: true }));
      setRatingWs(null);
      return;
    }
    setRollBusy(name);
    try {
      await onRollup(name);
      setRolled((r) => ({ ...r, [name]: true }));
      setRatingWs(null);
      loadArtifacts();
    } catch { /* keep row for retry */ }
    setRollBusy(null);
  };

  // Reports & notes feed: project reports/ artifacts + notes across workspaces.
  useEffect(() => {
    let alive = true;
    void (async () => {
      const items: FeedItem[] = [];
      for (const a of artifacts) {
        if (a.path.startsWith('reports/')) {
          items.push({ kind: 'report', surface: a.path.slice('reports/'.length), body: 'project artifact', path: a.path });
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
            items.push({
              kind: n.kind === 'todo' ? 'todo' : 'note',
              surface: r.value.ws,
              body: n.body,
              noteId: n.id,
              noteWorkspace: r.value.ws,
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

  const dashName = (path: string): string => (path.split('/').pop() ?? path).replace('.dashboard.json', '');
  const tabLabel = (t: string): string => {
    if (isDashTab(t)) return dashName(t.slice(5));
    if (isArtTab(t)) return `◇ ${t.slice(4).split('/').pop() ?? t.slice(4)}`;
    if (t.startsWith('report:')) return `⚑ ${t.slice(7).split('/').pop() ?? 'report'}`;
    if (t.startsWith('note:')) return '✎ note';
    if (t.startsWith('agent:')) return `✦ ${agentThreads.find((x) => `agent:${x.id}` === t)?.title || 'thread'}`;
    return FIXED_TAB_LABEL[t] ?? t;
  };

  // Sidebar rows (mock: .litem — icon column, inset accent bar when active).
  const navRow = (opts: { key: string; icon: string; label: string; rt?: string; tab?: string; onClick?: () => void; disabled?: boolean; title?: string }): ReactElement => {
    const on = opts.tab !== undefined && active === opts.tab;
    return (
      <button
        key={opts.key}
        type="button"
        disabled={opts.disabled}
        title={opts.title}
        onClick={opts.onClick ?? (opts.tab !== undefined ? () => openTab(opts.tab!) : undefined)}
        className={`flex w-full items-center gap-[9px] px-[13px] py-[5px] text-left text-[12px] transition-colors ${
          on
            ? 'bg-[var(--gs-bg-active)] text-[var(--gs-text)] shadow-[inset_2px_0_0_var(--gs-accent)]'
            : `text-[var(--gs-text-muted)] ${opts.disabled ? 'cursor-default' : 'hover:bg-[var(--gs-bg-hover)] hover:text-[var(--gs-text)]'}`
        }`}
      >
        <span className={`w-[14px] flex-none text-center ${on ? 'text-[var(--gs-accent)]' : 'text-[var(--gs-text-dim)]'}`}>{opts.icon}</span>
        <span className="min-w-0 flex-1 truncate">{opts.label}</span>
        {opts.rt !== undefined && <span className="text-[10.5px] tabular-nums text-[var(--gs-text-dim)]">{opts.rt}</span>}
      </button>
    );
  };
  const sbGroup = (label: string): ReactElement => (
    <div className="px-[13px] pb-[5px] pt-[11px] text-[10.5px] uppercase tracking-[.12em] text-[var(--gs-text-dim)]">{label}</div>
  );

  const railRow = (e: ArtifactEntry, sub?: string): ReactElement => {
    const kind = classifyArtifact(e.path);
    const name = e.path.split('/').pop() ?? e.path;
    return (
      <div
        key={`${sub ?? ''}:${e.path}`}
        onClick={() => openTab(kind === 'dashboard' ? `dash:${e.path}` : kind === 'report' && e.path.endsWith('.report.json') ? `report:${e.path}` : `art:${e.path}`)}
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

  // Overview card shell (mock: .ph-card / .ph-card-h).
  const card = (title: string, sub: string | null, right: ReactElement, body: ReactElement): ReactElement => (
    <div className="border border-[var(--gs-border)] bg-[var(--gs-bg-elevated)]">
      <div className="flex items-center gap-[9px] border-b border-[var(--gs-border)] bg-[#070707] px-3 py-2">
        <span className="text-[11px] uppercase tracking-[.1em] text-[var(--gs-text-muted)]">{title}</span>
        {sub && <span className="text-[11px] text-[var(--gs-text-dim)]">{sub}</span>}
        <span className="ml-auto">{right}</span>
      </div>
      {body}
    </div>
  );

  // Chains: grouped slim rows with status-dot strips (mock: .ph-chain).
  const chainsBody = (
    <div className="px-3.5 py-3">
      {chains.length === 0 ? (
        <div className="text-xs text-[var(--gs-text-dim)]">No goal chains yet — plan one from the board.</div>
      ) : (
        chains.map((c) => {
          const curGoal = c.goals.find((g) => g.workspaceName);
          const ws = curGoal ? workspaces.find((w) => w.workspace.name === curGoal.workspaceName) : undefined;
          return (
            <div
              key={c.chainId}
              onClick={() => {
                if (ws) onOpenWorkspace(ws.workspace.selectionKey);
                else if (c.goals[0]) onOpenGoal(c.goals[0]);
              }}
              className="mb-[5px] flex cursor-pointer items-center gap-2.5 border border-[var(--gs-border-muted)] px-[9px] py-[7px] transition-colors last:mb-0 hover:border-[var(--gs-border-active)] hover:bg-[var(--gs-bg-hover)]"
            >
              <span className="text-[12.5px] text-[var(--gs-text)]">{c.title}</span>
              <span className="ml-1.5 inline-flex gap-1">
                {c.goals.map((g) => (
                  <span key={g.id} title={`${g.title} · ${g.status === 'planned' ? 'planned' : g.phase}`} className={goalDotClass(g)} />
                ))}
              </span>
              <span className="ml-auto text-[10.5px] text-[var(--gs-text-dim)]">{c.goals.length} goal{c.goals.length === 1 ? '' : 's'}</span>
            </div>
          );
        })
      )}
    </div>
  );

  // In process: borderless hover rows (mock: .ph-proc).
  const inProcessBody = (
    <div className="px-3.5 py-3">
      {inProcess.length === 0 ? (
        <div className="text-xs text-[var(--gs-text-dim)]">Nothing in flight.</div>
      ) : (
        inProcess.map((w) => (
          <div
            key={w.workspace.selectionKey}
            onClick={() => onOpenWorkspace(w.workspace.selectionKey)}
            className="flex cursor-pointer items-center gap-[9px] px-[9px] py-1.5 hover:bg-[var(--gs-bg-hover)]"
          >
            {w.agentSessionCount > 0 && <span className="h-[7px] w-[7px] flex-none animate-pulse rounded-full bg-[var(--gs-accent)]" />}
            <span className="font-[family-name:var(--gs-font)] text-[12px] text-[var(--gs-text)]">{w.workspace.name}</span>
            {w.workspace.phase && <span className={`${CHIP} bg-[var(--gs-chip-dim-bg)] text-[var(--gs-text-dim)]`}>{w.workspace.phase}</span>}
            <span className="ml-auto text-[10.5px] text-[var(--gs-text-dim)]">
              {w.agentSessionCount > 0 ? 'agent running' : w.pendingPermissionCount > 0 ? `⚡ ${w.pendingPermissionCount} pending` : ''}
            </span>
          </div>
        ))
      )}
    </div>
  );

  // Reports & notes: kind chip + two-line body + actions row (mock: ReportRow).
  const feedBody = (
    <div className="flex flex-col">
      {feed.length === 0 ? (
        <div className="px-3.5 py-3 text-xs text-[var(--gs-text-dim)]">No reports or notes yet — roll-ups and workspace notes land here.</div>
      ) : (
        feed.map((f, i) => {
          const chip = FEED_CHIP[f.kind];
          return (
            <div key={`${f.kind}:${f.surface}:${i}`} className="flex gap-2.5 border-b border-[var(--gs-border-muted)] px-3.5 py-[9px] last:border-b-0">
              <span className={`${CHIP} ${chip.cls}`}>{chip.label}</span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  {f.path || f.noteId ? (
                    <button
                      type="button"
                      onClick={() => openTab(f.path ? (f.path.endsWith('.report.json') ? `report:${f.path}` : `art:${f.path}`) : `note:${f.noteWorkspace}:${f.noteId}`)}
                      className="font-[family-name:var(--gs-font)] text-[11.5px] text-[var(--gs-text)] hover:underline"
                    >
                      {f.surface}
                    </button>
                  ) : (
                    <span className="font-[family-name:var(--gs-font)] text-[11.5px] text-[var(--gs-text)]">{f.surface}</span>
                  )}
                </div>
                {f.body && <div className="mt-[3px] text-[12px] leading-[1.45] text-[var(--gs-text-muted)]">{f.body}</div>}
                <div className="mt-1.5 flex gap-[7px]">
                  <button type="button" disabled title="planning from notes ships next" className={XS_BTN}>＋ Plan from this</button>
                </div>
              </div>
            </div>
          );
        })
      )}
    </div>
  );

  // Overview tab body (mock: .ph-card stack).
  const overviewBody = (
    <div className="flex h-full flex-col gap-3.5 overflow-y-auto px-[18px] py-4">
      {card(
        'Chains',
        'grouped · tag into epics',
        <button type="button" disabled title="plan a chain from the board" className={XS_BTN}>＋ New</button>,
        chainsBody,
      )}
      {card(
        'In process',
        null,
        <button type="button" onClick={() => openTab('process')} className={XS_BTN}>open ↗</button>,
        inProcessBody,
      )}
      {card(
        'Reports & notes',
        'reflect → plan',
        <button type="button" onClick={() => openTab('reports')} className={XS_BTN}>open feed ↗</button>,
        feedBody,
      )}
    </div>
  );

  // Dock panels. Render closures snapshot this render's data; `version`
  // fingerprints what each closure captures so the shell re-renders the panel
  // when (and only when) that data changes.
  const goalsFp = goals.map((g) => `${g.id}:${g.status}:${g.phase ?? ''}:${g.workspaceName ?? ''}`).join(',');
  const procFp = inProcess.map((w) => `${w.workspace.selectionKey}:${w.agentSessionCount}:${w.pendingPermissionCount}:${w.workspace.phase ?? ''}`).join(',');
  const feedFp = feed.map((f) => `${f.kind}:${f.surface}:${f.path ?? f.noteId ?? ''}:${f.body?.length ?? 0}`).join(',');
  const artifactsFp = artifacts.map((e) => e.path).join(',');
  const dockPanels: DockviewTerminalPanel[] = tabs.map((t) => {
    const common = { id: t, title: tabLabel(t), onClose: t === 'overview' ? undefined : () => closePane(t) };
    if (t === 'overview') return { ...common, version: `overview|${goalsFp}|${procFp}|${feedFp}`, render: () => overviewBody };
    if (t === 'process') return { ...common, version: `process|${procFp}`, render: () => <div className="h-full overflow-y-auto">{inProcessBody}</div> };
    if (t === 'chains') return { ...common, version: `chains|${goalsFp}`, render: () => <div className="h-full overflow-y-auto">{chainsBody}</div> };
    if (t === 'reports') return { ...common, version: `reports|${feedFp}`, render: () => <div className="h-full overflow-y-auto">{feedBody}</div> };
    if (isDashTab(t)) {
      return { ...common, version: `dash|${t}|${artifactSource}`, render: () => (
        <DashboardPanel dashboardPath={t.slice(5)} scopeLabel={artifactSource === 'main' ? 'project · main' : 'workspace'} read={readArtifactFromSource} />
      ) };
    }
    if (isArtTab(t)) {
      return { ...common, version: `art|${t}|${artifactSource}|${artifactsFp}`, render: () => (
        <ArtifactPanel path={t.slice(4)} read={readArtifactFromSource} listArtifacts={async () => artifacts.map((e) => e.path)} />
      ) };
    }
    if (t === 'artifacts-repo') return { ...common, version: 'artifacts-repo', render: () => <ArtifactsRepoTab projectName={projectName} backend={backend} /> };
    // Project-scope triggers live on the base clone's main mount and fire as
    // '<project>:@base' agent runs — same registry, same scheduler.
    if (t === 'crons') return { ...common, version: 'crons', render: () => <CronsPaneConnected backend={backend} workspaceId={baseWorkspaceId} /> };
    if (t.startsWith('agent:')) {
      return { ...common, version: `agent|${t}`, render: () => (
        <ProjectAgentPane backend={backend} backendKey={backendKey ?? null} workspaceId={baseWorkspaceId} agentSessionId={t.slice(6)} paneId={t} />
      ) };
    }
    if (t.startsWith('report:')) {
      return { ...common, version: `report|${t}|${artifactSource}`, render: () => <ProjectReportTab path={t.slice(7)} read={readArtifactFromSource} /> };
    }
    if (t.startsWith('note:')) {
      const [, ws, ...idParts] = t.split(':');
      return { ...common, version: `note|${t}`, render: () => <NotePanel backend={backend} projectName={projectName} workspaceName={ws!} noteId={idParts.join(':')} /> };
    }
    // Stale persisted id from an older scheme — closable, never crashes.
    return { ...common, version: 'unknown', render: () => <div className="p-4 text-xs text-[var(--gs-text-dim)]">Unknown tab: {t}</div> };
  });

  return (
    <div className="flex h-screen w-screen bg-[var(--gs-bg)] text-[13px]">
      {/* sidebar (mock: .ph-sb) */}
      <aside className="flex w-[220px] flex-none flex-col border-r border-[var(--gs-border)] bg-[#050505]">
        <div className="flex flex-none flex-col gap-[7px] border-b border-[var(--gs-border)] px-[13px] py-[11px]">
          <span className="font-[family-name:var(--gs-font)] text-[13px] text-[var(--gs-text)]">{projectName}</span>
          <button
            type="button"
            onClick={onBack}
            className="self-start border border-[var(--gs-border)] px-2 py-[3px] text-[11px] text-[var(--gs-text-muted)] hover:border-[var(--gs-border-active)] hover:text-[var(--gs-text)]"
          >
            ⊞ All projects
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto pb-2">
          {sbGroup('Agent')}
          {agentThreads.length === 0
            ? navRow({ key: 'agent', icon: '✦', label: 'Project agent', rt: backend?.createAgentSession ? 'idle' : undefined, disabled: true, title: 'no threads yet — start one below' })
            : agentThreads.map((th) => navRow({ key: `agent-${th.id}`, icon: '✦', label: th.title || 'thread', tab: `agent:${th.id}` }))}
          {navRow({
            key: 'new-thread', icon: '＋', label: 'New thread',
            disabled: !backend?.createAgentSession,
            title: backend?.createAgentSession ? undefined : 'agent sessions unavailable',
            onClick: backend?.createAgentSession ? () => {
              void backend.createAgentSession!(baseWorkspaceId, 'project agent').then((sessions) => {
                const created = sessions.filter((x) => !x.closedAt && !x.archivedAt).at(-1);
                setThreadsTick((n) => n + 1);
                if (created) openTab(`agent:${created.id}`);
              }).catch(() => { /* surface stays */ });
            } : undefined,
          })}

          {sbGroup('Project')}
          {navRow({ key: 'overview', icon: '◎', label: 'Overview', tab: 'overview' })}
          {navRow({ key: 'process', icon: '◷', label: 'In process', rt: String(inProcess.length), tab: 'process' })}
          {navRow({ key: 'reports', icon: '⚑', label: 'Reports & notes', rt: String(feed.length), tab: 'reports' })}
          {navRow({ key: 'chains', icon: '⛓', label: 'Chains', rt: String(chains.length), tab: 'chains' })}
          {navRow({ key: 'crons', icon: '◷', label: 'Crons & triggers', tab: 'crons' })}

          {sbGroup('Dashboards')}
          {dashboards.length === 0 && (
            <div className="px-[13px] text-[10px] text-[var(--gs-text-ghost)]">none in {artifactSource === 'main' ? 'main' : 'workspace'}</div>
          )}
          {dashboards.map((d) => navRow({ key: `dash:${d.path}`, icon: '▦', label: dashName(d.path), tab: `dash:${d.path}` }))}
          {newDashName === null ? (
            navRow({ key: 'new-dash', icon: '＋', label: 'New dashboard', onClick: backend?.writeProjectArtifact ? () => setNewDashName('') : undefined, disabled: !backend?.writeProjectArtifact, title: backend?.writeProjectArtifact ? undefined : 'project artifact writes unavailable' })
          ) : (
            <div className="flex items-center gap-1 px-[13px] py-[3px]">
              <input
                autoFocus
                value={newDashName}
                onChange={(e) => setNewDashName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setNewDashName(null);
                  if (e.key === 'Enter') {
                    const slug = newDashName.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
                    if (!slug) return;
                    const doc = JSON.stringify({ name: slug, panels: [] }, null, 2) + '\n';
                    void backend!.writeProjectArtifact!(projectName, `${slug}.dashboard.json`, btoa(doc), `dashboard: create ${slug}`)
                      .then(() => { setNewDashName(null); loadArtifacts(); openTab(`dash:${slug}.dashboard.json`); })
                      .catch(() => setNewDashName(null));
                  }
                }}
                placeholder="dashboard name ⏎"
                className="w-full border border-[var(--gs-border-active)] bg-black px-1.5 py-0.5 text-[11px] text-[var(--gs-text)] outline-none"
              />
            </div>
          )}

          {sbGroup('Config')}
          {navRow({ key: 'artifacts-repo', icon: '◈', label: 'Artifacts repo', tab: 'artifacts-repo' })}
          {navRow({ key: 'config', icon: '⚙', label: 'Bundle config', disabled: true, title: 'bundle config editor ships next' })}
        </div>
      </aside>

      {/* center: dock shell — same shell as workspace panes (splits, drag,
          focus-on-reopen, persisted layout) */}
      <div className="min-h-0 min-w-0 flex-1">
        <DockviewWorkspaceShell
          backendKey={backendKey ?? 'local'}
          workspaceId={baseWorkspaceId}
          panels={dockPanels}
          focusRequest={focusRequest}
          initialLayout={initialDockLayout}
          onLayoutChange={handleDockLayoutChange}
          onApiChange={setDockApi}
        />
      </div>

      {/* right: project artifacts rail (mock: ProjectArtifactsRail) + shipped queue */}
      <div className="gs-ui hidden w-[300px] flex-shrink-0 flex-col overflow-hidden border-l border-[var(--gs-border-muted)] lg:flex">
        <div className="flex min-h-0 flex-1 flex-col">
          <WorkspaceCombo
            value={artifactSource}
            options={sourceOptions.map((o) => ({ value: o.value, label: o.label, chain: o.chain }))}
            onChange={(v) => setArtifactSource(v)}
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
                <div className="px-3 pb-[3px] pt-[9px] text-[10.5px] uppercase tracking-[.12em] text-[var(--gs-text-dim)]">{KIND_LABEL[kind]}</div>
                {files.map((e) => railRow(e))}
              </div>
            ))
          ))}
          </div>
        </div>

        {/* Recently shipped queue with roll-up flow (mock: rsection.changes) */}
        <div className="flex max-h-[46%] min-h-0 flex-none flex-col border-t border-[var(--gs-border)]">
          <div className="flex h-[30px] flex-none items-center gap-[7px] border-b border-[var(--gs-border-muted)] px-3 text-[10px] uppercase tracking-[.1em] text-[var(--gs-text-muted)]">
            <span>▾</span> Recently shipped
            <span className="ml-auto normal-case tracking-normal text-[var(--gs-text-dim)]">
              <span className="text-[var(--gs-text-ghost)]">deletion check → </span>roll up
            </span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto py-1.5">
            {shipped.length === 0 ? (
              <div className="px-3 py-2.5 text-[11px] text-[var(--gs-text-dim)]">Nothing shipped yet — shipped workspaces queue here for roll-up.</div>
            ) : (
              shipped.map((s) => {
                const done = rolled[s.name] === true;
                const rated = ratingWs === s.name;
                return (
                  <div
                    key={s.name}
                    className={`flex flex-col gap-[7px] border-b border-[var(--gs-border-muted)] px-3 py-[7px] last:border-b-0 ${rated ? 'bg-[rgba(188,140,255,0.04)]' : ''}`}
                  >
                    <div className="flex items-center gap-[9px]">
                      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="font-[family-name:var(--gs-font)] text-[11.5px] text-[var(--gs-text)]">{s.name}</span>
                        <span className="text-[10px] text-[var(--gs-text-dim)]">{s.chain} · shipped</span>
                      </div>
                      {done
                        ? <span className={`${CHIP} bg-[var(--gs-chip-green-bg)] text-[var(--gs-chip-green-text)]`}>rolled up</span>
                        : !rated && <button type="button" onClick={() => setRatingWs(s.name)} className={XS_BTN}>Check & roll up</button>}
                    </div>
                    {rated && !done && (
                      <div className="border border-[rgba(188,140,255,0.2)] bg-[var(--gs-bg)] px-2.5 py-2">
                        <div className="mb-[7px] text-[10.5px] text-[var(--gs-purple)]">
                          Rate the artifacts you're rolling up <span className="text-[var(--gs-text-dim)]">— feeds rated precedents</span>
                        </div>
                        <div className="flex items-center gap-2 py-0.5">
                          <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--gs-text-muted)]">artifacts · {s.name}</span>
                          <Stars value={stars[s.name] ?? 0} onChange={(v) => setStars((m) => ({ ...m, [s.name]: v }))} />
                        </div>
                        <div className="mt-2 flex justify-end gap-1.5">
                          <button type="button" onClick={() => setRatingWs(null)} className={XS_BTN}>Cancel</button>
                          <button
                            type="button"
                            disabled={rollBusy === s.name}
                            onClick={() => { void doRollUp(s.name); }}
                            className="border border-[var(--gs-accent)] bg-[var(--gs-accent)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--gs-text-on-accent)] hover:bg-[var(--gs-accent-hover)] disabled:opacity-40"
                          >
                            {rollBusy === s.name ? 'Rolling up…' : 'Roll up →'}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
