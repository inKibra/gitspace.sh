/** @jsxImportSource react */
import { createContext, Fragment, useContext, type ReactElement, type ReactNode } from 'react';
import type { WfCreatedArtifact, WfGateType, WfNode, WfPhase, WfRef, WorkflowSpecData } from '../types/content.js';
import type { GoalValidation } from '../../types/goals.js';
import { gateStatusForPhase, gateWaiveInfoForPhase, type GateStatus } from '../../core/goal-gates.js';
import { modelRoleLabel, normalizeModelRole, wfNodeModelRoleLabel } from '../model-roles.js';
import { defineRenderer } from './registry.web.js';
import { useBlockHost } from './host.web.js';

// Workflow block: a recipe traversal rendered as phase sections with
// source/artifact-typed dataflow (◇ artifact vs ▤ source), gate banners toned
// by gate type, gated-loop lines, per-phase created artifacts, node rows,
// and required outputs. Mirrors the agent-surfaces mock.

const MONO = 'font-[family-name:var(--gs-font)]';

// io tones: source = info blue, artifact = purple
const REF_TONE: Record<WfRef['io'], string> = {
  source: 'text-[var(--gs-info)] border-[rgba(91,155,255,0.3)] bg-[rgba(91,155,255,0.05)]',
  artifact: 'text-[var(--gs-purple)] border-[rgba(188,140,255,0.35)] bg-[rgba(188,140,255,0.06)]',
};
function RefChip({ r }: { r: WfRef }): ReactElement {
  return (
    <span className={`inline-flex items-center gap-1 ${MONO} text-[10.5px] px-1.5 py-px border ${REF_TONE[r.io]}`}>
      <span className="text-[10px]">{r.io === 'artifact' ? '◇' : '▤'}</span>
      {r.name}
    </span>
  );
}

const DOT: Record<string, string> = {
  done: 'bg-[var(--gs-success)]',
  running: 'bg-[var(--gs-success)] animate-pulse',
  pending: 'bg-[var(--gs-text-dim)]',
  // Gate-derived dot states (live interconnect — the ACTIVE workflow's node
  // dots reflect the phase's computed gate, not the static JSON status).
  'gate-unmet': 'bg-[var(--gs-danger)]',
  'gate-waived': 'bg-[var(--gs-warning)]',
};
function StatusDot({ status, title }: { status?: WfNode['status'] | 'gate-unmet' | 'gate-waived'; title?: string }): ReactElement {
  return <span title={title} className={`w-[7px] h-[7px] rounded-full flex-none ${DOT[status ?? 'pending']}`} />;
}

/** Node dot state derived from a phase's computed gate (live workflow). */
function gateDotStatus(gate: GateStatus): 'done' | 'pending' | 'gate-unmet' | 'gate-waived' {
  if (gate.owed.length === 0) return 'pending'; // trivial — dim
  if (gate.satisfied) return 'done';
  if (gate.waived) return 'gate-waived';
  return 'gate-unmet';
}

const GATE_TONE: Record<WfGateType, string> = {
  human: 'text-[var(--gs-warning)] border-[var(--gs-warning)]',
  orchestration: 'text-[var(--gs-purple)] border-[var(--gs-purple)]',
  command: 'text-[var(--gs-info)] border-[var(--gs-info)]',
};

// Created-artifact chips route by type: rubric → rubric pane FILTERED to the
// owning phase's owed requirements (rubric-phase:<name>), goal-slice/
// phased-goal → goal pane (scrolled to the slice heading when the artifact
// carries a sliceId), else the named artifact viewer.
function cartTarget(a: WfCreatedArtifact, phase?: string): string {
  if (a.type === 'rubric') return phase ? `rubric-phase:${phase}` : 'rubric';
  if (a.type === 'goal-slice' || a.type === 'phased-goal') return a.sliceId ? `goal-slice:${a.sliceId}` : 'goal';
  return `artifact:${a.name}`;
}

/** Live model resolution for workflow nodes, from the same seams the settings
 *  surfaces use: `agents` = named agent → resolved chip label (AGENTS tab /
 *  listAgentDefinitions via agentResolutionLabel), `roles` = model-role id →
 *  display label + assigned model (MODEL ROLES catalog via getAgentControlInfo;
 *  model null = follows the session model). Null when the surface has no live
 *  backend (e.g. a transcript stream) — nodes then fall back to static labels. */
export interface WorkflowLiveResolution {
  agents: Record<string, string>;
  roles: Record<string, { label: string; model: string | null }>;
}

