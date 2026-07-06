/** @jsxImportSource react */
import { Fragment, type ReactElement } from 'react';
import type { WfGateType, WfNode, WfPhase, WfRef, WorkflowSpecData } from '../types/content.js';
import { defineRenderer } from './registry.web.js';
import { useBlockHost } from './host.web.js';

// Workflow block: a recipe traversal rendered as phase sections with
// source/artifact-typed dataflow (◇ artifact vs ▤ source), gate banners toned
// by gate type, gated-loop lines, per-phase created artifacts, node rows
// (✦ agent / ◆ gate), and required outputs. Mirrors the agent-surfaces mock.

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
};
function StatusDot({ status }: { status?: WfNode['status'] }): ReactElement {
  return <span className={`w-[7px] h-[7px] rounded-full flex-none ${DOT[status ?? 'pending']}`} />;
}

const GATE_TONE: Record<WfGateType, string> = {
  human: 'text-[var(--gs-warning)] border-[var(--gs-warning)]',
  orchestration: 'text-[var(--gs-purple)] border-[var(--gs-purple)]',
  command: 'text-[var(--gs-info)] border-[var(--gs-info)]',
};

function NodeCard({ n }: { n: WfNode }): ReactElement {
  const gate = n.kind === 'gate';
  return (
    <div
      className={`border min-w-[152px] max-w-[210px] ${
        gate
          ? 'border-dashed border-[var(--gs-border-active)] bg-[#0a0a0a] self-center min-w-[118px] max-w-[140px]'
          : `${n.kind === 'tool' ? 'border-dashed' : ''} ${n.status === 'running' ? 'border-[rgba(0,255,102,0.4)]' : 'border-[var(--gs-border)]'} bg-[var(--gs-bg-elevated)]`
      }`}
    >
      <div className={`flex items-center gap-1.5 px-2 py-1.5 text-[11px] ${gate ? '' : 'border-b border-[var(--gs-border)]'}`}>
        <StatusDot status={n.status} />
        <span className="text-[var(--gs-text)] font-medium">
          <span className={`mr-1 ${gate ? 'text-[var(--gs-text-dim)]' : 'text-[var(--gs-accent)]'}`}>{gate ? '◆' : '✦'}</span>
          {gate ? `gate · ${n.gateType ?? 'human'}` : n.role}
        </span>
        {n.model && <span className={`ml-auto text-[10px] text-[var(--gs-text-dim)] ${MONO}`}>{n.model}</span>}
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

function PhaseSection({ p, index }: { p: WfPhase; index: number }): ReactElement {
  const host = useBlockHost();
  return (
    <div className="border border-[var(--gs-border)]">
      {/* header: phase n · name · gate banner toned by gate type */}
      <div className="flex items-center gap-2 px-3 py-2 bg-[var(--gs-bg-elevated)] border-b border-[var(--gs-border)]">
        <span className="text-[10.5px] uppercase tracking-[0.1em] text-[var(--gs-text-dim)]">phase {index + 1}</span>
        <span className="text-[12.5px] font-medium text-[var(--gs-text)]">{p.name}</span>
        {p.gate && <span className={`ml-auto whitespace-nowrap text-[10.5px] px-1.5 py-px border ${GATE_TONE[p.gate.type]}`}>◆ gate · {p.gate.label}</span>}
      </div>
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
            <NodeCard n={n} />
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
      {/* created artifacts */}
      {p.created && p.created.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap px-3 py-2 border-t border-[var(--gs-border-muted)] bg-[rgba(188,140,255,0.03)]">
          <span className="flex-none text-[10px] uppercase tracking-[0.08em] text-[var(--gs-purple)]">artifacts</span>
          {p.created.map((a, i) => (
            <button
              key={i}
              type="button"
              onClick={() => host.dispatch({ kind: 'open', target: `artifact:${a.name}` })}
              className="inline-flex items-center gap-2 border border-[var(--gs-border)] border-l-2 border-l-[var(--gs-purple)] hover:border-[var(--gs-purple)] bg-[#0a0a0a] px-2 py-0.5 text-[11px] cursor-pointer"
            >
              <span className="text-[10.5px] uppercase tracking-[0.04em] text-[var(--gs-purple)]">{a.type}</span>
              <span className="text-[var(--gs-text)]">{a.name}</span>
              {a.from && <span className={`${MONO} text-[10.5px] text-[var(--gs-text-dim)]`}>{a.from}</span>}
              {a.passedTo && <span className="text-[10px] text-[var(--gs-info)]">→ {a.passedTo}</span>}
            </button>
          ))}
        </div>
      )}
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
            {a.status === 'created' && <span className="text-[10px] text-[var(--gs-success)]">✓</span>}
          </span>
        ))}
      </div>
    </div>
  );
}

defineRenderer<WorkflowSpecData>('workflow', ({ data }): ReactElement => (
  <div className="my-2 flex flex-col">
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
        <span key={i} className="border border-[var(--gs-border)] px-1.5 py-0.5 text-[10px] text-[var(--gs-text-dim)]">{r}</span>
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
));
