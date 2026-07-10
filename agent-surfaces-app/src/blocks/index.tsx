import { Fragment, useEffect, useRef, useState, type FC, type ReactNode } from 'react';
import mermaid from 'mermaid';
import { AgentationFrame, MOCKUP_APPS } from './mockups';
import { usePaneActions } from './pane-actions';
import { defineBlock } from './registry';
import { Md } from '../Md';
import type {
  AgentNodeData, AnnotatedCodeData, AntiShortcutData, ArtifactRef, BoundariesData, CalloutData, ChecklistData,
  CodeData, CodeRefData, DataStructureData, DiffData, EvidenceData, EvidenceShapeData, FileTreeData, GuideData,
  IntentData, MarkdownData, MermaidData, MockupData, PlanData, RunGraphData, Tone, VerdictData,
  WfArtifactType, WfCreatedArtifact, WfNode, WfRef, WorkflowSpecData,
} from './types';

export { BlockView, BlockList, listBlockTypes } from './registry';

mermaid.initialize({
  startOnLoad: false, securityLevel: 'loose', theme: 'base', flowchart: { curve: 'basis' },
  themeVariables: { darkMode: true, background: '#000', mainBkg: '#0a0a0a', primaryColor: '#0a0a0a', primaryBorderColor: '#444', primaryTextColor: '#d4d4d4', lineColor: '#5a5a5a', secondaryColor: '#080808', tertiaryColor: '#080808', fontFamily: "'Geist Mono', monospace", fontSize: '12px' },
});

// ── inline markdown (bold + code) ──
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith('**')) out.push(<strong key={i++} style={{ color: 'var(--gs-text)' }}>{tok.slice(2, -2)}</strong>);
    else out.push(<code key={i++} style={{ background: '#000', padding: '1px 5px', border: '1px solid var(--gs-border)' }}>{tok.slice(1, -1)}</code>);
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const Markdown: FC<{ data: MarkdownData }> = ({ data }) => <Md className="md-doc">{data.text}</Md>;

const Callout: FC<{ data: CalloutData }> = ({ data }) => (
  <div className={`callout ${data.tone}`}>
    {data.title && <div className="ct">{data.title}</div>}
    <div>{inline(data.text)}</div>
  </div>
);

const Code: FC<{ data: CodeData }> = ({ data }) => {
  const start = data.startLine ?? 1;
  return (
    <div className="codeblock"><pre>{data.text.split('\n').map((l, i) => (
      <div key={i}><span className="ln">{start + i}</span>{l || ' '}</div>
    ))}</pre></div>
  );
};

const Diff: FC<{ data: DiffData }> = ({ data }) => (
  <div className="block">
    <div className="block-head"><span className="t">diff</span><span className="mono" style={{ fontSize: 11, color: 'var(--gs-text)' }}>{data.file}</span></div>
    <div className="diff">{data.lines.map((l, i) => {
      const sign = l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' ';
      return <div key={i} className={`dl ${l.kind}`}><span className="ln">{l.ln ?? ''}</span>{l.kind === 'hunk' ? l.text : sign + ' ' + l.text}</div>;
    })}</div>
  </div>
);

const FileTree: FC<{ data: FileTreeData }> = ({ data }) => (
  <div className="ftree">{data.nodes.map((n) => (
    <div key={n.path} className={`fnode ${n.kind}`} style={{ paddingLeft: 8 + n.depth * 16 }}>
      <span style={{ color: 'var(--gs-text-dim)' }}>{n.kind === 'dir' ? '▾' : '▤'}</span>
      <span>{n.name}</span>
      {n.git && <span className={`gd ${n.git.toLowerCase()}`}>{n.git}</span>}
    </div>
  ))}</div>
);

const Verdict: FC<{ data: VerdictData }> = ({ data }) => (
  <span className={`verdict ${data.verdict}`}>
    <span>{data.verdict === 'pass' ? '✓' : data.verdict === 'fail' ? '✕' : '~'}</span>
    <span>{data.label}</span>
    {data.severity && <span className="sub">sev {data.severity}</span>}
    {data.confidence && <span className="sub">conf {data.confidence}</span>}
  </span>
);