const WorkflowResolutionContext = createContext<WorkflowLiveResolution | null>(null);

export function WorkflowResolutionProvider({ resolution, children }: { resolution: WorkflowLiveResolution | null; children: ReactNode }): ReactElement {
  return <WorkflowResolutionContext.Provider value={resolution}>{children}</WorkflowResolutionContext.Provider>;
}

/** Live phase gates for the ACTIVE workflow (goal-rubric-workflow
 *  interconnect): the surface injects the bound goal's validation so each
 *  phase renders its COMPUTED gate (core/goal-gates.ts gateStatusForPhase)
 *  instead of static JSON state. Null when the surface has no live goal
 *  (transcript streams, galleries) or the spec isn't the workspace's single
 *  canonical workflow — phases then render statically, exactly as before. */
export interface WorkflowLiveGates {
  validation: GoalValidation;
  /** Slice ids currently derivable from the goal doc (dangling check);
   *  null when the doc is unknown — slice chips then never amber. */
  docSliceIds: Set<string> | null;
  /** Surface offers the HUMAN-ONLY waive (backend.waiveGoalGate seam). */
  canWaive: boolean;
}

const WorkflowGatesContext = createContext<WorkflowLiveGates | null>(null);

export function WorkflowGatesProvider({ gates, children }: { gates: WorkflowLiveGates | null; children: ReactNode }): ReactElement {
  return <WorkflowGatesContext.Provider value={gates}>{children}</WorkflowGatesContext.Provider>;
}

function NodeCard({ n, dotOverride }: { n: WfNode; dotOverride?: 'done' | 'pending' | 'gate-unmet' | 'gate-waived' }): ReactElement {
  const live = useContext(WorkflowResolutionContext);
  const gate = n.kind === 'gate';
  // Node identity: a NAMED agent from the subagent registry, or a named MODEL
  // ROLE ("run this step with the Vision role") — both canonical. Freeform
  // `role` titles are parse-only back-compat. Chip:
  //  - agent only → the agent's LIVE resolution ('Current model', 'Thinking — …')
  //  - agent + modelRole → the role as an explicit per-step model override
  //    ('reviewer · Vision — <model>')
  //  - role-identity node → the role's assigned model from the live catalog
  //  - legacy title nodes → authored model role label; raw aliases translate
  //    and never render raw.
  const roleId = n.modelRole ? normalizeModelRole(n.modelRole) : null;
  const liveRole = roleId ? live?.roles[roleId] : undefined;
  const roleLabel = roleId ? liveRole?.label ?? modelRoleLabel(roleId) : null;
  const roleChip = liveRole ? (liveRole.model ? `${liveRole.label} — ${liveRole.model}` : liveRole.label) : roleLabel;
  const identity = n.agent ?? n.role ?? roleLabel ?? undefined;
  const modelRole = n.agent
    ? (roleId ? roleChip ?? undefined : live?.agents[n.agent])
    : roleId && identity === roleLabel
      ? liveRole?.model ?? undefined // role-identity: label already shown
      : n.modelRole || n.model
        ? roleChip ?? wfNodeModelRoleLabel(n)
        : undefined;
  return (
    <div
      className={`border min-w-[152px] max-w-[210px] ${
        gate
          ? 'border-dashed border-[var(--gs-border-active)] bg-[#0a0a0a] self-center min-w-[118px] max-w-[140px]'
          : `${n.kind === 'tool' ? 'border-dashed' : ''} ${n.status === 'running' ? 'border-[rgba(0,255,102,0.4)]' : 'border-[var(--gs-border)]'} bg-[var(--gs-bg-elevated)]`
      }`}
    >
      <div className={`flex items-center gap-1.5 px-2 py-1.5 text-[11px] ${gate ? '' : 'border-b border-[var(--gs-border)]'}`}>
        <StatusDot
          status={dotOverride ?? n.status}
          title={dotOverride ? 'live: reflects this phase’s computed gate' : undefined}
        />
        <span className="text-[var(--gs-text)] font-medium">
          {gate ? `gate · ${n.gateType ?? 'human'}` : identity}
        </span>
        {modelRole && <span className={`ml-auto text-[10px] text-[var(--gs-text-dim)] ${MONO}`}>{modelRole}</span>}
      </div>
      {n.fanout && (
        <div className="px-2 pt-1 pb-1.5 border-t border-dashed border-[var(--gs-border)]">
          <div className="flex items-center gap-1 text-[10px] text-[var(--gs-warning)]"><span className="text-[12px]">⋔</span>for each {n.fanout.over}</div>
          <div className="flex flex-wrap gap-1 mt-1">
            {n.fanout.instances.map((x, i) => (
              <span key={i} className={`${MONO} text-[10px] text-[var(--gs-text-muted)] bg-black border border-[var(--gs-border-muted)] px-1`}>{x}</span>
            ))}
          </div>
        </div>
      )}
      {n.reads && (
        <div className="flex items-baseline gap-1 flex-wrap px-2 py-1">
          <span className="flex-none w-[34px] text-[10.5px] uppercase tracking-[0.04em] text-[var(--gs-info)]">reads</span>
          {n.reads.map((r, i) => <RefChip key={i} r={r} />)}
        </div>
      )}
      {n.writes && (
        <div className="flex items-baseline gap-1 flex-wrap px-2 py-1 pt-0">
          <span className="flex-none w-[34px] text-[10.5px] uppercase tracking-[0.04em] text-[var(--gs-accent)]">writes</span>
          {n.writes.map((r, i) => <RefChip key={i} r={r} />)}
        </div>
      )}
    </div>
  );
}

