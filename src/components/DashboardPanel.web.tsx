/** @jsxImportSource react */
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import type { ArtifactRead } from './ArtifactPanel.web.js';

/**
 * Dashboard canvas (mock: DashboardCanvas) — a composable grid of gitspace
 * mini-apps, driven ENTIRELY by artifacts:
 *   <name>.dashboard.json  → { name?, panels: [{ id, app, title, data, size }] }
 *   <app>.gssh.html        → sandboxed iframe (allow-scripts only)
 *   <data>.json            → handed to the app via postMessage({type:'gssh:data'})
 * Panel edits (resize/remove) persist back through the artifacts write RPC
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
}

export interface DashboardDoc {
  name?: string;
  panels: DashboardPanelDef[];
}

function parseDashboard(text: string): DashboardDoc {
  const parsed = JSON.parse(text) as DashboardDoc;
  return { name: parsed.name, panels: Array.isArray(parsed.panels) ? parsed.panels : [] };
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
    <div className={`flex min-h-0 flex-col border border-[var(--gs-border)] bg-[var(--gs-bg-elevated)] ${panel.size === 'full' ? 'col-span-2' : ''}`}>
      <div className="flex flex-shrink-0 items-center gap-2 border-b border-[var(--gs-border)] px-2 py-1 text-[11px]">
        <span className="text-[var(--gs-accent)]">▦</span>
        <span className="truncate text-[var(--gs-text)]">{panel.title}</span>
        <span className="ml-auto flex items-center gap-1">
          <button type="button" onClick={onToggleSize} title="Toggle size" className="px-1 text-[var(--gs-text-ghost)] hover:text-[var(--gs-text)]">{panel.size === 'full' ? '◫' : '⃞'}</button>
          <button type="button" onClick={onRemove} title="Remove panel" className="px-1 text-[var(--gs-text-ghost)] hover:text-[var(--gs-danger)]">✕</button>
        </span>
      </div>
      {html === null ? (
        <div className="flex h-[220px] items-center justify-center text-[11px] text-[var(--gs-danger)]">app artifact missing: {panel.app}</div>
      ) : (
        <iframe
          ref={frameRef}
          title={panel.title}
          sandbox="allow-scripts"
          srcDoc={html}
          style={{ width: '100%', height: 260, border: 0, display: 'block', background: 'var(--gs-bg)' }}
        />
      )}
    </div>
  );
}

export function DashboardPanel({ dashboardPath, scopeLabel, read, write }: {
  /** Artifact path of the .dashboard.json. */
  dashboardPath: string;
  scopeLabel: string;
  read: (path: string) => Promise<ArtifactRead>;
  /** Persist the dashboard doc (artifacts write RPC). Omit → read-only. */
  write?: (path: string, contentBase64: string, message: string) => Promise<string>;
}): ReactElement {
  const [doc, setDoc] = useState<DashboardDoc | null>(null);
  const [apps, setApps] = useState<Record<string, string | null>>({});
  const [datas, setDatas] = useState<Record<string, unknown>>({});
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  // `read` is usually an inline closure — hold it in a ref so a new identity
  // per parent render can't restart the load effect into a permanent spinner.
  const readRef = useRef(read);
  readRef.current = read;

  useEffect(() => {
    const read = readRef.current;
    let alive = true;
    setState('loading');
    void (async () => {
      try {
        const raw = await read(dashboardPath);
        const parsed = parseDashboard(atob(raw.base64));
        if (!alive) return;
        setDoc(parsed);
        const appHtml: Record<string, string | null> = {};
        const dataVals: Record<string, unknown> = {};
        await Promise.all(parsed.panels.map(async (p) => {
          try { appHtml[p.app] = atob((await read(p.app)).base64); } catch { appHtml[p.app] = null; }
          if (p.data) {
            try { dataVals[p.data] = JSON.parse(atob((await read(p.data)).base64)); } catch { dataVals[p.data] = null; }
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

  const mutate = useCallback((fn: (panels: DashboardPanelDef[]) => DashboardPanelDef[]): void => {
    setDoc((d) => (d ? { ...d, panels: fn(d.panels) } : d));
    setDirty(true);
  }, []);

  const save = useCallback(async () => {
    if (!doc || !write || saving) return;
    setSaving(true);
    try {
      await write(dashboardPath, btoa(JSON.stringify(doc, null, 2)), `dashboard: update ${dashboardPath}`);
      setDirty(false);
    } finally {
      setSaving(false);
    }
  }, [doc, write, saving, dashboardPath]);

  return (
    <div className="flex h-full min-h-0 flex-col text-[12px]">
      <div className="flex flex-shrink-0 items-center gap-2 border-b border-[var(--gs-border-muted)] px-3 py-1.5">
        <span className="text-[var(--gs-accent)]">▦</span>
        <span className="truncate font-[family-name:var(--gs-font-mono)] text-[12px] text-[var(--gs-text)]">{doc?.name ?? dashboardPath}</span>
        <span className="text-[10px] text-[var(--gs-text-ghost)]">{scopeLabel} · composable mini-apps · *.gssh.html</span>
        {write && dirty && (
          <button type="button" onClick={() => void save()} disabled={saving} className="ml-auto border border-[#1f4a2f] px-2 py-0.5 text-[11px] text-[var(--gs-accent)] disabled:opacity-40">
            {saving ? 'Saving…' : 'Save'}
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {state === 'loading' ? (
          <div className="flex h-full items-center justify-center text-[var(--gs-text-dim)]">Loading dashboard…</div>
        ) : state === 'error' || !doc ? (
          <div className="flex h-full items-center justify-center text-[var(--gs-danger)]">Failed to load {dashboardPath}</div>
        ) : doc.panels.length === 0 ? (
          <div className="flex h-full items-center justify-center text-[var(--gs-text-dim)]">No panels yet — agents (or a roll-up) add mini-app panels here.</div>
        ) : (
          <div className="grid grid-cols-2 gap-3">
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