const Checklist: FC<{ data: ChecklistData }> = ({ data }) => (
  <div className="checklist">{data.items.map((it, i) => (
    <div key={i} className={`chk ${it.done ? 'on' : 'off'}`}>
      <span className="chkbox">{it.done ? '✓' : ''}</span>
      <span>{inline(it.text)}</span>
      {it.evidence && <span className="ek">{it.evidence}</span>}
    </div>
  ))}</div>
);

const AnnotatedCode: FC<{ data: AnnotatedCodeData }> = ({ data }) => (
  <div className="acode">
    <div className="src">{data.lines.map((l) => (
      <div key={l.ln} className={`l ${l.hot ? 'hot' : ''}`}><span className="ln">{l.ln}</span>{l.text || ' '}</div>
    ))}</div>
    <div className="notes">{data.notes.map((n, i) => (
      <div key={i} className="note"><div className="anchor">{n.anchor}</div><div className="muted" style={{ marginTop: 2 }}>{inline(n.text)}</div></div>
    ))}</div>
  </div>
);

const STATUS_CHIP: Record<string, string> = { running: 'green', done: 'green', blocked: 'red', queued: 'dim' };
const AgentNode: FC<{ data: AgentNodeData }> = ({ data }) => (
  <div className="anode">
    <div className="ah">
      {data.status === 'running' && <span className="dotpulse" />}
      <span className="role">{data.role}</span>
      <span className={`chip ${STATUS_CHIP[data.status] ?? 'dim'}`}>{data.status}</span>
      <span className="meta">{data.model}{data.tokens != null ? ` · ${data.tokens.toLocaleString()} tok` : ''}{data.cost != null ? ` · $${data.cost.toFixed(3)}` : ''}</span>
    </div>
    <div className="intent">{data.intent}</div>
    {data.tool && <div className="toolrow"><span style={{ color: 'var(--gs-accent)' }}>▸</span> {data.tool}</div>}
  </div>
);

function phaseStatus(nodes: { status: string }[]): string {
  if (nodes.some((n) => n.status === 'running')) return 'running';
  if (nodes.some((n) => n.status === 'blocked')) return 'blocked';
  if (nodes.every((n) => n.status === 'done')) return 'done';
  return 'pending';
}
const RunGraph: FC<{ data: RunGraphData }> = ({ data }) => (
  <div className="wf">
    <div className="wf-head">
      <span className="wdot running" />
      <span className="wf-recipe">{data.recipe}</span>
      {data.recipePath && <span className="wf-path">traversal of <span className="acc">{data.recipePath}</span></span>}
      <span className="grow" />
      {data.rollup?.map((r, i) => <span key={i} className="chip dim">{r}</span>)}
    </div>
    <div className="wf-lanes">{data.phases.map((p, i) => (
      <div key={i} className="wf-lane">
        {p.fan && <div className="wf-fan">{p.fan === 'out' ? '⋁' : '⋀'}</div>}
        <div className="wf-lane-h">
          <span className={`wdot ${phaseStatus(p.nodes)}`} />phase · {p.phase}
          {p.barrier && <span className="wf-barrier">{p.barrier}</span>}
        </div>
        <div className="wf-nodes">{p.nodes.map((n, j) => (
          <div key={j} className={`wf-node ${n.status}`} style={n.dim ? { opacity: 0.55 } : undefined}>
            <div className="wf-node-h">
              <span className={`wdot ${n.status}`} /><span className="role">{n.role}</span>
              {n.target && <span className="wf-target">{n.target}</span>}
            </div>
            {n.meta && <div className="wf-meta">{n.meta.map((m, k) => (
              <span key={k} className={m.tone ?? ''}>{m.label && <b>{m.label} </b>}{m.value}</span>
            ))}</div>}
            {n.tags && <div className="wf-tags">{n.tags.map((t, k) => <span key={k} className={`wf-tag ${t.kind ?? ''}`}>{t.label}</span>)}</div>}
          </div>
        ))}</div>
      </div>
    ))}</div>
    <div className="wf-legend">The graph is the durable artifact — this run is a traversal, saved to <span className="acc">.gitspace/workflows/runs/</span> as a receipt; usage rolls up to per-recipe reliability + cost.</div>
  </div>
);