/** Live gate chip: computed from the bound goal's validation — satisfied
 *  (green) / unmet (red, 'n owed, m unmet', opens the rubric filtered to the
 *  phase) / waived (amber, reason on hover) / trivial (dim, nothing owed). */
function PhaseGateChip({ gate, waiveTitle, onOpenRubric }: {
  gate: GateStatus;
  waiveTitle?: string;
  onOpenRubric: () => void;
}): ReactElement {
  const base = 'whitespace-nowrap text-[10.5px] px-1.5 py-px border';
  if (gate.owed.length === 0) {
    return <span className={`${base} text-[var(--gs-text-dim)] border-[var(--gs-border)]`} title="no requirements owed by this phase — gate trivially satisfied">◇ gate · trivial</span>;
  }
  if (gate.satisfied) {
    return (
      <button type="button" onClick={onOpenRubric} title={`all ${gate.owed.length} owed requirement(s) accepted — open the rubric filtered to this phase`} className={`${base} cursor-pointer bg-transparent text-[var(--gs-success)] border-[rgba(0,255,102,0.35)] hover:border-[var(--gs-success)]`}>
        ✓ gate · satisfied · {gate.owed.length} owed
      </button>
    );
  }
  if (gate.waived) {
    return (
      <button type="button" onClick={onOpenRubric} title={waiveTitle ?? 'gate waived by a human'} className={`${base} cursor-pointer bg-transparent text-[var(--gs-warning)] border-[var(--gs-warning)]`}>
        ◆ gate · waived · {gate.unmet.length} unmet
      </button>
    );
  }
  return (
    <button type="button" onClick={onOpenRubric} title="open the rubric filtered to this phase's owed requirements" className={`${base} cursor-pointer bg-transparent text-[var(--gs-danger)] border-[var(--gs-danger)] hover:bg-[var(--gs-chip-red-bg)]`}>
      ✕ gate · {gate.owed.length} owed, {gate.unmet.length} unmet
    </button>
  );
}

