/** @jsxImportSource react */
import { useEffect, useMemo, useState, type ReactElement } from 'react';
import type { SessionBackend } from '../session/backend.js';
import { BlockView } from '../blocks/render/registry.web.js';
import { BlockHostProvider, type BlockAction, type BlockHost } from '../blocks/render/host.web.js';

/**
 * ⟜ Workflow dock pane (mock Shell 'workflow' pane): "phased dataflow · gated
 * loops · gates · artifacts per phase". The spec is artifact-driven — agents
 * commit `*.workflow.json` (WorkflowSpecData) to the workspace artifacts
 * branch and this pane renders it through the 'workflow' block renderer.
 */
export function WorkflowPanel({ backend, workspaceId, onOpenArtifact }: {
  backend: SessionBackend | null;
  workspaceId: string;
  onOpenArtifact?: (path: string) => void;
}): ReactElement {
  const [specs, setSpecs] = useState<Array<{ path: string; data: unknown }>>([]);
  const [selected, setSelected] = useState(0);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    let alive = true;
    const list = backend?.listWorkspaceArtifacts;
    const read = backend?.readWorkspaceArtifact;
    if (!list || !read) { setState('error'); return; }
    void (async () => {
      try {
        const entries = await list.call(backend, workspaceId);
        const paths = entries.filter((e) => e.path.endsWith('.workflow.json')).map((e) => e.path);
        const loaded = await Promise.all(paths.map(async (path) => {
          try { return { path, data: JSON.parse(atob((await read.call(backend, workspaceId, path)).base64)) as unknown }; }
          catch { return null; }
        }));
        if (!alive) return;
        setSpecs(loaded.filter((x): x is { path: string; data: unknown } => x !== null));
        setState('ready');
      } catch {
        if (alive) setState('error');
      }
    })();
    return () => { alive = false; };
  }, [backend, workspaceId]);

  const host = useMemo<BlockHost>(() => ({
    resolve: () => {},
    dispatch: (action: BlockAction) => {
      if (action.kind === 'open' && onOpenArtifact) {
        onOpenArtifact(action.target.replace(/^artifact:/, ''));
      }
    },
    readOnly: true,
  }), [onOpenArtifact]);

  const cur = specs[selected];
  const spec = cur?.data as { recipe?: string; recipePath?: string } | undefined;

  return (
    <div className="flex h-full min-h-0 flex-col text-[12px]">
      <div className="flex flex-shrink-0 items-center gap-2 border-b border-[var(--gs-border-muted)] px-3 py-1.5">
        <span className="text-[var(--gs-accent)]">⟜</span>
        <span className="truncate font-[family-name:var(--gs-font-mono)] text-[12px] text-[var(--gs-text)]">{spec?.recipe ?? 'Workflow'}</span>
        <span className="text-[10px] text-[var(--gs-text-ghost)]">phased dataflow · gated loops · gates · artifacts per phase</span>
        {specs.length > 1 && (
          <select
            value={selected}
            onChange={(e) => setSelected(Number(e.target.value))}
            className="ml-auto border border-[var(--gs-border)] bg-[var(--gs-bg-elevated)] px-1 py-0.5 text-[10px] text-[var(--gs-text-dim)]"
          >
            {specs.map((sp, i) => <option key={sp.path} value={i}>{sp.path.split('/').pop()}</option>)}
          </select>
        )}
        {spec?.recipePath && <span className="ml-auto font-[family-name:var(--gs-font-mono)] text-[10px] text-[var(--gs-text-dim)]">{spec.recipePath}</span>}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {state === 'loading' ? (
          <div className="flex h-full items-center justify-center text-[var(--gs-text-dim)]">Loading…</div>
        ) : state === 'error' ? (
          <div className="flex h-full items-center justify-center text-[var(--gs-danger)]">Workflow artifacts unavailable.</div>
        ) : !cur ? (
          <div className="flex h-full flex-col items-center justify-center gap-1 text-center">
            <span className="text-[var(--gs-text-dim)]">No workflow spec yet.</span>
            <span className="max-w-[420px] text-[11px] text-[var(--gs-text-ghost)]">
              Agents commit <span className="font-[family-name:var(--gs-font-mono)]">&lt;name&gt;.workflow.json</span> to the
              workspace artifacts branch — the phased dataflow (inputs, gates, loops, agents, outputs) renders here.
            </span>
          </div>
        ) : (
          <div className="max-w-[920px]">
            <BlockHostProvider host={host}>
              <BlockView block={{ id: cur.path, type: 'workflow', data: cur.data }} />
            </BlockHostProvider>
          </div>
        )}
      </div>
    </div>
  );
}