const SIGNAL_CLASS: Record<string, string> = { core: '', supporting: 'sup', noise: 'noise' };
const SIGNAL_LABEL: Record<string, string> = { core: 'core', supporting: 'supporting', noise: 'low signal' };
const Guide: FC<{ data: GuideData }> = ({ data }) => (
  <div className="guide">{data.sections.map((s, i) => (
    <div key={i} className="guide-sec">
      <div className="gsh">
        <span className={`gnum ${SIGNAL_CLASS[s.signal]}`}>{i + 1}</span>
        <span className="gt">{s.title}</span>
        <span className="gfiles">{s.anchors.length} {s.anchors.length === 1 ? 'file' : 'files'} · {SIGNAL_LABEL[s.signal]}</span>
      </div>
      <div className="gwhy">{inline(s.rationale)}{s.anchors[0] && <span className="jump"> → jump to {s.anchors[0]}</span>}</div>
    </div>
  ))}</div>
);

// ── ArtifactRef resolver: the local-now / remote-later seam ──
function ResolvedArtifact({ ref }: { ref: ArtifactRef }): ReactNode {
  if (ref.kind === 'inline') return <div className="codeblock"><pre>{ref.text}</pre></div>;
  if (ref.kind === 'image') return (
    <div>
      <img src={ref.dataUrl} alt="" style={{ maxWidth: '100%', display: 'block', boxShadow: 'var(--img-outline)' }} />
      <div className="dim mono" style={{ fontSize: 10, marginTop: 5 }}>{ref.width}×{ref.height}{ref.bytes ? ` · ${(ref.bytes / 1024).toFixed(1)} KB` : ''}</div>
    </div>
  );
  if (ref.kind === 'path') return <div className="mono" style={{ fontSize: 11 }}><span className="dim">file</span> {ref.path}</div>;
  return <a className="mono" href={ref.url} style={{ fontSize: 11, color: 'var(--gs-info)' }}>{ref.url}</a>;
}

const SOURCE_TONE: Record<string, string> = { captured: 'green', asserted: 'amber' };
const Evidence: FC<{ data: EvidenceData }> = ({ data }) => (
  <div className="block">
    <div className="block-head">
      <span className="mono" style={{ fontSize: 11, color: 'var(--gs-text)' }}>{data.name}</span>
      {data.meta && <span className="muted" style={{ fontSize: 11 }}>— {data.meta}</span>}
      <span className={`chip ${SOURCE_TONE[data.source]}`} style={{ marginLeft: 'auto' }}>{data.source === 'captured' ? 'captured · run' : 'asserted · manual'}</span>
    </div>
    <div className="block-body">{ResolvedArtifact({ ref: data.ref })}</div>
  </div>
);

const DataStructure: FC<{ data: DataStructureData }> = ({ data }) => (
  <div className="dstruct">
    <div className="dstruct-h"><span className="dstruct-kw">{data.lang === 'rust' ? 'struct' : data.lang === 'go' ? 'type' : 'interface'}</span> <span className="dstruct-name">{data.name}</span></div>
    <table className="dstruct-t"><tbody>{data.fields.map((f, i) => (
      <tr key={i}><td className="df-name">{f.name}</td><td className="df-type">{f.type}</td><td className="df-note">{f.note}</td></tr>
    ))}</tbody></table>
    {data.note && <div className="dstruct-note">{data.note}</div>}
  </div>
);

let mseq = 0;
const Mermaid: FC<{ data: MermaidData }> = ({ data }) => {
  const [svg, setSvg] = useState('');
  const idRef = useRef('mm-' + (mseq++));
  useEffect(() => {
    let alive = true;
    mermaid.render(idRef.current, data.code).then((r) => { if (alive) setSvg(r.svg); }).catch(() => { if (alive) setSvg(''); });
    return () => { alive = false; };
  }, [data.code]);
  return (
    <div className="mermaid-block">
      {data.title && <div className="block-cap">{data.title}</div>}
      <div className="mermaid-svg" dangerouslySetInnerHTML={{ __html: svg }} />
    </div>
  );
};

