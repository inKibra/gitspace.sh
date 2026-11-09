// The Goal tab, in the order it explains the work: where the workspace is (phase, pull request, what needs you); the
// goal (the problem, why it matters, what done means); the plan; the requirements and their evidence; the decisions;
// and how the workspace runs (its automations by phase). The workflow and rubric records open from the last part.
import { Background, Controls, MarkerType, Position, ReactFlow, type Edge, type Node } from '@xyflow/react';
import { Badge, Button, Card, CardAction, CardContent, CardDescription, CardFooter, CardGroup, CardHeader, CardTitle, ScrollArea, useShape } from '@gitspace/ui';
import type { EvidenceReference, InspectorOverview, JournalEntryView, ReviewThreadView, RubricCriterion, RubricView, WorkflowNode, WorkflowView } from '@gitspace/protocol';
import type { SessionControlView } from '@gitspace/protocol-runtime/session-controls';
import { ArrowUpRight, Play, Scales02, Terminal, User01, Users01 } from '@untitledui/icons';
import { useContext, useEffect, useMemo, useState, type ReactElement, type ReactNode } from 'react';
import { AutomationPhaseGrid } from '../automations/AutomationPhaseGrid.js';
import { MODE_LABEL } from '../automations/automation-formatters.js';
import { BlockActionsProvider } from '../blocks/BlockActions.js';
import { useComposerStaging, workspaceBlockActions } from '../chat/staging.js';
import { GitSpaceMarkdown } from '../GitSpaceMarkdown.js';
import { EmptyState, type AgentScopeView } from '../GitSpaceShell.js';
import { DecisionsSection } from '../goal/DecisionsSection.js';
import { EvidenceList } from '../goal/Evidence.js';
import { PlanSection } from '../goal/PlanSection.js';
import { RequirementsSection } from '../goal/RequirementsSection.js';
import type { StepCommentHandlers } from '../goal/StepComments.js';
import type { GoalAutomations } from '../goal/useWorkspaceAutomations.js';
import { automationsUrl, navigateProductUrl } from '../routes.js';
import { PrChips } from '../sidebar/parts.js';
import { ProjectGraphsContext } from '../sidebar/project-graph.js';
import type { InspectorProps } from './Inspector.js';
import { ic, settle, formatDate, Tone, Kicker, Heading, SectionTitle, Padded } from './inspector-shared.js';

function evidenceLabel(reference: EvidenceReference): string {
  return reference.label;
}
function SurfaceHeader({ kicker, title, detail }: { kicker: string; title: string; detail: string }) {
  return <header className="flex flex-col gap-1 px-4 pb-3 pt-4"><Kicker>{kicker}</Kicker><Heading>{title}</Heading><p className="text-body text-muted-foreground">{detail}</p></header>;
}

/** A numbered part of the Goal. */
function Part({ number, title, detail, children }: { number: number; title: string; detail?: ReactNode; children: ReactNode }): ReactElement {
  return <section className="flex flex-col gap-3" aria-label={title}>
    <header className="flex items-baseline gap-2.5 border-t border-border pt-5">
      <span className="text-caption font-semibold tabular-nums text-muted-foreground">{number}</span>
      <span className="flex min-w-0 flex-col gap-0.5"><h3 className="text-title font-semibold text-foreground">{title}</h3>{detail ? <span className="text-caption text-muted-foreground">{detail}</span> : null}</span>
    </header>
    {children}
  </section>;
}

function Term({ label, children }: { label: string; children: ReactNode }): ReactElement {
  return <div className="flex flex-col gap-0.5"><dt className="text-caption font-semibold uppercase tracking-wide text-muted-foreground">{label}</dt><dd className="text-body text-foreground">{children}</dd></div>;
}

export interface GoalSurfaceProps {
  overview: InspectorOverview;
  scope?: AgentScopeView;
  /** The conversation's session controls: its plan and todo list. */
  controls?: SessionControlView;
  journalEntries: readonly JournalEntryView[];
  threads: readonly ReviewThreadView[];
  /** This browser's device id, which records name as their author. */
  viewerId: string;
  automations?: GoalAutomations;
  comments: StepCommentHandlers;
  onSetAcceptance?(requirementId: string, accepted: boolean): Promise<void>;
  onOpenEvidence(reference: EvidenceReference): void;
  onOpenGuideSection(sectionId: string): void;
  onOpenJournal(): void;
  onOpenProduct(kind: 'workflow' | 'rubric'): void;
}