function PhaseSection({ p, index }: {
  p: WfPhase;
  index: number;
}): ReactElement {
  const host = useBlockHost();
  const liveGates = useContext(WorkflowGatesContext);
  const created = p.created ?? [];
  // Live computed gate for this phase (goal-rubric-workflow interconnect).
  const gate = liveGates ? gateStatusForPhase({ validation: liveGates.validation }, p.name) : null;
  const waiveInfo = gate?.waived && liveGates ? gateWaiveInfoForPhase(liveGates.validation, p.name) : null;
  const dotOverride = gate ? gateDotStatus(gate) : undefined;
  const openRubricForPhase = (): void => host.dispatch({ kind: 'open', target: `rubric-phase:${p.name}` });
  return (
    <div className="border border-[var(--gs-border)]">
      {/* header: phase n · name · live gate chip (computed) · gate banner toned by gate type */}
      <div className="flex items-center gap-2 flex-wrap px-3 py-2 bg-[var(--gs-bg-elevated)] border-b border-[var(--gs-border)]">
        <span className="text-[10.5px] uppercase tracking-[0.1em] text-[var(--gs-text-dim)]">phase {index + 1}</span>
        <span className="text-[12.5px] font-medium text-[var(--gs-text)]">{p.name}</span>
        <span className="ml-auto flex items-center gap-1.5">
          {gate && (
            <PhaseGateChip
              gate={gate}
              waiveTitle={waiveInfo ? `waived by ${waiveInfo.actor}: ${waiveInfo.reason}` : undefined}
              onOpenRubric={openRubricForPhase}
            />
          )}
          {gate && !gate.satisfied && !gate.waived && liveGates?.canWaive && (
            <button
              type="button"
              onClick={() => host.dispatch({ kind: 'run', actionId: 'gate-waive', payload: { phase: p.name } })}
              title="Human-only: waive this gate with a recorded reason"
              className="whitespace-nowrap border border-dashed border-[var(--gs-warning)] bg-transparent px-1.5 py-px text-[10.5px] text-[var(--gs-warning)] cursor-pointer hover:bg-[var(--gs-chip-amber-bg)]"
            >
              waive…
            </button>
          )}
          {p.gate && <span className={`whitespace-nowrap text-[10.5px] px-1.5 py-px border ${GATE_TONE[p.gate.type]}`}>◆ gate · {p.gate.label}</span>}
        </span>
      </div>
      {/* goal-doc slices this phase reads (heading-anchored; chips open the
          goal doc scrolled to the heading; dangling ids render amber) */}
      {(p.slices?.length ?? 0) > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap px-3 py-1.5 border-b border-[var(--gs-border-muted)]">
          <span className="flex-none text-[10px] uppercase tracking-[0.08em] text-[var(--gs-text-dim)]">slices</span>
          {p.slices!.map((sliceId) => {
            const dangling = liveGates?.docSliceIds ? !liveGates.docSliceIds.has(sliceId) : false;
            return dangling ? (
              <span
                key={sliceId}
                title={`"${sliceId}" is not a heading in the goal doc`}
                className={`inline-flex items-center gap-1 ${MONO} text-[10.5px] px-1.5 py-px border border-[var(--gs-warning)] bg-[var(--gs-chip-amber-bg)] text-[var(--gs-chip-amber-text)]`}
              >
                ⚠ slice missing: {sliceId}
              </span>
            ) : (
              <button
                key={sliceId}
                type="button"
                onClick={() => host.dispatch({ kind: 'open', target: `goal-slice:${sliceId}` })}
                title="open the goal doc at this heading"
                className={`inline-flex items-center gap-1 ${MONO} text-[10.5px] px-1.5 py-px border cursor-pointer text-[var(--gs-accent)] border-[rgba(0,255,102,0.3)] bg-[rgba(0,255,102,0.04)] hover:border-[var(--gs-accent)]`}
              >
                § {sliceId}
              </button>
            );
          })}
        </div>
      )}
      {/* inputs */}
      <div className="flex items-center gap-1.5 flex-wrap px-3 py-1.5 border-b border-[var(--gs-border-muted)]">
        <span className="flex-none w-[22px] text-[10px] uppercase tracking-[0.08em] text-[var(--gs-text-dim)]">in</span>
        {p.inputs.map((r, i) => <RefChip key={i} r={r} />)}
      </div>
      {/* node flow */}
      <div className="flex items-center flex-wrap px-3 py-3">
        {p.nodes.map((n, ni) => (
          <Fragment key={n.id}>
            {ni > 0 && (
              <div className="flex flex-col items-center justify-center px-1.5 min-w-[62px]">
                {p.nodes[ni - 1].out && <span className={`${MONO} text-[10px] text-[var(--gs-text-dim)] text-center mb-0.5`}>{p.nodes[ni - 1].out}</span>}
                <span className="text-[10px] text-[var(--gs-text-muted)]">▶</span>
              </div>
            )}
            <NodeCard n={n} dotOverride={dotOverride} />
          </Fragment>
        ))}
      </div>
      {/* gated loop */}
      {p.loop && (
        <div className="flex items-center gap-2 mx-3 mb-3 px-2.5 py-1.5 bg-[rgba(255,204,0,0.04)] border border-[var(--gs-border)] border-l-2 border-l-[var(--gs-warning)] text-[11px] text-[var(--gs-text-muted)]">
          <span className="text-[14px] text-[var(--gs-warning)]">↺</span>
          <span>gated loop — {p.loop}</span>
          {p.gate && <span className="ml-auto text-[10px]">exit owned by <b className="font-medium text-[var(--gs-warning)]">{p.gate.label}</b></span>}
        </div>
      )}
      {/* created artifacts. The mock's ephemeral '+ create artifact' button
          shipped with no real backing (it only mutated local component state)
          — removed until creating an artifact does something real; artifacts
          are agent-authored via the workflow spec. */}
      <div className="flex items-center gap-[7px] flex-wrap px-[11px] py-2 border-t border-[var(--gs-border-muted)] bg-[rgba(188,140,255,0.03)]">
        <span className="flex-none text-[10px] uppercase tracking-[0.08em] text-[var(--gs-purple)]">artifacts</span>
        {created.length === 0 && <span className="text-[10.5px] text-[var(--gs-text-dim)]">none declared for this phase</span>}
        {created.map((a, i) => (
          <button
            key={i}
            type="button"
            onClick={() => host.dispatch({ kind: 'open', target: cartTarget(a, p.name) })}
            className="inline-flex items-center gap-[7px] border border-[var(--gs-border)] border-l-2 border-l-[var(--gs-purple)] hover:border-[var(--gs-purple)] bg-[#0a0a0a] px-2 py-[3px] text-[11px] cursor-pointer transition-colors"
          >
            <span className="text-[10.5px] uppercase tracking-[0.04em] text-[var(--gs-purple)]">{a.type}</span>
            <span className="text-[var(--gs-text)]">{a.name}</span>
            {a.from && <span className={`${MONO} text-[10.5px] text-[var(--gs-text-dim)]`}>{a.from}</span>}
            {a.passedTo && <span className="text-[10px] text-[var(--gs-info)]">→ {a.passedTo}</span>}
          </button>
        ))}
      </div>
      {/* outputs */}
      <div className="flex items-center gap-1.5 flex-wrap px-3 py-1.5 border-t border-[var(--gs-border-muted)]">
        <span className="flex-none w-[22px] text-[10px] uppercase tracking-[0.08em] text-[var(--gs-text-dim)]">out</span>
        {p.outputs.map((a, i) => (
          <span
            key={i}
            className={`inline-flex items-center gap-1.5 ${MONO} text-[10.5px] px-1.5 py-px border ${
              a.required ? 'text-[var(--gs-text)] border-[var(--gs-border-active)]' : 'text-[var(--gs-text-muted)] border-[var(--gs-border)]'
            } border-l-2 ${a.io === 'artifact' ? 'border-l-[var(--gs-purple)]' : 'border-l-[var(--gs-info)]'} bg-[#0a0a0a] ${a.status === 'pending' ? 'opacity-55' : ''}`}
          >
            <span className={`text-[10px] ${a.io === 'artifact' ? 'text-[var(--gs-purple)]' : 'text-[var(--gs-info)]'}`}>{a.io === 'artifact' ? '◇' : '▤'}</span>
            {a.name}
            <span className="text-[10.5px] uppercase text-[var(--gs-text-dim)]">{a.kind}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function Workflow({ data }: { data: WorkflowSpecData }): ReactElement {
  return (
    <div className="flex flex-col">
      {/* head: recipe + traversal path + io key + rollup chips */}
      <div className="flex items-center gap-2 flex-wrap px-3 py-2 mb-3 border border-[var(--gs-border)] bg-[var(--gs-bg-elevated)] text-[11px] tracking-[0.03em] text-[var(--gs-text-muted)]">
        <StatusDot status="running" />
        <span className="text-[var(--gs-text)] font-medium">{data.recipe}</span>
        {data.recipePath && <span className={`text-[10.5px] text-[var(--gs-text-dim)]`}>traversal of <span className={`text-[var(--gs-accent)] ${MONO}`}>{data.recipePath}</span></span>}
        <span className="grow" />
        <span className="inline-flex gap-1.5 mr-2">
          <RefChip r={{ name: 'artifact', io: 'artifact' }} />
          <RefChip r={{ name: 'source', io: 'source' }} />
        </span>
        {data.rollup?.map((r, i) => (
          <span key={i} className="inline-flex items-center gap-[5px] whitespace-nowrap border border-[var(--gs-border)] px-[7px] py-[2px] text-[10.5px] uppercase tracking-[0.05em] leading-[1.4] bg-[var(--gs-chip-dim-bg)] text-[var(--gs-chip-dim-text)]">{r}</span>
        ))}
      </div>
      {data.phases.map((p, pi) => (
        <Fragment key={pi}>
          <PhaseSection p={p} index={pi} />
          {pi < data.phases.length - 1 && (
            <div className={`flex items-center gap-2 px-3 py-2 text-[10.5px] text-[var(--gs-text-dim)] ${MONO}`}>
              <span className="text-[var(--gs-accent)]">▼</span>
              dataflow · {p.outputs.filter((o) => o.required).map((o) => o.name).join(', ')}
            </div>
          )}
        </Fragment>
      ))}
    </div>
  );
}

defineRenderer<WorkflowSpecData>('workflow', Workflow);
