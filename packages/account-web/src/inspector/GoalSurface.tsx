import { Background, Controls, MarkerType, Position, ReactFlow, type Edge, type Node } from '@xyflow/react';
import { Button, Card, CardAction, CardContent, CardDescription, CardFooter, CardGroup, CardHeader, CardMedia, CardTitle, ScrollArea, Tooltip, useShape } from '@gitspace/ui';
import type { EvidenceReference, GoalRecordView, InspectorOverview, RubricCriterion, RubricView, WorkflowNode, WorkflowView } from '@gitspace/protocol';
import { File02, GitBranch01, Play, Scales02, Terminal, User01, Users01 } from '@untitledui/icons';
import { useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { glyph } from '../glyph.js';
import { GitSpaceMarkdown } from '../GitSpaceMarkdown.js';
import { EmptyState, StatusDot } from '../GitSpaceShell.js';
import type { InspectorProps } from './Inspector.js';
import { RuntimeAvailability, openWorkspaceFirst, ic, settle, formatDate, Tone, Kicker, Heading, SectionTitle, Padded, MetaCard } from './inspector-shared.js';

// Untitled UI glyphs adapted once, at module scope, to Fluid's IconComponent
// shape so Card/Tabs slots never remount a freshly created component.
const GitBranchGlyph = glyph(GitBranch01);
const PlayGlyph = glyph(Play);
const ScalesGlyph = glyph(Scales02);
function evidenceLabel(reference: EvidenceReference): string {
  return reference.label;
}
function SurfaceHeader({ kicker, title, detail }: { kicker: string; title: string; detail: string }) {
  return <header className="flex flex-col gap-1 px-4 pb-3 pt-4"><Kicker>{kicker}</Kicker><Heading>{title}</Heading><p className="text-body text-muted-foreground">{detail}</p></header>;
}
function EvidenceButton({ reference, onOpen }: { reference: EvidenceReference; onOpen: (reference: EvidenceReference) => void }) {
  const disabled = !useContext(RuntimeAvailability) && reference.kind === 'git';
  const button = <Button variant="tertiary" size="compact" type="button" disabled={disabled} onClick={() => onOpen(reference)}>{ic(File02, 14)}{evidenceLabel(reference)}</Button>;
  return disabled ? <Tooltip content={openWorkspaceFirst}><span>{button}</span></Tooltip> : button;
}
function EvidenceList({ evidence, onOpen, prefix }: { evidence: readonly EvidenceReference[]; onOpen: (reference: EvidenceReference) => void; prefix: string }) {
  if (!evidence.length) return null;
  return <div className="flex flex-wrap gap-1">{evidence.map((reference, index) => <EvidenceButton reference={reference} onOpen={onOpen} key={`${prefix}:${index}`} />)}</div>;
}
function RequirementList({ requirements, onOpenEvidence }: { requirements: GoalRecordView['requirements']; onOpenEvidence: (reference: EvidenceReference) => void }) {
  return <section className="flex flex-col gap-2">
    <SectionTitle>Requirements</SectionTitle>
    <CardGroup border="outlined">{requirements.map((requirement) => <Card key={requirement.id}>
      <CardHeader><CardTitle>{requirement.title}</CardTitle><CardDescription>{requirement.required ? 'Required' : 'Optional'}</CardDescription><CardAction><Tone value={requirement.status} /></CardAction></CardHeader>
      {requirement.description || requirement.evidence.length ? <CardContent className="flex flex-col gap-2">{requirement.description ? <GitSpaceMarkdown>{requirement.description}</GitSpaceMarkdown> : null}<EvidenceList evidence={requirement.evidence} onOpen={onOpenEvidence} prefix={requirement.id} /></CardContent> : null}
    </Card>)}</CardGroup>
  </section>;
}
export function GoalOverview({ overview, openDocuments, onOpenProduct, onOpenEvidence }: { overview: InspectorOverview; openDocuments: number; onOpenProduct: (kind: 'goal' | 'workflow' | 'rubric') => void; onOpenEvidence: (reference: EvidenceReference) => void }) {
  const shape = useShape();
  const goal = overview.goal;
  if (!goal) return <Padded><EmptyState icon={ic(GitBranch01, 22)} title="No goal is attached" description="Create the canonical workspace goal to give requirements, workflow, and review evidence a shared home." /></Padded>;
  const accepted = goal.requirements.filter((item) => item.status === 'accepted').length;
  const review = goal.requirements.filter((item) => item.status === 'review').length;
  const missing = goal.requirements.filter((item) => item.status === 'missing').length;
  const total = Math.max(1, goal.requirements.length);
  const products = 1 + (overview.workflow ? 1 : 0) + (overview.rubric ? 1 : 0);
  return <ScrollArea className="min-h-0 flex-1" viewportClassName="h-full"><div className="flex flex-col gap-4 p-4">
    <header className="flex flex-col gap-1"><Kicker>Workspace goal</Kicker><Heading>{goal.title}</Heading><GitSpaceMarkdown className="text-body text-muted-foreground">{goal.summary}</GitSpaceMarkdown></header>
    <CardGroup columns={2} separated border="outlined">
      <MetaCard label="Phase"><StatusDot color={goal.phase === 'ship' ? 'green' : 'blue'} />{goal.phase}</MetaCard>
      <MetaCard label="Revision">r{goal.revision}</MetaCard>
      <MetaCard label="Open tabs">{openDocuments}</MetaCard>
      <MetaCard label="Review threads">{overview.review.unresolved} unresolved</MetaCard>
    </CardGroup>
    <div className="flex flex-wrap items-center gap-3 text-caption text-muted-foreground">
      <span><b className="font-medium tabular-nums text-foreground">{accepted}</b> accepted</span>
      <span><b className="font-medium tabular-nums text-foreground">{review}</b> in review</span>
      <span><b className="font-medium tabular-nums text-foreground">{missing}</b> missing</span>
      {/* FLUID-GAP: progress meter — the registry has no read-only progress bar; the fill width is the measured ratio. */}
      <span role="progressbar" aria-label="Accepted requirements" aria-valuemin={0} aria-valuemax={total} aria-valuenow={accepted} className={`${shape.bg} h-1 min-w-12 flex-1 overflow-hidden bg-muted`}><span className="block h-full bg-foreground" style={{ width: `${accepted / total * 100}%` }} /></span>
    </div>
    <CardGroup columns={products} separated border="outlined">
      <Card onClick={() => onOpenProduct('goal')} label="Open goal & requirements"><CardHeader><CardMedia icon={GitBranchGlyph} /><CardTitle>Goal & requirements</CardTitle><CardDescription className="tabular-nums">{goal.requirements.length} requirements · revision {goal.revision}</CardDescription></CardHeader></Card>
      {overview.workflow ? <Card onClick={() => onOpenProduct('workflow')} label={`Open ${overview.workflow.title}`}><CardHeader><CardMedia icon={PlayGlyph} /><CardTitle>{overview.workflow.title}</CardTitle><CardDescription className="tabular-nums">{overview.workflow.nodes.length} nodes · {overview.workflow.edges.length} edges</CardDescription></CardHeader></Card> : null}
      {overview.rubric ? <Card onClick={() => onOpenProduct('rubric')} label={`Open ${overview.rubric.title}`}><CardHeader><CardMedia icon={ScalesGlyph} /><CardTitle>{overview.rubric.title}</CardTitle><CardDescription className="tabular-nums">{overview.rubric.criteria.length} criteria</CardDescription></CardHeader></Card> : null}
    </CardGroup>
    <RequirementList requirements={goal.requirements} onOpenEvidence={onOpenEvidence} />
  </div></ScrollArea>;
}

export function ProductGoal({ goal, onOpenEvidence }: { goal: GoalRecordView; onOpenEvidence: (reference: EvidenceReference) => void }) {
  return <ScrollArea className="min-h-0 flex-1" viewportClassName="h-full"><div className="flex flex-col gap-4 p-4">
    <header className="flex flex-col gap-1"><Kicker>Goal · revision {goal.revision}</Kicker><Heading>{goal.title}</Heading><GitSpaceMarkdown className="text-body text-muted-foreground">{goal.summary}</GitSpaceMarkdown></header>
    <RequirementList requirements={goal.requirements} onOpenEvidence={onOpenEvidence} />
  </div></ScrollArea>;
}

function workflowNodeLabel(node: WorkflowNode): ReactNode {
  const head = node.kind === 'gate' ? `Human gate · ${node.satisfied ? 'satisfied' : node.passable ? 'passable' : 'blocked'}` : `${node.kind} · ${node.status}`;
  return <div className="flex min-w-40 flex-col gap-1 p-1.5 text-left">
    <span className="text-caption text-muted-foreground">{head}</span>
    <strong className="text-body font-medium text-foreground">{node.label}</strong>
    {node.kind === 'phase' ? <><span className="text-caption text-muted-foreground">{node.role ?? 'No role assigned'}</span>{node.reads.length ? <code className="truncate font-mono text-caption text-muted-foreground">Reads: {node.reads.join(', ')}</code> : null}{node.writes.length ? <code className="truncate font-mono text-caption text-muted-foreground">Writes: {node.writes.join(', ')}</code> : null}</>
      : node.kind === 'artifact' ? (node.evidence ? <span className="text-caption text-muted-foreground">{evidenceLabel(node.evidence)}</span> : null)
        : <span className="text-caption text-muted-foreground tabular-nums">{node.requirementIds.length} requirements · {node.waivers.length} waivers</span>}
  </div>;
}
export function WorkflowDocument({ workflow }: { workflow: WorkflowView }) {
  const [selectedId, setSelectedId] = useState<string | null>(workflow.nodes[0]?.id ?? null);
  useEffect(() => setSelectedId((current) => workflow.nodes.some((node) => node.id === current) ? current : workflow.nodes[0]?.id ?? null), [workflow]);
  const nodes = useMemo<Node[]>(() => workflow.nodes.map((node) => ({ id: node.id, position: node.position, sourcePosition: Position.Right, targetPosition: Position.Left, data: { label: workflowNodeLabel(node) }, style: { width: 190 } })), [workflow.nodes]);
  const edges = useMemo<Edge[]>(() => workflow.edges.map((edge) => ({ id: edge.id, source: edge.from, target: edge.to, label: edge.label ?? undefined, type: edge.kind === 'control' ? 'smoothstep' : 'default', markerEnd: { type: MarkerType.ArrowClosed } })), [workflow.edges]);
  const selected = workflow.nodes.find((node) => node.id === selectedId) ?? null;
  return <div className="flex min-h-0 flex-1 flex-col">
    <SurfaceHeader kicker={`Workflow · revision ${workflow.revision}`} title={workflow.title} detail={workflow.description} />
    {/* FLUID-GAP: node graph canvas — @xyflow/react renders the workflow; its node chrome is the library's own. */}
    <div className="min-h-80 flex-1 bg-surface-1"><ReactFlow nodes={nodes} edges={edges} fitView minZoom={0.4} maxZoom={1.5} nodesDraggable={false} nodesConnectable={false} elementsSelectable onNodeClick={(_, node) => setSelectedId(node.id)}><Background gap={20} size={1} color="var(--border)" /><Controls showInteractive={false} /></ReactFlow></div>
    {selected ? <section className="max-h-44 overflow-auto border-t border-border px-4 py-3"><strong className="text-body font-medium text-foreground">{selected.label}</strong><p className="text-caption text-muted-foreground">{selected.kind === 'gate' ? `${selected.requirementIds.length} requirements. ${selected.waivers.length} authorized waiver records.` : selected.kind === 'phase' ? `${selected.reads.length} inputs and ${selected.writes.length} outputs.` : selected.evidence ? evidenceLabel(selected.evidence) : 'Evidence is not available yet.'}</p></section> : null}
  </div>;
}

function JudgeIcon({ kind }: { kind: RubricCriterion['judge']['kind'] }) { return kind === 'human' ? ic(User01) : kind === 'llm' ? ic(Users01) : ic(Terminal); }
export function RubricDocument({ rubric, onOpenEvidence, onSubmit }: { rubric: RubricView; onOpenEvidence: (reference: EvidenceReference) => void; onSubmit?: InspectorProps['onSubmitHumanJudgment'] }) {
  const shape = useShape();
  const [selectedId, setSelectedId] = useState<string | null>(rubric.criteria[0]?.id ?? null);
  const [summary, setSummary] = useState('');
  const selected = rubric.criteria.find((criterion) => criterion.id === selectedId) ?? rubric.criteria[0] ?? null;
  if (!selected) return <Padded><EmptyState icon={ic(Scales02, 22)} title="No rubric criteria" description="Add criteria to the canonical rubric before review begins." /></Padded>;
  return <ScrollArea className="min-h-0 flex-1" viewportClassName="h-full"><div className="flex flex-col gap-4 p-4">
    <nav aria-label="Rubric criteria"><CardGroup orientation="inline" border="outlined">{rubric.criteria.map((criterion) => <Card size="compact" selected={criterion.id === selected.id} onClick={() => setSelectedId(criterion.id)} label={criterion.title} key={criterion.id}><CardHeader><CardTitle>{criterion.title}</CardTitle><CardDescription className="tabular-nums">{criterion.judge.kind} · {criterion.judgments.length} judgments</CardDescription></CardHeader><CardFooter><Tone value={criterion.status} /></CardFooter></Card>)}</CardGroup></nav>
    <section className="flex flex-col gap-3">
      <header className="flex flex-col gap-1"><span><Tone value={selected.status} /></span><Heading>{selected.title}</Heading><p className="text-body text-muted-foreground">{selected.description}</p></header>
      <div className={`${shape.container} flex items-center gap-3 bg-surface-3 p-3 shadow-surface-1`}>
        <span className={`${shape.bg} grid size-8 shrink-0 place-items-center bg-hover text-muted-foreground`}><JudgeIcon kind={selected.judge.kind} /></span>
        <span className="flex min-w-0 flex-1 flex-col"><strong className="text-body font-medium text-foreground">{selected.judge.kind === 'human' ? 'Human judgment' : selected.judge.kind === 'llm' ? `LLM judgment${selected.judge.model ? ` · ${selected.judge.model}` : ''}` : 'Command judgment'}</strong><span className="truncate text-caption text-muted-foreground">{selected.judge.kind === 'command' ? selected.judge.command : `${selected.requirementIds.length} linked requirements`}</span></span>
        <Tone value={selected.status} />
      </div>
      <section className="flex flex-col gap-2"><SectionTitle>Evidence</SectionTitle>{selected.evidence.length ? <EvidenceList evidence={selected.evidence} onOpen={onOpenEvidence} prefix={`${selected.id}:e`} /> : <p className="text-caption text-muted-foreground">No evidence attached.</p>}</section>
      {selected.judge.kind === 'human' && onSubmit ? <section className="flex flex-col gap-2">
        {/* FLUID-GAP: multi-line textarea — the registry has no textarea field. */}
        <textarea aria-label="Human judgment summary" placeholder="Explain the review decision" value={summary} onChange={(event) => setSummary(event.currentTarget.value)} className={`${shape.input} min-h-20 w-full resize-y border border-border bg-surface-2 p-2 text-body text-foreground`} />
        <footer className="flex justify-end gap-2"><Button variant="secondary" size="compact" type="button" disabled={!summary.trim()} onClick={() => { settle(onSubmit(selected.id, 'fail', summary.trim())); setSummary(''); }}>Needs changes</Button><Button variant="primary" size="compact" type="button" disabled={!summary.trim()} onClick={() => { settle(onSubmit(selected.id, 'pass', summary.trim())); setSummary(''); }}>Pass</Button></footer>
      </section> : null}
      {selected.judgments.length ? <CardGroup border="outlined">{selected.judgments.map((judgment) => <Card key={judgment.id}>
        <CardHeader><CardTitle>{judgment.actorKind === 'client' ? `Client-submitted ${judgment.kind} judgment` : judgment.kind}</CardTitle><CardDescription className="tabular-nums">{formatDate(judgment.createdAt)}</CardDescription><CardAction><Tone value={judgment.verdict} /></CardAction></CardHeader>
        <CardContent className="flex flex-col gap-2"><p className="text-body text-muted-foreground">{judgment.summary}</p><EvidenceList evidence={judgment.evidence} onOpen={onOpenEvidence} prefix={judgment.id} /></CardContent>
      </Card>)}</CardGroup> : null}
    </section>
  </div></ScrollArea>;
}