const CodeRef: FC<{ data: CodeRefData }> = ({ data }) => {
  const start = data.startLine ?? 1;
  return (
    <div className={`coderef ${data.exemplar ? 'exemplar' : ''}`}>
      <div className="coderef-h">
        <span className="coderef-ic">↳</span>
        <span className="coderef-path">{data.path}{data.lines ? `:${data.lines}` : ''}</span>
        <span className="coderef-tag">{data.exemplar ? 'follow this pattern' : 'existing code'}</span>
        <span className="coderef-open">open ↗</span>
      </div>
      <div className="code">{data.snippet.split('\n').map((t, i) => (
        <div key={i} className="codeln"><span className="g">{start + i}</span><span className="s">{t || ' '}</span></div>
      ))}</div>
      {data.note && <div className="coderef-note">{data.note}</div>}
    </div>
  );
};

const Plan: FC<{ data: PlanData }> = ({ data }) => (
  <div className="implplan">{data.steps.map((s, i) => (
    <div key={i} className="plan-step">
      <span className="plan-n">{i + 1}</span>
      <div className="plan-body">
        <div className="plan-t">{s.title}</div>
        <div className="plan-d">{inline(s.detail)}</div>
        {s.refs && <div className="plan-refs">{s.refs.map((r, j) => <span key={j} className="plan-ref">↳ {r}</span>)}</div>}
      </div>
    </div>
  ))}</div>
);

const Intent: FC<{ data: IntentData }> = ({ data }) => (
  <div className="intent-block">
    <div className="intent-label">user intent · north star</div>
    <blockquote className="intent-quote">{data.quote}</blockquote>
    {data.source && <div className="intent-src">— {data.source}</div>}
    {data.why && <div className="intent-why">{inline(data.why)}</div>}
  </div>
);

const Boundaries: FC<{ data: BoundariesData }> = ({ data }) => (
  <div className="bounds">
    <div className="bounds-h">protected boundaries — do not change without explicit approval</div>
    {data.items.map((it, i) => (
      <div key={i} className="bound-row"><span className="bound-tag">locked</span><span className="bound-surface">{it.surface}</span><span className="bound-rule">{inline(it.rule)}</span></div>
    ))}
  </div>
);

const AntiShortcut: FC<{ data: AntiShortcutData }> = ({ data }) => (
  <div className="antishort">
    <div className="antishort-h">preventing shortcuts — proof that looks complete but isn't</div>
    {data.items.map((it, i) => (
      <div key={i} className="as-row"><div className="as-cut"><span className="as-x">✕</span>{it.shortcut}</div><div className="as-why">{inline(it.why)}</div></div>
    ))}
  </div>
);

const EV_KIND: Record<string, string> = { command: 'green', screenshot: 'blue', video: 'violet', note: 'dim', test: 'green' };
const EvidenceShape: FC<{ data: EvidenceShapeData }> = ({ data }) => (
  <div className="evshape">
    <div className="evshape-h">shape of the final evidence — what proof we want at the end</div>
    <table className="evshape-t"><tbody>{data.items.map((it, i) => (
      <tr key={i}><td className="es-req">{it.requirement}</td><td><span className={`chip ${EV_KIND[it.kind] ?? 'dim'}`}>{it.kind}</span></td><td className="es-cap">{it.captured}</td></tr>
    ))}</tbody></table>
  </div>
);

const Mockup: FC<{ data: MockupData }> = ({ data }) => {
  const App = MOCKUP_APPS[data.app] ?? (() => <div className="dim">unknown mockup app</div>);
  return <AgentationFrame title={data.title} artifact={data.artifact}><App /></AgentationFrame>;
};

