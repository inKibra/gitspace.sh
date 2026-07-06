import { decodeBase64Utf8, encodeBase64Utf8 } from './artifact-kinds.js';
/** @jsxImportSource react */
import { useCallback, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import type { ArtifactRead } from './ArtifactPanel.web.js';

/**
 * Dashboard canvas (mock: DashboardCanvas) — a composable grid of gitspace
 * mini-apps, driven ENTIRELY by artifacts:
 *   <name>.dashboard.json  → { name?, panels: [{ id, app, title, data, size }] }
 *   <app>.gssh.html        → sandboxed iframe (allow-scripts only)
 *   <data>.json            → handed to the app via postMessage({type:'gssh:data'})
 * Panel edits (add/resize/remove) auto-persist through the artifacts write RPC
 * (commit-on-write on the workspace's artifacts branch).
 */

export interface DashboardPanelDef {
  id: string;
  /** Artifact path of the .gssh.html mini-app. */
  app: string;
  title: string;
  /** Artifact path of the data JSON handed to the app. */
  data?: string;
  size?: 'half' | 'full';
  /** Which level the panel reads from (chip in the frame bar). */
  scope?: 'workspace' | 'chain';
  /** Freshness: where the data comes from + when it last updated. */
  source?: string;
  updated?: string;
  stale?: boolean;
}

export interface DashboardDoc {
  name?: string;
  panels: DashboardPanelDef[];
}

function parseDashboard(text: string): DashboardDoc {
  const parsed = JSON.parse(text) as DashboardDoc;
  return { name: parsed.name, panels: Array.isArray(parsed.panels) ? parsed.panels : [] };
}

function titleFromAppPath(path: string): string {
  const base = path.split('/').pop() ?? path;
  return base.replace(/\.gssh\.html$/, '').replace(/[-_]+/g, ' ');
}

function ScopeChip({ scope }: { scope: 'workspace' | 'chain' }): ReactElement {
  return (
    <span
      className={`flex-none border px-[5px] py-px text-[10.5px] uppercase tracking-[.07em] ${
        scope === 'chain'
          ? 'border-[rgba(188,140,255,.3)] text-[var(--gs-stage-ship)]'
          : 'border-[rgba(91,155,255,.25)] text-[var(--gs-info)]'
      }`}
    >
      {scope}
    </span>
  );
}

function MaBtn({ title, onClick, children }: { title: string; onClick?: () => void; children: ReactNode }): ReactElement {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className="inline-flex h-[22px] w-[22px] flex-none items-center justify-center border border-[var(--gs-border)] bg-transparent text-[11px] leading-none text-[var(--gs-text-dim)] hover:border-[var(--gs-border-active)] hover:text-[var(--gs-text)]"
    >
      {children}
    </button>
  );
}

function MiniAppFrame({ panel, html, data, onToggleSize, onRemove }: {
  panel: DashboardPanelDef;
  html: string | null;
  data: unknown;
  onToggleSize: () => void;
  onRemove: () => void;
}): ReactElement {
  const frameRef = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const send = () => frame.contentWindow?.postMessage({ type: 'gssh:data', data }, '*');
    frame.addEventListener('load', send);
    send();
    return () => frame.removeEventListener('load', send);
  }, [data, html]);
  return (
    <div className={`flex min-h-0 flex-col overflow-hidden border border-[var(--gs-border)] bg-[var(--gs-bg-surface)] ${panel.size === 'full' ? 'col-span-2' : ''}`}>
      <div className="flex flex-shrink-0 items-center gap-2 border-b border-[var(--gs-border)] bg-[#070707] px-[11px] py-[7px]">
        <span className="h-[7px] w-[7px] flex-none rounded-full bg-[var(--gs-stage-ship)]" />
        <span className="truncate text-[12px] font-medium text-[var(--gs-text)]">{panel.title}</span>
        <ScopeChip scope={panel.scope ?? 'workspace'} />
        <span className="truncate font-[family-name:var(--gs-font)] text-[10px] text-[var(--gs-text-dim)]" title="agent-authored · stored as artifact">✦ {panel.app}</span>
        {panel.stale && (
          <span className="flex-none border border-[var(--gs-chip-amber-border)] bg-[var(--gs-chip-amber-bg)] px-[5px] py-px text-[10px] uppercase tracking-[.05em] text-[var(--gs-chip-amber-text)]">stale</span>
        )}
        <span className="ml-auto" />
        {panel.source && (
          <span className="flex-none font-[family-name:var(--gs-font)] text-[10px] text-[var(--gs-text-dim)]">⟳ {panel.source}{panel.updated ? ` · ${panel.updated}` : ''}</span>
        )}
        <MaBtn title="agentation — leave feedback for the agent">✎</MaBtn>
        <MaBtn title="resize" onClick={onToggleSize}>{panel.size === 'full' ? '⊟' : '⊞'}</MaBtn>
        <MaBtn title="remove" onClick={onRemove}>✕</MaBtn>
      </div>
      {html === null ? (
        <div className="p-4 text-[11px] text-[var(--gs-text-dim)]">unknown mini-app</div>
      ) : (
        <div className="min-h-0" style={{ flex: '1 1 auto', height: 260, minHeight: 80, overflow: 'auto', resize: 'vertical' }}>
          <iframe
            ref={frameRef}
            title={panel.title}
            sandbox="allow-scripts"
            srcDoc={html}
            style={{ width: '100%', height: '100%', border: 0, display: 'block', background: 'var(--gs-bg)' }}
          />
        </div>
      )}
    </div>
  );
}

