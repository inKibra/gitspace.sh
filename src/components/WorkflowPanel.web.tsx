import { decodeBase64Utf8 } from './artifact-kinds.js';
/** @jsxImportSource react */
import { useEffect, useMemo, useState, type ReactElement } from 'react';
import type { SessionBackend } from '../session/backend.js';
import type { GoalValidation } from '../types/goals.js';
import { parseDocSlices, workflowSpecWarnings, type WorkspaceWorkflowSpec } from '../core/goal-gates.js';
import { BlockView } from '../blocks/render/registry.web.js';
import { BlockHostProvider, type BlockAction, type BlockHost } from '../blocks/render/host.web.js';
import { WorkflowGatesProvider, WorkflowResolutionProvider, type WorkflowLiveGates } from '../blocks/render/workflow.web.js';
import { useWorkflowResolution } from '../app/react/useWorkflowResolution.web.js';

/**
 * Workflow dock pane (mock Shell 'workflow' pane): "phased dataflow · gated
 * loops · gates · artifacts per phase". The spec is artifact-driven — agents
 * commit `*.workflow.json` (WorkflowSpecData) to the workspace artifacts
 * branch and this pane renders it through the 'workflow' block renderer.
 *
 * Goal-rubric-workflow interconnect: when the workspace's goal is bound
 * (`goal` prop) and the spec is THE single canonical workflow, phases render
 * live COMPUTED gates (core/goal-gates.ts), slice chips navigate to the goal
 * doc, rubric chips open the rubric filtered to the phase, and `space
 * workflow validate` warnings surface as an amber strip in the header.
 */
export function WorkflowPanel({ backend, workspaceId, goal, onOpenArtifact, onOpenGoal, onOpenRubric, onOpenGoalSlice, onOpenRubricPhase, onWaiveGate }: {
  backend: SessionBackend | null;
  workspaceId: string;
  /** The workspace's bound goal (validation drives computed gates; the doc
   *  markdown drives slice dangling checks). Null = no goal, render static. */
  goal?: { id: string; validation?: GoalValidation | null; docMarkdown?: string | null } | null;
  onOpenArtifact?: (path: string) => void;
  onOpenGoal?: () => void;
  onOpenRubric?: () => void;
  /** Open the goal doc pane scrolled to a slice heading. */
  onOpenGoalSlice?: (sliceId: string) => void;
  /** Open the rubric pane filtered to a phase's owed requirements. */
  onOpenRubricPhase?: (phase: string) => void;
  /** HUMAN-ONLY gate waive (backend.waiveGoalGate seam — reason required). */
  onWaiveGate?: (phase: string) => void;
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
      // Human-only gate waive (the renderer's 'waive…' button).
      if (action.kind === 'run' && action.actionId === 'gate-waive') {
        const phase = (action.payload as { phase?: string } | undefined)?.phase;
        if (phase) onWaiveGate?.(phase);
        return;
      }
      if (action.kind !== 'open') return;
      // Chip routing: rubric chips + gate chips open the rubric filtered to
      // the phase; slice chips open the goal doc at the heading; else the
      // named artifact viewer.
      if (action.target.startsWith('rubric-phase:')) {
        const phase = action.target.slice('rubric-phase:'.length);
        if (onOpenRubricPhase) onOpenRubricPhase(phase); else onOpenRubric?.();
        return;
      }
      if (action.target === 'rubric') { onOpenRubric?.(); return; }
      if (action.target.startsWith('goal-slice:')) {
        const sliceId = action.target.slice('goal-slice:'.length);
        if (onOpenGoalSlice) onOpenGoalSlice(sliceId); else onOpenGoal?.();
        return;
      }
      if (action.target === 'goal') { onOpenGoal?.(); return; }
      onOpenArtifact?.(action.target.replace(/^artifact:/, ''));
    },
    readOnly: true,
  }), [onOpenArtifact, onOpenGoal, onOpenRubric, onOpenGoalSlice, onOpenRubricPhase, onWaiveGate]);

  const cur = specs[selected];

  // Doc slices from the bound goal (same parse the CLI uses — parity with
  // `space workflow validate`, which treats a missing doc as no slices).
  const docSliceIds = useMemo(
    () => parseDocSlices(goal?.docMarkdown ?? '').map((s) => s.id),
    [goal?.docMarkdown],
  );

  // Live gates only for THE canonical workflow (one *.workflow.json — the
  // same one-per-workspace rule loadWorkspaceWorkflow enforces).
  const gates = useMemo<WorkflowLiveGates | null>(() => {
    if (specs.length !== 1 || !goal?.validation) return null;
    // Same dangling rule as the warnings strip / CLI: a missing doc means no
    // known slices, so every ref ambers (truthful — there are no headings).
    return {
      validation: goal.validation,
      docSliceIds: new Set(docSliceIds),
      canWaive: Boolean(onWaiveGate),
    };
  }, [specs.length, goal?.validation, docSliceIds, onWaiveGate]);

  // `space workflow validate` warnings, computed on the pane's own data
  // (amber state — dangling slice refs, phase-name oddities, extra specs).
  const warnings = useMemo(() => {
    if (state !== 'ready') return [];
    const list: string[] = [];
    if (specs.length > 1) {
      list.push(`Multiple workflow specs on the artifacts mount — a workspace has ONE workflow. Found: ${specs.map((s) => s.path).join(', ')}.`);
    }
    if (cur && goal !== undefined) {
      list.push(...workflowSpecWarnings(cur.data as WorkspaceWorkflowSpec, docSliceIds));
    }
    return list;
  }, [state, specs, cur, goal, docSliceIds]);

  return (
    <div className="flex h-full min-h-0 flex-col text-[12px]">
      {/* panel-head (mock PaneBox). The mock's 'Save workflow' button shipped
          with no handler — removed until editing exists (workflow specs are
          agent-authored artifacts; the pane is a viewer). */}
      <div className="flex h-8 flex-none items-center gap-2 border-b border-[var(--gs-border)] bg-[#070707] px-3">
        <span className="text-[11px] uppercase tracking-[0.1em] text-[var(--gs-text-muted)]">Workflow</span>
        <span className="truncate text-[11px] text-[var(--gs-text-muted)]">phased dataflow · gated loops · gates · artifacts per phase</span>
      </div>
      {/* amber strip: `space workflow validate` warnings (none → nothing) */}
      {warnings.length > 0 && (
        <div className="flex-none border-b border-[var(--gs-border)] border-l-2 border-l-[var(--gs-warning)] bg-[rgba(255,204,0,0.04)] px-3 py-1.5">
          {warnings.map((w, i) => (
            <div key={i} className="flex items-baseline gap-1.5 text-[11px] leading-[1.5] text-[var(--gs-warning)]">
              <span className="flex-none">⚠</span>
              <span className="min-w-0 text-[var(--gs-text-muted)]">{w}</span>
            </div>
          ))}
        </div>
      )}
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
                <WorkflowGatesProvider gates={gates}>
                  <BlockView block={{ id: cur.path, type: 'workflow', data: cur.data }} />
                </WorkflowGatesProvider>
              </WorkflowResolutionProvider>
            </BlockHostProvider>
          </div>
        )}
      </div>
    </div>
  );
}