export function GoalSurface({ overview, scope, controls, journalEntries, threads, viewerId, automations, comments, onSetAcceptance, onOpenEvidence, onOpenGuideSection, onOpenJournal, onOpenProduct }: GoalSurfaceProps): ReactElement {
  const shape = useShape();
  const goal = overview.goal;
  const workspace = scope?.kind === 'workspace' ? scope : null;
  const phase = workspace?.phase ?? goal?.phase ?? null;
  const graphs = useContext(ProjectGraphsContext);
  const pullRequests = workspace ? graphs[workspace.projectId]?.pullRequests[workspace.id] ?? [] : [];
  const staging = useComposerStaging();
  const blockActions = useMemo(() => workspaceBlockActions({ staging, setAcceptance: onSetAcceptance, openGuideSection: onOpenGuideSection }), [staging, onSetAcceptance, onOpenGuideSection]);
  const plan = controls?.plan ?? null;
  const requirements = goal?.requirements ?? [];
  const required = requirements.filter(requirement => requirement.required);
  const accepted = required.filter(requirement => requirement.status === 'accepted').length;
  const toAccept = requirements.filter(requirement => requirement.status === 'review').length;
  const stepsDone = plan?.steps.filter(step => step.status === 'completed').length ?? 0;
  const needsYou = [
    ...plan?.status === 'proposed' ? ['approve the proposed plan'] : [],
    ...controls?.pendingAsk ? ['answer the agent’s question'] : [],
    ...toAccept ? [`accept ${toAccept} requirement${toAccept === 1 ? '' : 's'} with evidence to check`] : [],
    ...overview.review.unresolved ? [`${overview.review.unresolved} open review thread${overview.review.unresolved === 1 ? '' : 's'}`] : [],
  ];
  const entries = journalEntries.length ? journalEntries : overview.journal.recent;
  const done = [
    ...plan?.steps.length ? [`${stepsDone} of ${plan.steps.length} plan steps`] : [],
    ...required.length ? [`${accepted} of ${required.length} required requirements accepted`] : [],
  ];

  return <BlockActionsProvider actions={blockActions}><ScrollArea className="min-h-0 flex-1" viewportClassName="h-full"><div className="flex flex-col gap-6 p-4">
    <section className={`${shape.container} flex flex-col gap-2 bg-surface-1 p-4 shadow-surface-1`} aria-label="Where we are">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-caption font-semibold tabular-nums text-muted-foreground">1</span>
        <h3 className="text-body font-semibold text-foreground">Where we are</h3>
        {phase ? <Badge variant="dot" size="compact" color={phase === 'ship' ? 'green' : 'blue'}>{MODE_LABEL[phase]}</Badge> : null}
        {pullRequests.length ? <PrChips pulls={pullRequests} full /> : workspace ? <span className="text-caption text-muted-foreground">no PR</span> : null}
      </div>
      {done.length ? <p className="text-body text-foreground">Done: {done.join(', ')}.</p> : null}
      <p className="text-body text-foreground"><span className="font-medium">Needs you:</span> {needsYou.length ? needsYou.join(' · ') : 'nothing right now'}</p>
    </section>

    <Part number={2} title={goal?.title ?? 'The goal'} detail={workspace ? <>The goal · <span className="font-mono">{workspace.branch}</span>{goal ? ` · revision ${goal.revision}` : null}</> : 'The goal'}>
      {goal ? <dl className="flex min-w-0 flex-col gap-3">
        <Term label="The problem">{goal.summary.trim() ? <GitSpaceMarkdown>{goal.summary}</GitSpaceMarkdown> : <span className="text-muted-foreground">Not written yet.</span>}</Term>
        {overview.changeGuide?.intro?.trim() ? <Term label="Why it matters"><GitSpaceMarkdown>{overview.changeGuide.intro}</GitSpaceMarkdown></Term> : null}
        <Term label="What done means">{required.length ? `The ${required.length} required requirement${required.length === 1 ? ' is' : 's are'} accepted, each on its evidence.` : 'No required requirements are set yet.'}</Term>
      </dl> : <p className="text-body text-muted-foreground">No goal is attached. The agent writes the workspace goal: the problem, its requirements and their evidence.</p>}
    </Part>

    <Part number={3} title="The plan" detail="The agent’s steps. Steps mark themselves done as the agent finishes them; you approve the plan in the conversation and comment on any step.">
      <PlanSection plan={plan} todos={controls?.todos ?? []} requirements={requirements} threads={threads} comments={comments} />
    </Part>

    <Part number={4} title="Requirements and evidence" detail="Each points at the evidence that shows it and the guide section that explains it.">
      <RequirementsSection requirements={requirements} guide={overview.changeGuide} viewerId={viewerId} onSetAcceptance={onSetAcceptance} onOpenEvidence={onOpenEvidence} onOpenGuideSection={onOpenGuideSection} />
    </Part>

    <Part number={5} title="Decisions" detail="What was decided, by whom, and the conversation that informed it. Newest first.">
      <DecisionsSection entries={entries} guide={overview.changeGuide} viewerId={viewerId} onOpenGuideSection={onOpenGuideSection} onOpenJournal={onOpenJournal} />
    </Part>

    <Part number={6} title="How this workspace runs" detail="The project’s automations that reach this workspace, by phase, and this workspace’s exceptions to them.">
      {workspace && automations ? <>
        {automations.error ? <p role="alert" className="flex flex-wrap items-center gap-2 text-caption text-destructive">{automations.read ? automations.error : `Automations are unavailable. ${automations.error}`}<Button variant="ghost" size="compact" type="button" onClick={automations.retry}>Retry</Button></p> : null}
        {automations.read ? <AutomationPhaseGrid automations={automations.automations} workspaces={[{ id: workspace.id, name: workspace.name, active: workspace.closedAt === null, phase: workspace.phase }]} exceptions={automations.exceptions} busy={automations.busy} now={Date.now()} onSet={automations.set} />
          : automations.error ? null : <p className="text-caption text-muted-foreground">Reading automations…</p>}
        <button type="button" onClick={() => navigateProductUrl(automationsUrl(workspace.projectId))} className="flex items-center gap-1 self-start text-caption text-muted-foreground hover:text-foreground hover:underline">The Automations page edits the project’s automations<ArrowUpRight width={12} height={12} /></button>
      </> : <p className="text-body text-muted-foreground">Automations reach workspaces, not the project agent.</p>}
      {overview.workflow || overview.rubric ? <div className="flex flex-wrap gap-2">
        {overview.workflow ? <Button variant="secondary" size="compact" type="button" onClick={() => onOpenProduct('workflow')}>{ic(Play, 14)}{overview.workflow.title}</Button> : null}
        {overview.rubric ? <Button variant="secondary" size="compact" type="button" onClick={() => onOpenProduct('rubric')}>{ic(Scales02, 14)}{overview.rubric.title}</Button> : null}
      </div> : null}
    </Part>
  </div></ScrollArea></BlockActionsProvider>;
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