export function DashboardPanel({ dashboardPath, scopeLabel, read, write, listApps }: {
  /** Artifact path of the .dashboard.json. */
  dashboardPath: string;
  scopeLabel: string;
  read: (path: string) => Promise<ArtifactRead>;
  /** Persist the dashboard doc (artifacts write RPC). Omit → read-only. */
  write?: (path: string, contentBase64: string, message: string) => Promise<string>;
  /** List available *.gssh.html mini-app artifact paths for the add palette. */
  listApps?: () => Promise<string[]>;
}): ReactElement {
  const [doc, setDoc] = useState<DashboardDoc | null>(null);
  const [apps, setApps] = useState<Record<string, string | null>>({});
  const [datas, setDatas] = useState<Record<string, unknown>>({});
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [adding, setAdding] = useState(false);
  const [palette, setPalette] = useState<string[] | null>(null);

  // `read` is usually an inline closure — hold it in a ref so a new identity
  // per parent render can't restart the load effect into a permanent spinner.
  const readRef = useRef(read);
  readRef.current = read;
  const writeRef = useRef(write);
  writeRef.current = write;
  const listAppsRef = useRef(listApps);
  listAppsRef.current = listApps;

  useEffect(() => {
    const read = readRef.current;
    let alive = true;
    setState('loading');
    void (async () => {
      try {
        const raw = await read(dashboardPath);
        const parsed = parseDashboard(decodeBase64Utf8(raw.base64));
        if (!alive) return;
        setDoc(parsed);
        const appHtml: Record<string, string | null> = {};
        const dataVals: Record<string, unknown> = {};
        await Promise.all(parsed.panels.map(async (p) => {
          try { appHtml[p.app] = decodeBase64Utf8((await read(p.app)).base64); } catch { appHtml[p.app] = null; }
          if (p.data) {
            try { dataVals[p.data] = JSON.parse(decodeBase64Utf8((await read(p.data)).base64)); } catch { dataVals[p.data] = null; }
          }
        }));
        if (!alive) return;
        setApps(appHtml);
        setDatas(dataVals);
        setState('ready');
      } catch {
        if (alive) setState('error');
      }
    })();
    return () => { alive = false; };
  }, [dashboardPath]);

  // Edits apply immediately (mock has no Save affordance): debounce-persist
  // the doc through the artifacts write RPC after any mutation.
  const dirtyRef = useRef(false);
  useEffect(() => {
    if (!dirtyRef.current || !doc) return;
    const write = writeRef.current;
    if (!write) return;
    const timer = setTimeout(() => {
      dirtyRef.current = false;
      void write(dashboardPath, encodeBase64Utf8(JSON.stringify(doc, null, 2)), `dashboard: update ${dashboardPath}`)
        .catch(() => { dirtyRef.current = true; });
    }, 600);
    return () => clearTimeout(timer);
  }, [doc, dashboardPath]);

  const mutate = useCallback((fn: (panels: DashboardPanelDef[]) => DashboardPanelDef[]): void => {
    dirtyRef.current = true;
    setDoc((d) => (d ? { ...d, panels: fn(d.panels) } : d));
  }, []);

  const openPalette = useCallback(() => {
    setAdding((a) => {
      if (!a) {
        setPalette(null);
        const list = listAppsRef.current;
        if (list) {
          void list().then((paths) => setPalette(paths.filter((p) => p.endsWith('.gssh.html')))).catch(() => setPalette([]));
        } else {
          setPalette([]);
        }
      }
      return !a;
    });
  }, []);

  const addPanel = useCallback((appPath: string) => {
    setAdding(false);
    mutate((panels) => [...panels, {
      id: `p-${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`,
      app: appPath,
      title: titleFromAppPath(appPath),
      size: 'half',
      scope: 'workspace',
    }]);
    if (!(appPath in apps)) {
      const read = readRef.current;
      void (async () => {
        try {
          const html = decodeBase64Utf8((await read(appPath)).base64);
          setApps((prev) => ({ ...prev, [appPath]: html }));
        } catch {
          setApps((prev) => ({ ...prev, [appPath]: null }));
        }
      })();
    }
  }, [apps, mutate]);

  return (
    <div className="flex h-full min-h-0 flex-col text-[12px]">
      <div className="flex flex-shrink-0 items-center gap-3 border-b border-[var(--gs-border)] bg-[#050505] px-4 py-2.5">
        <span className="text-[10px] uppercase tracking-[.12em] text-[var(--gs-text-dim)]">{scopeLabel}</span>
        <span className="text-[11px] text-[var(--gs-text-dim)]">composable gitspace-mini-apps · *.gssh.html</span>
        {write && (
          <span className="relative ml-auto flex-none">
            <button
              type="button"
              onClick={openPalette}
              className="inline-flex items-center gap-[5px] border border-[var(--gs-border)] bg-transparent px-2 py-[3px] text-[11px] text-[var(--gs-text-muted)] hover:border-[var(--gs-border-active)] hover:text-[var(--gs-text)]"
            >
              ＋ Add panel
            </button>
            {adding && (
              <div className="absolute right-0 top-[30px] z-20 flex w-[280px] flex-col border border-[var(--gs-border-active)] bg-[var(--gs-bg-overlay)] shadow-[0_8px_28px_rgba(0,0,0,.6)]">
                {palette === null ? (
                  <div className="px-3 py-[9px] text-[11px] text-[var(--gs-text-dim)]">Loading mini-apps…</div>
                ) : palette.length === 0 ? (
                  <div className="px-3 py-[9px] text-[11px] text-[var(--gs-text-dim)]">No mini-apps found (*.gssh.html)</div>
                ) : (
                  palette.map((path) => (
                    <button
                      key={path}
                      type="button"
                      onClick={() => addPanel(path)}
                      className="flex flex-col items-start gap-0.5 border-b border-[var(--gs-border-muted)] bg-transparent px-3 py-[9px] text-left last:border-b-0 hover:bg-[var(--gs-bg-hover)]"
                    >
                      <span className="flex items-center gap-[7px] text-[12px] text-[var(--gs-text)]">
                        {titleFromAppPath(path)}
                        <ScopeChip scope="workspace" />
                      </span>
                      <span className="font-[family-name:var(--gs-font)] text-[11px] text-[var(--gs-text-dim)]">✦ {path}</span>
                    </button>
                  ))
                )}
              </div>
            )}
          </span>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-4 py-3.5">
        {state === 'loading' ? (
          <div className="px-1 py-2 text-[var(--gs-text-dim)]">Loading dashboard…</div>
        ) : state === 'error' || !doc ? (
          <div className="px-1 py-2 text-[var(--gs-text-dim)]">Failed to load {dashboardPath}</div>
        ) : (
          <div className="grid grid-cols-2 content-start gap-3">
            {doc.panels.length === 0 && (
              <div className="col-span-2 px-1 py-7 text-[12.5px] text-[var(--gs-text-dim)]">
                No dashboards yet — create one, or roll up a shipped workspace's dashboards.
              </div>
            )}
            {doc.panels.map((p) => (
              <MiniAppFrame
                key={p.id}
                panel={p}
                html={apps[p.app] ?? null}
                data={p.data ? datas[p.data] : null}
                onToggleSize={() => mutate((panels) => panels.map((x) => (x.id === p.id ? { ...x, size: x.size === 'full' ? 'half' : 'full' } : x)))}
                onRemove={() => mutate((panels) => panels.filter((x) => x.id !== p.id))}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