defineBlock<MarkdownData>('markdown', Markdown);
defineBlock<CalloutData>('callout', Callout);
defineBlock<CodeData>('code', Code);
defineBlock<DiffData>('diff', Diff);
defineBlock<FileTreeData>('file-tree', FileTree);
defineBlock<VerdictData>('verdict-chip', Verdict);
defineBlock<ChecklistData>('checklist', Checklist);
defineBlock<AnnotatedCodeData>('annotated-code', AnnotatedCode);
defineBlock<AgentNodeData>('agent-node', AgentNode);
defineBlock<RunGraphData>('run-graph', RunGraph);
defineBlock<GuideData>('guide', Guide);
defineBlock<EvidenceData>('evidence', Evidence);
defineBlock<DataStructureData>('data-structure', DataStructure);
defineBlock<MermaidData>('mermaid', Mermaid);
defineBlock<CodeRefData>('code-ref', CodeRef);
defineBlock<PlanData>('plan', Plan);
defineBlock<IntentData>('intent', Intent);
defineBlock<BoundariesData>('boundaries', Boundaries);
defineBlock<AntiShortcutData>('anti-shortcut', AntiShortcut);
defineBlock<EvidenceShapeData>('evidence-shape', EvidenceShape);
defineBlock<MockupData>('mockup', Mockup);

function RefChip({ r }: { r: WfRef }) {
  return <span className={`wfx-ref ${r.io}`}><span className="wfx-ref-ic">{r.io === 'artifact' ? '◇' : '▤'}</span>{r.name}</span>;
}

