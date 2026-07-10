import { decodeBase64Utf8 } from './artifact-kinds.js';
/** @jsxImportSource react */
import { useEffect, useMemo, useState, type ReactElement } from 'react';
import type { SessionBackend } from '../session/backend.js';
import { BlockView } from '../blocks/render/registry.web.js';
import { BlockHostProvider, type BlockAction, type BlockHost } from '../blocks/render/host.web.js';
import { WorkflowResolutionProvider } from '../blocks/render/workflow.web.js';
import { useWorkflowResolution } from '../app/react/useWorkflowResolution.web.js';

/**
 * Workflow dock pane (mock Shell 'workflow' pane): "phased dataflow · gated
 * loops · gates · artifacts per phase". The spec is artifact-driven — agents
 * commit `*.workflow.json` (WorkflowSpecData) to the workspace artifacts
 * branch and this pane renders it through the 'workflow' block renderer.
 */
export function WorkflowPanel({ backend, workspaceId, onOpenArtifact, onOpenGoal, onOpenRubric }: {
  backend: SessionBackend | null;
  workspaceId: string;
  onOpenArtifact?: (path: string) => void;
  onOpenGoal?: () => void;
  onOpenRubric?: () => void;
}): ReactElement {
  const [specs, setSpecs] = useState<Array<{ path: string; data: unknown }>>([]);
  const [selected, setSelected] = useState(0);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  // Node identities resolve LIVE: named agents from the subagent registry
  // (the AGENTS tab's listAgentDefinitions data) and model roles from the
  // role catalog (getAgentControlInfo), polled slowly.
  const resolution = useWorkflowResolution(backend, workspaceId);

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
          try { return { path, data: JSON.parse(decodeBase64Utf8((await read.call(backend, workspaceId, path)).base64)) as unknown }; }
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
      if (action.kind !== 'open') return;
      // Created-artifact chips route by type (mock): rubric → rubric pane,
      // goal-slice/phased-goal → goal pane, else the artifact viewer.
      if (action.target === 'rubric') { onOpenRubric?.(); return; }
      if (action.target === 'goal') { onOpenGoal?.(); return; }
      onOpenArtifact?.(action.target.replace(/^artifact:/, ''));
    },
    readOnly: true,
  }), [onOpenArtifact, onOpenGoal, onOpenRubric]);

  const cur = specs[selected];

  return (
    <div className="flex h-full min-h-0 flex-col text-[12px]">
      {/* panel-head (mock PaneBox). The mock's 'Save workflow' button shipped
          with no handler — removed until editing exists (workflow specs are
          agent-authored artifacts; the pane is a viewer). */}
      <div className="flex h-8 flex-none items-center gap-2 border-b border-[var(--gs-border)] bg-[#070707] px-3">
        <span className="text-[11px] uppercase tracking-[0.1em] text-[var(--gs-text-muted)]">Workflow</span>
        <span className="truncate text-[11px] text-[var(--gs-text-muted)]">phased dataflow · gated loops · gates · artifacts per phase</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-[13px]">
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
          <div>
            {specs.length > 1 && (
              <div className="mb-2 flex flex-wrap items-center gap-1.5">
                {specs.map((sp, i) => (
                  <button
                    key={sp.path}
                    type="button"
                    onClick={() => setSelected(i)}
                    className={`inline-flex cursor-pointer items-center gap-[5px] whitespace-nowrap border px-[7px] py-[2px] text-[10.5px] uppercase leading-[1.4] tracking-[0.05em] ${
                      i === selected
                        ? 'border-[var(--gs-border-active)] bg-[var(--gs-bg-active)] text-[var(--gs-text)]'
                        : 'border-[var(--gs-border)] bg-[var(--gs-chip-dim-bg)] text-[var(--gs-chip-dim-text)] hover:text-[var(--gs-text-muted)]'
                    }`}
                  >
                    {sp.path.split('/').pop()}
                  </button>
                ))}
              </div>
            )}
            <BlockHostProvider host={host}>
              <WorkflowResolutionProvider resolution={resolution}>
                <BlockView block={{ id: cur.path, type: 'workflow', data: cur.data }} />
              </WorkflowResolutionProvider>
            </BlockHostProvider>
          </div>
        )}
      </div>
    </div>
  );
}