// Model-role ids → user vocabulary. The workflow surface speaks roles
// natively — raw model names never render; legacy `model` aliases translate.
const WF_MODEL_ROLE_LABELS: Record<string, string> = { task: 'Current model', slow: 'Thinking', smol: 'Fast', plan: 'Architect' };
const WF_MODEL_ALIAS_TO_ROLE: Record<string, string> = { opus: 'slow', sonnet: 'task', haiku: 'smol', inherit: 'task' };
function wfModelRoleLabel(n: WfNode): string | undefined {
  const role = n.modelRole ?? (n.model ? WF_MODEL_ALIAS_TO_ROLE[n.model.toLowerCase()] : undefined);
  if (!role) return undefined;
  const id = role.toLowerCase().replace(/^pi\//, '');
  return WF_MODEL_ROLE_LABELS[id] ?? id;
}

function WfNodeCard({ n }: { n: WfNode }) {
  const modelRole = wfModelRoleLabel(n);
  return (
    <div className={`wfx-node ${n.kind} ${n.status ?? ''}`}>
      <div className="wfx-node-h">
        <span className={`wdot ${n.status ?? 'pending'}`} />
        <span className="wfx-role">{n.kind === 'gate' ? `gate · ${n.gateType}` : n.role}</span>
        {modelRole && <span className="wfx-model">{modelRole}</span>}
      </div>
      {n.fanout && (
        <div className="wfx-fan">
          <div className="wfx-fan-h"><span className="wfx-fan-ic">⋔</span>for each {n.fanout.over}</div>
          <div className="wfx-fan-insts">{n.fanout.instances.map((x, i) => <span key={i} className="wfx-fan-inst">{x}</span>)}</div>
        </div>
      )}
      {n.reads && <div className="wfx-acc"><span className="wfx-acc-l reads">reads</span>{n.reads.map((r, i) => <RefChip key={i} r={r} />)}</div>}
      {n.writes && <div className="wfx-acc"><span className="wfx-acc-l writes">writes</span>{n.writes.map((r, i) => <RefChip key={i} r={r} />)}</div>}
    </div>
  );
}

const WF_ART_TYPES: { type: WfArtifactType; label: string }[] = [
  { type: 'goal-slice', label: 'goal-doc line-range' },
  { type: 'phased-goal', label: 'phased goal-doc' },
  { type: 'rubric', label: 'reviewer rubric' },
  { type: 'arbitrary', label: 'arbitrary artifact' },
];

const Workflow: FC<{ data: WorkflowSpecData }> = ({ data }) => {
  const [created, setCreated] = useState<WfCreatedArtifact[][]>(() => data.phases.map((p) => p.created ?? []));
  const [menu, setMenu] = useState<number | null>(null);
  const { open } = usePaneActions();
  const add = (pi: number, type: WfArtifactType) => {
    setCreated((c) => c.map((arr, i) => (i === pi ? [...arr, { name: `new ${type}`, type, passedTo: '(assign agent)' }] : arr)));
    setMenu(null);
  };
  return (
    <div className="wfx">
      <div className="wf-head">
        <span className="wdot running" />
        <span className="wf-recipe">{data.recipe}</span>
        {data.recipePath && <span className="wf-path">traversal of <span className="acc">{data.recipePath}</span></span>}
        <span className="grow" />
        <span className="wfx-key"><span className="wfx-ref artifact"><span className="wfx-ref-ic">◇</span>artifact</span><span className="wfx-ref source"><span className="wfx-ref-ic">▤</span>source</span></span>
        {data.rollup?.map((r, i) => <span key={i} className="chip dim">{r}</span>)}
      </div>
      {data.phases.map((p, pi) => (
        <Fragment key={pi}>
          <div className="wfx-phase">
            <div className="wfx-ph-h">
              <span className="wfx-ph-n">phase {pi + 1}</span><span className="wfx-ph-t">{p.name}</span>
              {p.gate && <span className={`wfx-gate-chip ${p.gate.type}`}>◆ gate · {p.gate.label}</span>}
            </div>
            <div className="wfx-io in"><span className="wfx-io-l">in</span>{p.inputs.map((r, i) => <RefChip key={i} r={r} />)}</div>
            <div className="wfx-flow">
              {p.nodes.map((n, ni) => (
                <Fragment key={n.id}>
                  {ni > 0 && <div className="wfx-conn"><span className="wfx-conn-l">{p.nodes[ni - 1].out}</span><span className="wfx-arrow">▶</span></div>}
                  <WfNodeCard n={n} />
                </Fragment>
              ))}
            </div>
            {p.loop && <div className="wfx-loop"><span className="wfx-loop-ic">↺</span> gated loop — {p.loop}{p.gate && <span className="wfx-loop-gate">exit owned by <b>{p.gate.label}</b></span>}</div>}
            <div className="wfx-arts">
              <span className="wfx-arts-l">artifacts</span>
              {created[pi].map((a, i) => {
                const target = a.type === 'rubric' ? 'rubric' : a.type === 'goal-slice' || a.type === 'phased-goal' ? 'goal' : `artifact:${a.name}`;
                return (
                  <button key={i} className="wfx-cart" onClick={() => open(target)}>
                    <span className="wfx-cart-type">{a.type}</span>
                    <span className="wfx-cart-name">{a.name}</span>
                    {a.from && <span className="wfx-cart-from">{a.from}</span>}
                    {a.passedTo && <span className="wfx-cart-to">→ {a.passedTo}</span>}
                  </button>
                );
              })}
              <span className="wfx-add-wrap">
                <button className="wfx-add" onClick={() => setMenu(menu === pi ? null : pi)}>+ create artifact</button>
                {menu === pi && <div className="wfx-add-menu">{WF_ART_TYPES.map((t) => <button key={t.type} onClick={() => add(pi, t.type)}>{t.label}</button>)}</div>}
              </span>
            </div>
            <div className="wfx-io out">
              <span className="wfx-io-l">out</span>
              {p.outputs.map((a, i) => <span key={i} className={`wfx-art req ${a.io} ${a.status ?? ''}`}><span className="wfx-ref-ic">{a.io === 'artifact' ? '◇' : '▤'}</span>{a.name}<span className="wfx-art-k">{a.kind}</span></span>)}
            </div>
          </div>
          {pi < data.phases.length - 1 && (
            <div className="wfx-link"><span className="wfx-link-ic">▼</span> dataflow · {p.outputs.filter((o) => o.required).map((o) => o.name).join(', ')}</div>
          )}
        </Fragment>
      ))}
    </div>
  );
};
defineBlock<WorkflowSpecData>('workflow', Workflow);
