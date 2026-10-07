import { FileDiff } from '@pierre/diffs/react';
import { parsePatchFiles, type DiffLineAnnotation, type FileDiffOptions, type SelectedLineRange } from '@pierre/diffs';
import { FileTree, useFileTree } from '@pierre/trees/react';
import type { GitStatusEntry } from '@pierre/trees';
import { Background, Controls, MarkerType, Position, ReactFlow, type Edge, type Node } from '@xyflow/react';
import type { ExecutionBlock } from '@gitspace/blocks';
import type { RuntimeSideAgentBlock } from '../runtime-shell-adapter.js';
import { TranscriptItemView } from '../TurnTranscript.js';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
  Badge,
  Button,
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardGroup,
  CardHeader,
  CardImage,
  CardMedia,
  CardTitle,
  InputCopy,
  Elevated,
  ScrollArea,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  TabsSubtle,
  TabsSubtleItem,
  TabsSubtlePanel,
  Tooltip,
  ThinkingIndicator,
  ThinkingStep,
  ThinkingStepDetails,
  ThinkingSteps,
  ThinkingStepsContent,
  ThinkingStepsHeader,
  useShape,
  type BadgeProps,
  type IconName,
} from '@gitspace/ui';
import type {
  ChangeGuideView,
  EvidenceReference,
  GoalRecordView,
  InspectorOverview,
  JournalEntryView,
  RepositoryDiffView,
  RepositoryFileView,
  RepositoryMode,
  RepositoryTreeEntry,
  ReviewAnchor,
  ReviewThreadView,
  RubricCriterion,
  RubricView,
  SessionUsageReport,
  ServiceView,
  WorkflowNode,
  WorkflowView,
} from '@gitspace/protocol';
import type { GitLfsHeldBack, WorkspaceStatusColor } from '@gitspace/protocol-workspace';
import {
  AlertCircle,
  Archive,
  Check,
  Dataflow03,
  File02,
  FileCode02,
  GitBranch01,
  Image01,
  LinkExternal01,
  MessageSquare01,
  Play,
  Scales02,
  Terminal,
  Tool02,
  User01,
  Users01,
  XClose,
} from '@untitledui/icons';
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { glyph } from '../glyph.js';
import { rpcErrorMessage } from '../rpc-error-message.js';
import { GitSpaceMarkdown } from '../GitSpaceMarkdown.js';
import { artifactImageUrl, markdownImageSources } from '../markdown-artifact-images.js';
import { EmptyState, StatusDot, type AgentScopeView, type WorkspaceView } from '../GitSpaceShell.js';
import { OverviewView, type OverviewViewProps } from './OverviewView.js';
import { UsageView, type UsageStatus, type InspectorProviderUsageState } from './UsageView.js';
import { AgentSetupView, type InspectorAgentSetupState } from './AgentSetupView.js';
import { ArtifactActions, type ArtifactActionsHandlers } from './ArtifactActions.js';
import { ArtifactUploadButton, ArtifactUploadList, useArtifactUploads, type ArtifactUploads } from './ArtifactUploads.js';
import type { ArtifactUploadClient } from './artifact-upload.js';
import { syncRepositoryTreePaths } from './repository-tree-paths.js';
import { ResourceNavigation, type ResourceRequest } from '../ResourceNavigation.js';

export type InspectorPermanentView = 'overview' | 'environment' | 'goal' | 'agents' | 'subagents' | 'files' | 'artifacts' | 'services' | 'usage' | 'guide' | 'journal';
export type InspectorDocumentKind = 'file' | 'diff' | 'artifact' | 'resource' | 'goal' | 'workflow' | 'rubric';
export interface InspectorOpenDocument {
  id: string;
  kind: InspectorDocumentKind;
  label: string;
  target: string;
}
export interface InspectorArtifactContent {
  url: string;
  source: string | null;
  previewUrl: string;
  mediaType: string | null;
  dispose?(): void;
}
export interface CreateInspectorThread {
  anchor: ReviewAnchor;
  body: string;
  decision: ReviewThreadView['decision'];
}
export interface InspectorUsageState {
  sessionId: string | null;
  report: SessionUsageReport | null;
  status: UsageStatus;
  error?: string;
  providerUsage?: InspectorProviderUsageState;
  load(): void;
  refresh(): void;
}
export interface InspectorSectionError {
  message: string;
  retained: boolean;
  retry(): void;
}
function selectOptions(options: readonly { value: string; label: ReactNode }[]): ReactNode {
  return <SelectContent>{options.map((option, index) => <SelectItem value={option.value} index={index} key={option.value}>{option.label}</SelectItem>)}</SelectContent>;
}
export interface InspectorProps {
  overview: InspectorOverview;
  /** The agent scope the Inspector is open for: a workspace, or the project's base space. */
  scope?: AgentScopeView;
  workspaces: readonly WorkspaceView[];
  onSelectWorkspace(workspaceId: string): void;
  onSetRelations?: OverviewViewProps['onSetRelations'];
  stackStatus?: OverviewViewProps['stackStatus'];
  environment?: ReactNode;
  repositoryEntries: readonly RepositoryTreeEntry[];
  lfsHeldBack?: readonly GitLfsHeldBack[];
  repositoryMode: RepositoryMode;
  onRepositoryModeChange(mode: RepositoryMode): void;
  repositoryFile: RepositoryFileView | null;
  repositoryDiff: RepositoryDiffView | null;
  journalEntries: readonly JournalEntryView[];
  threads: readonly ReviewThreadView[];
  services: readonly ServiceView[];
  runtimeServices?: ReactNode;
  subagents: readonly (ExecutionBlock | RuntimeSideAgentBlock)[];
  onStopSubagent?(conversationId: string): Promise<void>;
  renderSubagentTranscript?(conversationId: string): ReactNode;
  usage: InspectorUsageState;
  agentSetup: InspectorAgentSetupState;
  onRequestArtifact(reference: Extract<EvidenceReference, { kind: 'artifact' }>, signal?: AbortSignal): Promise<InspectorArtifactContent>;
  artifactReferences?: readonly Extract<EvidenceReference, { kind: 'artifact' }>[];
  resourceRequest?: ResourceRequest;
  onRequestResource?(uri: string, signal?: AbortSignal): Promise<InspectorArtifactContent>;
  artifactActions?: ArtifactActionsHandlers;
  /** Present when the viewer may upload files into the workspace's `uploads/` artifact folder. */
  artifactUpload?: ArtifactUploadClient;
  reviewerId: string;
  loading?: boolean;
  error?: string | null;
  sectionErrors?: Partial<Record<InspectorPermanentView, InspectorSectionError>>;
  initialView?: InspectorPermanentView;
  /** False for cloud inspection without an open workspace on an online machine. */
  runtimeAvailable?: boolean;
  onClose?: () => void;
  onRequestRepositoryFile(path: string, mode: RepositoryMode): void;
  onRequestRepositoryDiff(path: string | null, mode: Exclude<RepositoryMode, 'current'>, baseRef?: string): void;
  onLoadRepositoryDiff(path: string, mode: Exclude<RepositoryMode, 'current'>, baseRef?: string): Promise<RepositoryDiffView>;
  onCreateThread(input: CreateInspectorThread): Promise<ReviewThreadView>;
  onReplyThread(threadId: string, expectedRevision: number, body: string): Promise<void>;
  onResolveThread(threadId: string, expectedRevision: number, resolved: boolean, decision: ReviewThreadView['decision']): Promise<void>;
  onMarkGuideSectionRead(sectionId: string, revision: number, headCommit: string): Promise<void>;
  onSetGuideApproval(decision: 'pending' | 'approved' | 'changes-requested', note: string | null, revision: number, headCommit: string): Promise<void>;
  onGenerateChangeGuide?(): Promise<void>;
  onSubmitHumanJudgment?(criterionId: string, verdict: 'pass' | 'fail', summary: string): Promise<void>;
  onStartService?(serviceName: string): Promise<void>;
  onStopService?(serviceName: string): Promise<void>;
  onOpenServiceTerminal?(terminalName: string): void;
}

type ActiveView = InspectorPermanentView | 'document';
type ArtifactReference = Extract<EvidenceReference, { kind: 'artifact' }>;
type LoadStatus = 'loading' | 'loaded' | 'error' | undefined;
type ToneColor = NonNullable<BadgeProps['color']>;
type ThreadIdentity = Pick<Extract<ReviewAnchor, { kind: 'line' }>, 'generation' | 'baseCommit' | 'headCommit' | 'blobId'>;
interface ThreadSelection { path: string; side: 'base' | 'head'; startLine: number; endLine: number; identity: ThreadIdentity }
type ThreadIdentities = Record<'base' | 'head', ThreadIdentity>;
function diffIdentities(diff: RepositoryDiffView, path: string): ThreadIdentities {
  const file = diff.files.find((entry) => entry.path === path);
  const context = { generation: diff.generation, baseCommit: diff.baseCommit, headCommit: diff.headCommit };
  return { base: { ...context, blobId: file?.oldBlobId ?? null }, head: { ...context, blobId: file?.newBlobId ?? null } };
}
interface GuideViewState {
  active: number;
  anchor: { key: string; offset: number } | null;
  openedGates: Set<string>;
}
const guideViewCache = new Map<string, GuideViewState>();
const RuntimeAvailability = createContext(true);
const openWorkspaceFirst = 'Open this workspace on a machine first';
const runtimeViews: Partial<Record<InspectorPermanentView, true>> = { overview: true, agents: true, subagents: true, files: true, services: true, usage: true };

const permanentTabs: ReadonlyArray<{ id: InspectorPermanentView; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'environment', label: 'Environment' },
  { id: 'goal', label: 'Goal' },
  { id: 'agents', label: 'Agent setup' },
  { id: 'subagents', label: 'Subagents' },
  { id: 'files', label: 'Files' },
  { id: 'artifacts', label: 'Artifacts' },
  { id: 'services', label: 'Services' },
  { id: 'usage', label: 'Usage' },
  { id: 'guide', label: 'Change Guide' },
  { id: 'journal', label: 'Journal' },
];
const agentSetupTabIndex = permanentTabs.findIndex((tab) => tab.id === 'agents');
const repositoryModes: ReadonlyArray<{ id: RepositoryMode; label: string }> = [
  { id: 'current', label: 'Current files' },
  { id: 'working', label: 'Unstaged' },
  { id: 'staged', label: 'Staged' },
  { id: 'base', label: 'All changes since base' },
];
const artifactModes = ['preview', 'source'] as const;

// Untitled UI glyphs adapted once, at module scope, to Fluid's IconComponent
// shape so Card/Tabs slots never remount a freshly created component.
const GitBranchGlyph = glyph(GitBranch01);
const PlayGlyph = glyph(Play);
const ScalesGlyph = glyph(Scales02);
const FileGlyph = glyph(File02);
const ImageGlyph = glyph(Image01);
const UsersGlyph = glyph(Users01);
const ServerGlyph = glyph(Dataflow03);

type Glyph = ComponentType<{ width?: number; height?: number; strokeWidth?: number; className?: string }>;
function ic(Icon: Glyph, size = 16): ReactNode { return <Icon width={size} height={size} strokeWidth={1.5} />; }

function settle(promise: Promise<void>): void { void promise.catch(() => undefined); }
function initials(value: string): string { return value.split(/[^A-Za-z0-9]+/u).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join('') || '?'; }
function shortHash(value: string | null): string { return value ? value.slice(0, 8) : 'untracked'; }
function formatDate(value: string): string { return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)); }
function fileName(path: string): string { return path.split('/').at(-1) ?? path; }
function artifactId(reference: ArtifactReference): string { return `${reference.url}@${reference.hash}`; }
function evidenceLabel(reference: EvidenceReference): string {
  return reference.label;
}
function collectEvidence(overview: InspectorOverview, entries: readonly JournalEntryView[]): EvidenceReference[] {
  const evidence: EvidenceReference[] = [];
  for (const requirement of overview.goal?.requirements ?? []) evidence.push(...requirement.evidence);
  for (const criterion of overview.rubric?.criteria ?? []) evidence.push(...criterion.evidence, ...criterion.judgments.flatMap((judgment) => judgment.evidence));
  for (const entry of entries) evidence.push(...entry.evidence);
  const seen = new Set<string>();
  return evidence.filter((reference) => {
    const id = reference.kind === 'artifact' ? artifactId(reference) : JSON.stringify(reference);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}
function documentIcon(kind: InspectorDocumentKind): ReactNode {
  if (kind === 'artifact') return ic(File02, 14);
  if (kind === 'goal') return ic(GitBranch01, 14);
  if (kind === 'workflow') return ic(Play, 14);
  if (kind === 'rubric') return ic(Scales02, 14);
  return ic(FileCode02, 14);
}
function toneColor(value: string): ToneColor {
  switch (value) {
    case 'accepted': case 'pass': case 'passed': case 'satisfied': case 'approved': case 'ready': case 'running': case 'done': return 'green';
    case 'review': case 'pending': case 'stale': case 'passable': case 'starting': return 'amber';
    case 'missing': case 'fail': case 'failed': case 'blocked': case 'changes-requested': return 'red';
    default: return 'gray';
  }
}
function serviceDot(state: ServiceView['state']): WorkspaceStatusColor {
  if (state === 'running' || state === 'ready') return 'green';
  if (state === 'failed') return 'red';
  if (state === 'stopped' || state === 'exited') return 'dim';
  return 'blue';
}
function Tone({ value }: { value: string }) { return <Badge variant="dot" color={toneColor(value)}>{value}</Badge>; }
function Kicker({ children }: { children: ReactNode }) { return <span className="text-caption text-muted-foreground">{children}</span>; }
function Heading({ children }: { children: ReactNode }) { return <h2 className="text-title font-semibold text-foreground">{children}</h2>; }
function SectionTitle({ children }: { children: ReactNode }) { return <h3 className="text-caption font-medium text-muted-foreground">{children}</h3>; }
function SurfaceHeader({ kicker, title, detail }: { kicker: string; title: string; detail: string }) {
  return <header className="flex flex-col gap-1 px-4 pb-3 pt-4"><Kicker>{kicker}</Kicker><Heading>{title}</Heading><p className="text-body text-muted-foreground">{detail}</p></header>;
}
function Placeholder({ children }: { children: ReactNode }) {
  return <div className="grid min-h-28 place-items-center p-4 text-center text-caption text-muted-foreground">{children}</div>;
}
function Padded({ children }: { children: ReactNode }) { return <div className="p-4">{children}</div>; }
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
function MetaCard({ label, children }: { label: string; children: ReactNode }) {
  return <Card size="compact"><CardHeader><CardDescription>{label}</CardDescription><CardTitle className="flex items-center gap-2 truncate tabular-nums">{children}</CardTitle></CardHeader></Card>;
}

function GoalOverview({ overview, openDocuments, onOpenProduct, onOpenEvidence }: { overview: InspectorOverview; openDocuments: number; onOpenProduct: (kind: 'goal' | 'workflow' | 'rubric') => void; onOpenEvidence: (reference: EvidenceReference) => void }) {
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

function ProductGoal({ goal, onOpenEvidence }: { goal: GoalRecordView; onOpenEvidence: (reference: EvidenceReference) => void }) {
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
function WorkflowDocument({ workflow }: { workflow: WorkflowView }) {
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
function RubricDocument({ rubric, onOpenEvidence, onSubmit }: { rubric: RubricView; onOpenEvidence: (reference: EvidenceReference) => void; onSubmit?: InspectorProps['onSubmitHumanJudgment'] }) {
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

function repositoryPatch(file: RepositoryFileView): string {
  const lines = file.content.split('\n');
  return `diff --git a/${file.path} b/${file.path}\n--- a/${file.path}\n+++ b/${file.path}\n@@ -1,${lines.length} +1,${lines.length} @@\n${lines.map((line) => ` ${line}`).join('\n')}\n`;
}
interface ThreadAnnotation { thread: ReviewThreadView }
function PierreViewer({ path, identities, patch, threads, onSelectThread, onSelectRange }: { path: string; identities: ThreadIdentities; patch: string; threads: readonly ReviewThreadView[]; onSelectThread: (thread: ReviewThreadView) => void; onSelectRange: (selection: ThreadSelection) => void }) {
  const fileDiff = useMemo(() => parsePatchFiles(patch).flatMap((parsed) => parsed.files)[0] ?? null, [patch]);
  const matches = (thread: ReviewThreadView): boolean => {
    if (thread.anchor.kind !== 'line' || thread.anchor.path !== path) return false;
    const identity = identities[thread.anchor.side];
    return thread.anchorState !== 'stale' && thread.anchor.generation === identity.generation && thread.anchor.baseCommit === identity.baseCommit && thread.anchor.headCommit === identity.headCommit && !!identity.blobId && thread.anchor.blobId === identity.blobId;
  };
  const annotations: DiffLineAnnotation<ThreadAnnotation>[] = threads.flatMap((thread) => thread.anchor.kind === 'line' && matches(thread) ? [{ side: thread.anchor.side === 'head' ? 'additions' as const : 'deletions' as const, lineNumber: thread.anchor.startLine, metadata: { thread } }] : []);
  const outdatedThreads = threads.filter((thread) => thread.anchor.kind === 'line' && thread.anchor.path === path && !matches(thread));
  const selectLine = (side: 'base' | 'head', startLine: number, endLine: number): void => onSelectRange({ path, identity: identities[side], side, startLine, endLine });
  const options = useMemo<FileDiffOptions<ThreadAnnotation>>(() => ({ diffStyle: 'unified', theme: 'github-light', disableFileHeader: true, hunkSeparators: 'line-info', enableHoverUtility: true, enableLineSelection: true, onLineSelectionEnd: (range: SelectedLineRange | null) => { if (!range) return; selectLine(range.side === 'deletions' ? 'base' : 'head', Math.min(range.start, range.end), Math.max(range.start, range.end)); } }), [identities, onSelectRange, path]);
  if (!fileDiff) return <Padded><EmptyState icon={ic(FileCode02, 22)} title="No parseable content" description={`The selected ${path} view did not contain a text patch Pierre can render.`} /></Padded>;
  // FLUID-GAP: diff viewer — @pierre/diffs renders the patch with its own theme.
  return <div className="min-h-0 flex-1 overflow-auto bg-surface-3">{outdatedThreads.length ? <div className="flex flex-wrap items-center gap-2 p-3"><span className="text-caption text-muted-foreground">Comments on other or unverified content:</span>{outdatedThreads.map((thread) => <Button key={thread.id} variant="tertiary" size="compact" type="button" onClick={() => onSelectThread(thread)}>{ic(MessageSquare01, 14)}{thread.anchor.kind === 'line' ? `Lines ${thread.anchor.startLine}–${thread.anchor.endLine}` : 'Thread'}</Button>)}</div> : null}<FileDiff fileDiff={fileDiff} options={options} lineAnnotations={annotations} renderAnnotation={(annotation) => <Button variant="tertiary" size="compact" type="button" onClick={() => onSelectThread(annotation.metadata.thread)}>{ic(MessageSquare01, 14)}<span className="tabular-nums">{annotation.metadata.thread.messages.length}</span></Button>} renderGutterUtility={(getHoveredLine) => <Button variant="tertiary" size="icon-compact" type="button" aria-label="Add line comment" onMouseDown={(event) => { event.preventDefault(); const line = getHoveredLine(); if (line) selectLine(line.side === 'deletions' ? 'base' : 'head', line.lineNumber, line.lineNumber); }}>+</Button>} /></div>;
}

function RepositoryTree({ entries, changedOnly, onOpen }: { entries: readonly RepositoryTreeEntry[]; changedOnly: boolean; onOpen: (entry: RepositoryTreeEntry) => void }) {
  const shown = useMemo(() => entries.filter((entry) => entry.kind === 'file' && (!changedOnly || entry.status !== 'clean')), [changedOnly, entries]);
  const paths = useMemo(() => shown.map((entry) => entry.path), [shown]);
  const status = useMemo<GitStatusEntry[]>(() => shown.filter((entry) => entry.status !== 'clean').map((entry) => ({ path: entry.path, status: entry.status === 'untracked' ? 'untracked' : entry.status === 'clean' ? 'modified' : entry.status } as GitStatusEntry)), [shown]);
  const entriesRef = useRef(shown); entriesRef.current = shown;
  const openRef = useRef(onOpen); openRef.current = onOpen;
  const { model } = useFileTree({ paths, gitStatus: status, initialExpandedPaths: [...new Set(paths.map((path) => path.split('/')[0]!).filter(Boolean))], density: 'compact', onSelectionChange: (selected) => { const entry = entriesRef.current.find((candidate) => selected.includes(candidate.path)); if (entry) openRef.current(entry); } });
  const loadedPaths = useRef(paths);
  useEffect(() => { syncRepositoryTreePaths(model, loadedPaths.current, paths); loadedPaths.current = paths; }, [model, paths]);
  useEffect(() => { model.setGitStatus(status); }, [model, status]);
  // FLUID-GAP: file tree — @pierre/trees renders the repository tree with its own theme.
  return <FileTree model={model} className="h-full" />;
}

export function FilesSurface({ entries, heldBack, mode, onModeChange, changedOnly, setChangedOnly, onOpen, onOpenHeldBack }: { entries: readonly RepositoryTreeEntry[]; heldBack: readonly GitLfsHeldBack[]; mode: RepositoryMode; onModeChange: (mode: RepositoryMode) => void; changedOnly: boolean; setChangedOnly: (value: boolean) => void; onOpen: (entry: RepositoryTreeEntry) => void; onOpenHeldBack(path: string): void }) {
  const changed = new Set([...entries.filter((entry) => entry.kind === 'file' && entry.status !== 'clean').map(entry => entry.path), ...heldBack.map(item => item.path)]).size;
  const ordinaryEntries = entries.filter(entry => !heldBack.some(item => item.path === entry.path));
  return <div className="flex min-h-0 flex-1 flex-col">
    <header className="flex flex-col gap-2 px-4 pb-2 pt-4">
      <div className="flex items-center justify-between gap-2"><strong className="text-body font-medium text-foreground">Repository</strong><span className="text-caption text-muted-foreground tabular-nums">{entries[0] ? `generation ${entries[0].generation}` : heldBack.length ? 'Saved LFS changes' : 'No checkout'}</span></div>
      <Select value={mode} onValueChange={(value) => onModeChange(value as RepositoryMode)} size="compact"><SelectTrigger aria-label="Repository comparison" />{selectOptions(repositoryModes.map(({ id, label }) => ({ value: id, label })))}</Select>
      <TabsSubtle size="compact" selectedIndex={changedOnly ? 1 : 0} onSelect={(index) => setChangedOnly(index === 1)} aria-label="Repository filter"><TabsSubtleItem index={0} label="All" /><TabsSubtleItem index={1} label={`Changed · ${changed}`} /></TabsSubtle>
      <p className="text-caption text-muted-foreground">Choose any file from All, or focus the tree to paths changed in this workspace.</p>
    </header>
    {heldBack.length ? <section className="flex flex-col gap-2 px-4 pb-3" aria-label="Machine-local LFS changes"><p className="text-caption text-muted-foreground">LFS changes leave this machine only after a commit</p><ul className="flex max-h-60 flex-col gap-1 overflow-auto">{heldBack.map(item => <li key={item.path} className="flex items-center justify-between gap-2"><Button variant="ghost" size="compact" className="min-w-0 justify-start" onClick={() => onOpenHeldBack(item.path)}><span className="truncate font-mono">{item.path}</span></Button><Badge color="amber">Only on this machine</Badge></li>)}</ul></section> : null}
    <div className="min-h-0 flex-1 overflow-auto px-2 pb-2">{ordinaryEntries.length ? <RepositoryTree entries={ordinaryEntries} changedOnly={changedOnly} onOpen={onOpen} /> : heldBack.length ? null : <EmptyState icon={ic(File02, 20)} title="Repository unavailable" description="The current workspace generation has no repository tree." />}</div>
  </div>;
}

function ThreadPanel({ thread, selection, onClose, onCreate, onReply, onResolve }: { thread: ReviewThreadView | null; selection: ThreadSelection | null; onClose: () => void; onCreate: (body: string) => Promise<void>; onReply: (body: string) => Promise<void>; onResolve: (resolved: boolean, decision: ReviewThreadView['decision']) => Promise<void> }) {
  const shape = useShape();
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const mutate = async (operation: () => Promise<void>, clearDraft = false): Promise<void> => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      await operation();
      if (clearDraft) setDraft('');
    } catch (cause) {
      setError(rpcErrorMessage(cause, 'Update review thread'));
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };
  const title = thread ? thread.anchor.kind === 'line' ? `${thread.anchor.path} · lines ${thread.anchor.startLine}–${thread.anchor.endLine}` : thread.anchor.kind : selection ? `${selection.path} · lines ${selection.startLine}–${selection.endLine}` : 'Review thread';
  const send = (): void => { const body = draft.trim(); if (!body) return; void mutate(() => thread ? onReply(body) : onCreate(body), true); };
  return <Elevated offset={1} className="flex max-h-[50%] shrink-0 flex-col border-t border-border">
    <header className="flex items-center gap-2 px-3 py-2">
      <span className="flex min-w-0 flex-1 flex-col"><strong className="text-body font-medium text-foreground">{thread ? 'Review thread' : 'New review thread'}</strong><span className="truncate text-caption text-muted-foreground tabular-nums">{title}</span></span>
      {thread ? <Button variant="secondary" size="compact" type="button" disabled={pending} onClick={() => void mutate(() => onResolve(!thread.resolved, thread.resolved ? 'pending' : thread.decision))}>{thread.resolved ? 'Reopen' : 'Resolve'}</Button> : null}
      <Button variant="ghost" size="icon-compact" type="button" disabled={pending} aria-label="Close review thread" onClick={onClose}><XClose width={16} height={16} strokeWidth={1.5} /></Button>
    </header>
    {thread?.anchorState === 'stale' ? <p className="flex flex-wrap items-center gap-2 px-3 pb-2 text-caption text-muted-foreground"><Badge variant="dot" color="amber">Stale anchor</Badge>{thread.staleReason ?? 'The repository identity changed after this thread was created.'}</p> : null}
    <ScrollArea className="min-h-0 flex-1"><div className="flex flex-col gap-3 px-3 pb-3">{thread?.messages.map((message) => <article className="flex gap-2" key={message.id}>
      <span className={`${shape.bg} grid size-7 shrink-0 place-items-center bg-muted text-caption font-medium text-muted-foreground`} aria-hidden>{initials(message.authorId)}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5"><header className="flex items-baseline justify-between gap-2"><strong className="text-body font-medium text-foreground">{message.authorId}</strong><time className="text-caption text-muted-foreground tabular-nums">{formatDate(message.createdAt)}</time></header><p className="text-body text-muted-foreground">{message.body}</p></div>
    </article>)}</div></ScrollArea>
    <div className="flex flex-col gap-2 border-t border-border p-3">
      {error ? <p role="alert" className="text-caption text-destructive">{error}</p> : null}
      {/* FLUID-GAP: multi-line textarea — the registry has no textarea field. */}
      <textarea aria-label={thread ? 'Reply to review thread' : 'Start review thread'} disabled={pending} value={draft} onChange={(event) => setDraft(event.currentTarget.value)} placeholder={thread ? 'Reply with durable review context' : 'Describe the issue on this line'} className={`${shape.input} min-h-20 w-full resize-y border border-border bg-surface-2 p-2 text-body text-foreground`} />
      <footer className="flex items-center justify-between gap-2">
        {thread ? <Select value={thread.decision} disabled={pending} size="compact" onValueChange={(value) => void mutate(() => onResolve(thread.resolved, value as ReviewThreadView['decision']))}><SelectTrigger aria-label="Review decision" />{selectOptions([{ value: 'pending', label: 'Pending' }, { value: 'approved', label: 'Approved' }, { value: 'changes-requested', label: 'Changes requested' }])}</Select> : <span />}
        <Button variant="primary" size="compact" type="button" disabled={pending || !draft.trim()} onClick={send}>{pending ? 'Saving…' : thread ? 'Reply' : 'Start thread'}</Button>
      </footer>
    </div>
  </Elevated>;
}

/** Images naming other artifacts load through the Inspector's artifact reads and render from their object URLs. */
function MarkdownArtifact({ source, documentUrl, artifactReferences, artifactContent, onRequest }: {
  source: string;
  documentUrl: string;
  artifactReferences: readonly ArtifactReference[];
  artifactContent: Readonly<Record<string, InspectorArtifactContent>>;
  onRequest(reference: ArtifactReference): Promise<void>;
}) {
  const findImage = (src: string): ArtifactReference | undefined => {
    const url = artifactImageUrl(src, documentUrl);
    return url ? artifactReferences.find((reference) => reference.url === url) : undefined;
  };
  const images = markdownImageSources(source).flatMap((src) => findImage(src) ?? []);
  const imageKey = images.map(artifactId).join('\n');
  useEffect(() => { for (const image of images) void onRequest(image); }, [imageKey]);
  const resolveImage = (src: string): string | null => {
    const image = findImage(src);
    return image ? artifactContent[artifactId(image)]?.previewUrl ?? null : null;
  };
  return <ScrollArea className="min-h-0 flex-1" viewportClassName="h-full"><article className="mx-auto w-full max-w-3xl px-6 py-6"><GitSpaceMarkdown resolveImage={resolveImage}>{source}</GitSpaceMarkdown></article></ScrollArea>;
}
function SourceArtifact({ source }: { source: string }) {
  // FLUID-GAP: code viewer — the registry has no read-only code block; plain <pre> on Fluid tokens.
  return <pre className="min-h-0 flex-1 overflow-auto bg-surface-1 p-4 font-mono text-caption text-foreground">{source}</pre>;
}
function PreviewFrame({ children }: { children: ReactNode }) {
  return <div className="grid min-h-0 flex-1 place-items-center overflow-auto bg-surface-1 p-4">{children}</div>;
}

function MiniAppArtifact({ source, dataReferences, content, onLoad }: {
  source: string;
  dataReferences: readonly ArtifactReference[];
  content: Readonly<Record<string, InspectorArtifactContent>>;
  onLoad(reference: ArtifactReference): Promise<void>;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [dataUrl, setDataUrl] = useState(dataReferences[0]?.url ?? '');
  const selected = dataReferences.find((reference) => reference.url === dataUrl) ?? null;
  const dataSource = selected ? content[artifactId(selected)]?.source ?? null : null;
  useEffect(() => { if (selected && !content[artifactId(selected)]) void onLoad(selected); }, [selected ? artifactId(selected) : '', content]);
  let payload: unknown = null;
  if (dataSource) {
    try { payload = JSON.parse(dataSource); } catch { payload = null; }
  }
  const send = (): void => { frameRef.current?.contentWindow?.postMessage({ type: 'gssh:data', data: payload }, '*'); };
  useEffect(send, [source, dataSource]);
  return <div className="flex min-h-0 flex-1 flex-col bg-surface-1">
    {dataReferences.length ? <label className="flex items-center gap-2 border-b border-border px-3 py-2 text-caption text-muted-foreground"><span>Data</span><Select value={dataUrl} size="compact" onValueChange={setDataUrl}><SelectTrigger aria-label="Artifact data" />{selectOptions(dataReferences.map((reference) => ({ value: reference.url, label: reference.label })))}</Select></label> : null}
    <iframe ref={frameRef} sandbox="allow-scripts" srcDoc={source} title="GitSpace mini-app" onLoad={send} className="min-h-0 w-full flex-1 bg-surface-3" />
  </div>;
}

function ArtifactDocument({ reference, content, status, error, mode, artifactReferences, artifactContent, onRequest }: {
  reference: ArtifactReference;
  content: InspectorArtifactContent | null;
  status: LoadStatus;
  error: string | undefined;
  mode: 'preview' | 'source';
  artifactReferences: readonly ArtifactReference[];
  artifactContent: Readonly<Record<string, InspectorArtifactContent>>;
  onRequest(reference: ArtifactReference): Promise<void>;
}) {
  // Pinned evidence and transcript resources share the same preview renderers below.
  if (status === 'loading' || status === undefined) return <div className="flex flex-1 items-center justify-center p-6"><ThinkingIndicator aria-label={`Loading ${reference.label}…`} /></div>;
  if (status === 'error') return <Padded><EmptyState icon={ic(AlertCircle, 22)} title="Artifact could not load" description={error ?? 'The artifact read failed.'} action={<Button variant="secondary" size="compact" type="button" onClick={() => void onRequest(reference)}>Retry</Button>} /></Padded>;
  if (!content) return <Padded><EmptyState icon={ic(Archive, 22)} title="Artifact bytes are unavailable" description="The authority returned no readable content." /></Padded>;
  return <ArtifactPreview reference={reference} content={content} mode={mode} artifactReferences={artifactReferences} artifactContent={artifactContent} onRequest={onRequest} />;
}

function ArtifactPreview({ reference, content, mode, artifactReferences, artifactContent, onRequest }: {
  reference: Pick<ArtifactReference, 'url' | 'label' | 'mediaType'>;
  content: InspectorArtifactContent;
  mode: 'preview' | 'source';
  artifactReferences: readonly ArtifactReference[];
  artifactContent: Readonly<Record<string, InspectorArtifactContent>>;
  onRequest(reference: ArtifactReference): Promise<void>;
}) {
  const shape = useShape();
  if (mode === 'source') return content.source !== null ? <SourceArtifact source={content.source} /> : <Padded><EmptyState icon={ic(File02, 22)} title="Source is unavailable" description="This binary artifact has no text source." /></Padded>;
  const mediaType = content.mediaType ?? reference.mediaType;
  if (mediaType?.startsWith('image/')) return <PreviewFrame><img src={content.previewUrl} alt={reference.label} className={`${shape.container} max-h-full max-w-full bg-surface-3 object-contain shadow-surface-1`} /></PreviewFrame>;
  if ((reference.url.endsWith('.gssh.html') || mediaType === 'text/html') && content.source !== null) return <MiniAppArtifact source={content.source} dataReferences={artifactReferences.filter((candidate) => candidate.url.endsWith('.data.json'))} content={artifactContent} onLoad={onRequest} />;
  if (mediaType === 'application/pdf') return <PreviewFrame><iframe src={content.previewUrl} title={reference.label} className={`${shape.container} h-full min-h-90 w-full bg-surface-3 shadow-surface-1`} /></PreviewFrame>;
  if (mediaType?.startsWith('audio/')) return <PreviewFrame><audio controls src={content.previewUrl} /></PreviewFrame>;
  if (mediaType?.startsWith('video/')) return <PreviewFrame><video controls src={content.previewUrl} className="max-h-full max-w-full" /></PreviewFrame>;
  if ((mediaType === 'application/json' || reference.url.endsWith('.json')) && content.source !== null) {
    let pretty = content.source;
    try { pretty = JSON.stringify(JSON.parse(content.source), null, 2); } catch { /* Render original text. */ }
    return <SourceArtifact source={pretty} />;
  }
  if ((mediaType === 'text/markdown' || reference.url.endsWith('.md')) && content.source !== null) return <MarkdownArtifact source={content.source} documentUrl={reference.url} artifactReferences={artifactReferences} artifactContent={artifactContent} onRequest={onRequest} />;
  return content.source !== null ? <SourceArtifact source={content.source} /> : <Padded><EmptyState icon={ic(Archive, 22)} title="Preview is unavailable" description="This artifact type has no inline renderer." /></Padded>;
}

function ResourceDocument({ uri, mode, onRequest, artifactReferences, artifactContent, onRequestArtifact }: {
  uri: string;
  mode: 'preview' | 'source';
  onRequest: InspectorProps['onRequestResource'];
  artifactReferences: readonly ArtifactReference[];
  artifactContent: Readonly<Record<string, InspectorArtifactContent>>;
  onRequestArtifact(reference: ArtifactReference): Promise<void>;
}) {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ content: InspectorArtifactContent } | { error: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    let loaded: InspectorArtifactContent | undefined;
    setResult(null);
    void (async () => {
      try {
        if (!onRequest) throw new Error('Resource reads are unavailable for this workspace.');
        const content = await onRequest(uri, controller.signal);
        if (cancelled) content.dispose?.();
        else { loaded = content; setResult({ content }); }
      } catch (error) {
        if (!cancelled) setResult({ error: rpcErrorMessage(error, 'Read workspace resource') });
      }
    })();
    return () => { cancelled = true; controller.abort(); loaded?.dispose?.(); };
  }, [uri, attempt]);
  if (!result) return <div className="flex flex-1 items-center justify-center p-6"><ThinkingIndicator aria-label={`Loading ${uri}…`} /></div>;
  if ('error' in result) return <Padded><EmptyState icon={ic(AlertCircle, 22)} title="Resource could not load" description={`${uri}: ${result.error}`} action={<Button variant="secondary" size="compact" type="button" onClick={() => setAttempt((value) => value + 1)}>Retry</Button>} /></Padded>;
  return <ArtifactPreview reference={{ url: uri, label: uri, mediaType: result.content.mediaType }} content={result.content} mode={mode} artifactReferences={artifactReferences} artifactContent={artifactContent} onRequest={onRequestArtifact} />;
}

function ArtifactsSurface({ references, onOpen, actions, uploads }: { references: readonly ArtifactReference[]; onOpen: (reference: EvidenceReference) => void; actions?: ArtifactActionsHandlers; uploads: ArtifactUploads | null }) {
  const [selected, setSelected] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const runtimeAvailable = useContext(RuntimeAvailability);
  const list = useRef<HTMLDivElement>(null);
  const latestUpload = uploads?.highlighted.at(-1);
  useEffect(() => {
    if (latestUpload) list.current?.querySelector(`[data-artifact-url="${CSS.escape(latestUpload)}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [latestUpload, references]);
  const selection = references.filter((reference) => selected.includes(reference.url));
  const dropTarget = uploads && runtimeAvailable ? uploads : null;
  return <div
    className={`flex min-h-0 flex-1 flex-col ${dragging ? 'ring-1 ring-inset ring-[color:var(--focus-ring,#6B97FF)]' : ''}`}
    onDragOver={dropTarget ? (event) => { if (!event.dataTransfer.types.includes('Files')) return; event.preventDefault(); setDragging(true); } : undefined}
    onDragLeave={dropTarget ? (event) => { if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) setDragging(false); } : undefined}
    onDrop={dropTarget ? (event) => { event.preventDefault(); setDragging(false); dropTarget.add([...event.dataTransfer.files]); } : undefined}
  ><ScrollArea className="min-h-0 flex-1" viewportClassName="h-full"><div ref={list} className="flex flex-col gap-3 p-4">
    {uploads ? <div className="flex flex-wrap items-center gap-2">
      <ArtifactUploadButton onFiles={uploads.add} disabledReason={runtimeAvailable ? null : openWorkspaceFirst} />
      <p className="text-caption text-muted-foreground">Files are saved to <span className="font-mono">uploads/</span> in this workspace, up to 1 GiB each. You can also drop files here.</p>
    </div> : null}
    {uploads ? <ArtifactUploadList uploads={uploads} /> : null}
    {!references.length ? <EmptyState icon={ic(Archive, 22)} title="No artifacts" description="Published workspace and project files appear here, whether or not they are attached as evidence." /> : <>
      {actions ? <><p className="text-caption text-muted-foreground">Select one or more published workspace files to copy. Select one project or workspace file to share.</p><ArtifactActions selected={selection} actions={actions} /></> : null}
      <CardGroup orientation="inline" border="outlined">{references.map((reference) => <Card key={artifactId(reference)} data-artifact-url={reference.url} selected={uploads?.highlighted.includes(reference.url) ?? false}>
        <CardMedia icon={reference.mediaType?.startsWith('image/') ? ImageGlyph : FileGlyph} />
        <CardHeader><CardTitle className="truncate">{reference.label}</CardTitle><CardDescription className="truncate font-mono">{reference.url}</CardDescription></CardHeader>
        <CardFooter className="flex-wrap gap-2">
          {actions ? <Button variant={selected.includes(reference.url) ? 'secondary' : 'ghost'} size="compact" className="min-h-10" aria-pressed={selected.includes(reference.url)} onClick={() => setSelected((current) => current.includes(reference.url) ? current.filter((url) => url !== reference.url) : [...current, reference.url])}>{selected.includes(reference.url) ? 'Selected' : 'Select'}<span className="sr-only"> {reference.label}</span></Button> : null}
          <Button variant="ghost" size="compact" className="min-h-10" onClick={() => onOpen(reference)}>Open<span className="sr-only"> {reference.label}</span></Button>
          <span className="text-caption text-muted-foreground tabular-nums">generation {reference.generation}</span>
        </CardFooter>
      </Card>)}</CardGroup>
    </>}
  </div></ScrollArea></div>;
}

function SubagentsSurface({ subagents, onStop, renderTranscript }: { subagents: InspectorProps['subagents']; onStop?: InspectorProps['onStopSubagent']; renderTranscript?: InspectorProps['renderSubagentTranscript'] }) {
  const [stopping, setStopping] = useState<readonly string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const stop = async (id: string) => {
    if (!onStop || stopping.includes(id)) return;
    setError(null); setStopping(values => [...values, id]);
    try { await onStop(id); }
    catch (cause) { setError(rpcErrorMessage(cause, 'Stop subagent')); }
    finally { setStopping(values => values.filter(value => value !== id)); }
  };
  if (!subagents.length) return <Padded><EmptyState icon={ic(Users01, 22)} title="No delegated work" description="Subagents from the canonical agent transcript appear here while they run and after they yield." /></Padded>;
  return <ScrollArea className="min-h-0 flex-1" viewportClassName="h-full"><div className="p-4">{error ? <p role="alert" className="mb-3 text-destructive">{error}</p> : null}<CardGroup border="outlined">{subagents.map((agent) => {
    const model = agent.type === 'side-agent' && agent.runtime?.model ? `${agent.runtime.model.modelId} (${agent.runtime.model.provider})` : agent.model;
    return <Card key={agent.id}>
    <CardHeader><CardMedia icon={UsersGlyph} /><CardTitle>{agent.label}</CardTitle><CardDescription>{agent.type === 'side-agent' && agent.runtime ? <><span aria-label="Role">Role: {agent.runtime.role ?? 'Not selected'}</span> · <span aria-label="Model">Model: {model ?? 'Not admitted'}</span></> : [agent.agent ?? 'subagent', model, agent.status].filter(Boolean).join(' · ')}</CardDescription><CardAction className="flex flex-wrap gap-1"><Tone value={agent.status} />{agent.type === 'side-agent' && onStop && (agent.status === 'running' || agent.status === 'blocked') ? <Button variant="secondary" size="compact" aria-label={`Stop ${agent.label}`} disabled={stopping.includes(agent.agentId)} onClick={() => void stop(agent.agentId)}>{stopping.includes(agent.agentId) ? 'Stopping…' : 'Stop'}</Button> : null}{agent.type === 'execution' && agent.hasFailures && agent.status !== 'failed' ? <Badge variant="dot" color="red">Failure in history</Badge> : null}</CardAction></CardHeader>
    {agent.summary ? <CardContent><GitSpaceMarkdown>{agent.summary}</GitSpaceMarkdown></CardContent> : null}
    {agent.type === 'side-agent' && agent.runtime ? <CardContent>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 text-caption">
        <dt className="text-muted-foreground">Selected role</dt><dd>{agent.runtime.role ?? 'No role selected'}</dd>
        <dt className="text-muted-foreground">Admitted model</dt><dd className="break-all">{model ?? 'No model admitted'}</dd>
        {agent.runtime.definition ? <><dt className="self-center text-muted-foreground">Definition revision</dt><dd><InputCopy value={agent.runtime.definition.revision} displayValue={shortHash(agent.runtime.definition.revision)} className="max-w-48" /></dd></> : null}
      </dl>
      {agent.runtime.definition ? <details><summary className="min-h-10 cursor-pointer py-2 text-caption">Retained definition · read-only</summary><p className="mb-2 break-all font-mono text-caption text-muted-foreground">{agent.runtime.definition.path}</p><pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words font-mono text-caption">{agent.runtime.definition.content}</pre></details> : null}
    </CardContent> : null}
    {agent.type === 'side-agent' && renderTranscript ? <CardContent><Button variant="ghost" aria-expanded={expanded === agent.agentId} onClick={() => setExpanded(value => value === agent.agentId ? null : agent.agentId)}>{expanded === agent.agentId ? 'Hide transcript' : 'View transcript'}</Button>{expanded === agent.agentId ? renderTranscript(agent.agentId) : null}</CardContent> : agent.type === 'side-agent' && agent.messages?.length ? <CardContent><details><summary className="min-h-10 cursor-pointer py-2 text-caption">Conversation history</summary><div className="flex min-w-0 flex-col gap-2">{agent.messages.map(message => <TranscriptItemView key={message.id} item={message} active={false} />)}</div></details></CardContent> : null}
  </Card>; })}</CardGroup></div></ScrollArea>;
}
function ServicesSurface({ services, onOpenTerminal, onStart, onStop }: {
  services: readonly ServiceView[];
  onOpenTerminal?: (name: string) => void;
  onStart?: InspectorProps['onStartService'];
  onStop?: InspectorProps['onStopService'];
}) {
  const shape = useShape();
  const [selectedId, setSelectedId] = useState<string | null>(services[0]?.id ?? null);
  useEffect(() => setSelectedId((current) => services.some((service) => service.id === current) ? current : services[0]?.id ?? null), [services]);
  const selected = services.find((service) => service.id === selectedId) ?? null;
  if (!selected) return <Padded><EmptyState icon={ic(Play, 22)} title="No workspace services" description="Declare services in .gitspace/services.json. GitSpace assigns stable local ports and runs them through OMP Hub." /></Padded>;
  const running = selected.state !== 'stopped' && selected.state !== 'exited' && selected.state !== 'failed';
  return <ScrollArea className="min-h-0 flex-1" viewportClassName="h-full"><div className="flex flex-col gap-4 p-4">
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2"><SectionTitle>Services</SectionTitle><span className="text-caption text-muted-foreground tabular-nums">{services.filter((service) => service.state === 'running' || service.state === 'ready').length} running</span></div>
      <CardGroup orientation="inline" border="outlined">{services.map((service) => <Card size="compact" selected={service.id === selected.id} onClick={() => setSelectedId(service.id)} label={service.name} key={service.id}>
        <CardMedia icon={ServerGlyph} />
        <CardHeader><CardTitle className="flex items-center gap-2"><StatusDot color={serviceDot(service.state)} />{service.name}</CardTitle><CardDescription className="tabular-nums">{service.port ? `:${service.port}` : service.state}</CardDescription></CardHeader>
        <CardFooter><Tone value={service.state} /></CardFooter>
      </Card>)}</CardGroup>
    </section>
    <section className="flex flex-col gap-3">
      <header className="flex flex-col gap-1"><span><Tone value={selected.state} /></span><Heading>{selected.name}</Heading><p className="text-body text-muted-foreground tabular-nums">Workspace generation {selected.generation}</p></header>
      <code className={`${shape.container} block overflow-auto bg-surface-1 p-3 font-mono text-caption text-foreground`}>{selected.command}</code>
      <CardGroup columns={2} separated border="outlined">
        <MetaCard label="Endpoint"><span className="truncate">{selected.url ?? 'Allocated when started'}</span></MetaCard>
        <MetaCard label="Port">{selected.port ?? '—'}</MetaCard>
        <MetaCard label="Started">{selected.startedAt ? formatDate(selected.startedAt) : 'Not started'}</MetaCard>
        <MetaCard label="Exit">{selected.exitCode ?? '—'}</MetaCard>
      </CardGroup>
      <div className="flex flex-wrap gap-2">
        {selected.url ? <Button variant="secondary" size="compact" asChild><a href={selected.url} target="_blank" rel="noreferrer">{ic(LinkExternal01, 14)}Open service</a></Button> : null}
        {running ? <Button variant="secondary" size="compact" type="button" onClick={() => settle(onStop?.(selected.name) ?? Promise.resolve())}>Stop</Button> : <Button variant="secondary" size="compact" type="button" onClick={() => settle(onStart?.(selected.name) ?? Promise.resolve())}>Start</Button>}
        {running ? <Button variant="secondary" size="compact" type="button" onClick={() => onOpenTerminal?.(selected.terminalName)}>{ic(Terminal, 14)}Open logs</Button> : null}
      </div>
    </section>
  </div></ScrollArea>;
}

function GuideFileDiffBlock({ path, anchorKey, root, baseRef, threads, gateOpened, onGateOpen, onOpenFile, onLoadDiff, onSelectThread, onSelectRange }: {
  path: string;
  anchorKey: string;
  root: { current: HTMLDivElement | null };
  baseRef: string;
  threads: readonly ReviewThreadView[];
  gateOpened: boolean;
  onGateOpen(path: string): void;
  onOpenFile(path: string): void;
  onLoadDiff(path: string, mode: 'base', baseRef: string): Promise<RepositoryDiffView>;
  onSelectThread(thread: ReviewThreadView): void;
  onSelectRange(selection: ThreadSelection): void;
}) {
  const shape = useShape();
  const runtimeAvailable = useContext(RuntimeAvailability);
  const hostRef = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  const [requested, setRequested] = useState(false);
  const [diff, setDiff] = useState<RepositoryDiffView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [height, setHeight] = useState(120);
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !runtimeAvailable) return;
    const observer = new IntersectionObserver(([entry]) => {
      const next = !!entry?.isIntersecting;
      setNear(next);
      if (next) setRequested(true);
    }, { root: root.current, rootMargin: '1200px 0px', threshold: 0 });
    observer.observe(host);
    return () => observer.disconnect();
  }, [root, runtimeAvailable]);
  useEffect(() => {
    setDiff(null);
    setError(null);
    if (!runtimeAvailable || !requested) return;
    let active = true;
    void onLoadDiff(path, 'base', baseRef).then((loaded) => {
      if (!active) return;
      if (loaded.path !== path || loaded.mode !== 'base') throw new Error('The diff response does not match this guide exhibit.');
      setDiff(loaded);
    }).catch((cause: unknown) => { if (active) setError(rpcErrorMessage(cause, 'inspector.repository.diff')); });
    return () => { active = false; };
  }, [requested, path, baseRef, runtimeAvailable]);
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !near) return;
    const observer = new ResizeObserver(() => setHeight(Math.max(120, Math.round(host.getBoundingClientRect().height))));
    observer.observe(host);
    return () => observer.disconnect();
  }, [near, diff, gateOpened]);
  const large = diff ? new TextEncoder().encode(diff.patch).byteLength > 60_000 : false;
  // Off-screen blocks keep their last measured height so the walkthrough's scroll position holds while they unmount.
  if (!runtimeAvailable) return <div data-guide-anchor={anchorKey} className={`${shape.container} flex flex-col overflow-hidden border border-border`}><Tooltip content={openWorkspaceFirst}><span><Button variant="ghost" size="compact" type="button" disabled className="w-full justify-start">{ic(FileCode02, 14)}<span className="truncate font-mono">{path}</span></Button></span></Tooltip><Placeholder>Saved file reference. {openWorkspaceFirst} to inspect its diff.</Placeholder></div>;
  if (diff && !near) return <div ref={hostRef} data-guide-anchor={anchorKey} style={{ height }} />;
  return <div ref={hostRef} data-guide-anchor={anchorKey} className={`${shape.container} flex flex-col overflow-hidden border border-border`}>
    <Button variant="ghost" size="compact" type="button" className="w-full justify-start border-b border-border" onClick={() => onOpenFile(path)}>{ic(FileCode02, 14)}<span className="truncate font-mono">{path}</span></Button>
    {!requested ? <Placeholder>Diff loads when it approaches the reading viewport.</Placeholder>
      : error ? <Placeholder><span className="text-destructive">{error}</span></Placeholder>
        : !diff ? <div className="flex min-h-28 items-center justify-center"><ThinkingIndicator aria-label="Loading diff…" /></div>
          : large && !gateOpened ? <Placeholder><Button variant="secondary" size="compact" type="button" onClick={() => onGateOpen(path)}>Large diff · {(new TextEncoder().encode(diff.patch).byteLength / 1024).toFixed(0)} KB · Click to render</Button></Placeholder>
            : <PierreViewer path={path} identities={diffIdentities(diff, path)} patch={diff.patch} threads={threads} onSelectThread={onSelectThread} onSelectRange={onSelectRange} />}
  </div>;
}

function GuideWalkthroughSection({ section, index, root, baseRef, done, openedGates, onSectionRef, onToggleDone, onGateOpen, onOpenFile, onLoadDiff, threads, onSelectThread, onSelectRange }: {
  section: ChangeGuideView['sections'][number];
  index: number;
  root: { current: HTMLDivElement | null };
  baseRef: string;
  done: boolean;
  openedGates: Set<string>;
  onSectionRef(index: number, element: HTMLElement | null): void;
  onToggleDone(): void;
  onGateOpen(path: string): void;
  onOpenFile(path: string): void;
  onLoadDiff(path: string, mode: 'base', baseRef: string): Promise<RepositoryDiffView>;
  threads: readonly ReviewThreadView[];
  onSelectThread(thread: ReviewThreadView): void;
  onSelectRange(selection: ThreadSelection): void;
}) {
  return <AccordionItem value={section.id} ref={(element) => onSectionRef(index, element)} data-guide-anchor={`s${index}`}>
    <AccordionTrigger>{`${done ? '✓' : index + 1} · ${section.title}`}</AccordionTrigger>
    <AccordionContent>
      <div className="flex flex-col gap-3 pb-2">
        <div className="flex flex-wrap items-center gap-2"><Badge variant="dot" color={done ? 'green' : 'gray'}>{section.kind}</Badge><span className="text-caption text-muted-foreground tabular-nums">{section.exhibits.length} file{section.exhibits.length === 1 ? '' : 's'}</span><Button variant={done ? 'ghost' : 'secondary'} size="compact" type="button" className="ml-auto" disabled={done} onClick={onToggleDone}>{done ? <>{ic(Check, 14)}Complete</> : 'Mark complete'}</Button></div>
        <div className="flex flex-col gap-2"><GitSpaceMarkdown>{section.explanation}</GitSpaceMarkdown>{section.why ? <GitSpaceMarkdown>{`**Why:** ${section.why}`}</GitSpaceMarkdown> : null}</div>
        <div className="flex flex-col gap-3">{section.exhibits.length ? section.exhibits.map((exhibit) => <div className="flex flex-col gap-1" key={`${baseRef}:${exhibit.path}`}>{exhibit.slowRead ? <p className="flex flex-wrap items-center gap-2 text-caption text-muted-foreground"><Badge variant="dot" color="amber">slow read</Badge>{exhibit.note || 'Reviewer attention requested.'}</p> : null}<GuideFileDiffBlock path={exhibit.path} anchorKey={`f${index}:${exhibit.path}`} root={root} baseRef={baseRef} threads={threads} gateOpened={openedGates.has(exhibit.path)} onGateOpen={onGateOpen} onOpenFile={onOpenFile} onLoadDiff={onLoadDiff} onSelectThread={onSelectThread} onSelectRange={onSelectRange} /></div>) : <Placeholder>No file exhibits in this section.</Placeholder>}</div>
      </div>
    </AccordionContent>
  </AccordionItem>;
}

function ChangeGuideSurface({ guide, reviewerId, threads, onOpenFile, onLoadDiff, onSelectThread, onSelectRange, onMarkRead, onGenerate }: {
  guide: ChangeGuideView | null;
  reviewerId: string;
  threads: readonly ReviewThreadView[];
  onOpenFile(path: string): void;
  onLoadDiff(path: string, mode: 'base', baseRef: string): Promise<RepositoryDiffView>;
  onSelectThread(thread: ReviewThreadView): void;
  onSelectRange(selection: ThreadSelection): void;
  onMarkRead: InspectorProps['onMarkGuideSectionRead'];
  onGenerate?: InspectorProps['onGenerateChangeGuide'];
}) {
  const viewKey = guide ? `${guide.projectId}:${guide.spaceId}:${guide.revision}` : 'empty';
  const cached = guideViewCache.get(viewKey);
  const [active, setActive] = useState(cached?.active ?? 0);
  const [open, setOpen] = useState<string[]>(() => { const id = guide?.sections[cached?.active ?? 0]?.id; return id ? [id] : []; });
  const scrollRef = useRef<HTMLDivElement>(null);
  const sectionRefs = useRef<Array<HTMLElement | null>>([]);
  const [openedGates, setOpenedGates] = useState(new Set(cached?.openedGates ?? []));
  const reviewer = guide?.reviewerStates.find((state) => state.reviewerId === reviewerId) ?? null;
  const stale = !!guide && !!reviewer && (reviewer.revision !== guide.revision || reviewer.headCommit !== guide.headCommit);
  const readIds = stale ? new Set<string>() : new Set(reviewer?.readSectionIds ?? []);
  const activeSection = guide?.sections[active] ?? null;
  useEffect(() => {
    const root = scrollRef.current;
    const anchor = cached?.anchor;
    if (!root || !anchor) return;
    let frame = 0;
    let still = 0;
    const settle = (): void => {
      const element = root.querySelector<HTMLElement>(`[data-guide-anchor="${anchor.key}"]`);
      if (element) {
        const delta = element.getBoundingClientRect().top - root.getBoundingClientRect().top - anchor.offset;
        if (Math.abs(delta) > 1) { root.scrollTop += delta; still = 0; } else still += 1;
      }
      if (still < 30 && frame++ < 480) requestAnimationFrame(settle);
    };
    requestAnimationFrame(settle);
  }, [viewKey]);
  useEffect(() => () => {
    const root = scrollRef.current;
    let anchor: GuideViewState['anchor'] = null;
    if (root) {
      const top = root.getBoundingClientRect().top;
      for (const element of root.querySelectorAll<HTMLElement>('[data-guide-anchor]')) {
        const offset = element.getBoundingClientRect().top - top;
        if (offset > 1) break;
        anchor = { key: element.dataset.guideAnchor!, offset };
      }
    }
    guideViewCache.set(viewKey, { active, anchor, openedGates: new Set(openedGates) });
  }, [viewKey, active, openedGates]);
  if (!guide || !activeSection) return <Padded><EmptyState icon={ic(File02, 22)} title="No Change Guide" description="Ask the canonical agent to delegate a narrator grounded in the Journal and current diff." action={onGenerate ? <Button variant="secondary" size="compact" type="button" onClick={() => settle(onGenerate())}>Generate Change Guide</Button> : undefined} /></Padded>;
  const go = (index: number): void => {
    setActive(index);
    let frame = 0;
    const converge = (): void => {
      const root = scrollRef.current;
      const section = sectionRefs.current[index];
      if (!root || !section) return;
      const delta = section.getBoundingClientRect().top - root.getBoundingClientRect().top - 6;
      if (Math.abs(delta) > 1) root.scrollTop += delta;
      if (frame++ < 480 && Math.abs(delta) > 1) requestAnimationFrame(converge);
    };
    requestAnimationFrame(converge);
  };
  const onOpenChange = (next: string[]): void => {
    const opened = next.find((id) => !open.includes(id));
    setOpen(next);
    if (opened) { const index = guide.sections.findIndex((section) => section.id === opened); if (index >= 0) go(index); }
  };
  return <div className="flex min-h-0 flex-1 flex-col">
    <header className="flex items-center justify-between gap-2 px-4 pb-2 pt-4">
      <span className="flex min-w-0 flex-col"><Kicker>Change Guide · the PR as a story</Kicker><span className="text-caption text-muted-foreground tabular-nums">{readIds.size} / {guide.sections.length} phases reviewed</span></span>
      <Badge variant="dot" color={readIds.size === guide.sections.length ? 'green' : 'gray'}>{activeSection.kind}</Badge>
    </header>
    <ScrollArea ref={(element) => { scrollRef.current = element?.querySelector<HTMLDivElement>('[data-slot="scroll-area-viewport"]') ?? null; }} className="min-h-0 flex-1" viewportClassName="h-full">
      <div className="px-3 pb-6">
        <Accordion type="multiple" value={open} onValueChange={onOpenChange} className="w-full">
          {guide.sections.map((section, index) => <GuideWalkthroughSection section={section} index={index} root={scrollRef} baseRef={guide.baseRef} done={readIds.has(section.id)} openedGates={openedGates} onSectionRef={(sectionIndex, element) => { sectionRefs.current[sectionIndex] = element; }} onToggleDone={() => { if (!readIds.has(section.id)) settle(onMarkRead(section.id, guide.revision, guide.headCommit)); }} onGateOpen={(path) => setOpenedGates((current) => new Set(current).add(path))} onOpenFile={onOpenFile} onLoadDiff={onLoadDiff} threads={threads} onSelectThread={onSelectThread} onSelectRange={onSelectRange} key={section.id} />)}
        </Accordion>
      </div>
    </ScrollArea>
  </div>;
}

function JournalEvidence({ reference, content, status, error, onLoad, onOpen }: {
  reference: EvidenceReference;
  content: InspectorArtifactContent | null;
  status: LoadStatus;
  error: string | undefined;
  onLoad(reference: ArtifactReference): Promise<void>;
  onOpen(reference: EvidenceReference): void;
}) {
  const runtimeAvailable = useContext(RuntimeAvailability);
  useEffect(() => { if (reference.kind === 'artifact' && status === undefined) void onLoad(reference); }, [reference, status]);
  if (!runtimeAvailable && reference.kind === 'git') return <Tooltip content={openWorkspaceFirst}><div><Card size="compact"><CardMedia icon={FileGlyph} /><CardHeader><CardTitle className="truncate">{reference.label}</CardTitle><CardDescription>{reference.path} · {shortHash(reference.commitId)} · saved reference</CardDescription></CardHeader></Card></div></Tooltip>;
  if (reference.kind !== 'artifact') return <Card size="compact" onClick={() => onOpen(reference)} label={`Open ${reference.label}`}><CardMedia icon={FileGlyph} /><CardHeader><CardTitle className="truncate">{reference.label}</CardTitle><CardDescription className="truncate tabular-nums">{reference.kind === 'git' ? `${reference.path} · ${shortHash(reference.commitId)}` : reference.kind === 'command' ? `${reference.command} · exit ${reference.exitCode}` : `Review thread ${reference.threadId}`}</CardDescription></CardHeader></Card>;
  if (reference.mediaType?.startsWith('image/')) return <Card size="compact" onClick={() => onOpen(reference)} label={`Open ${reference.label}`}>{content ? <CardImage src={content.previewUrl} alt={reference.label} /> : <CardMedia icon={ImageGlyph} />}<CardHeader><CardTitle className="truncate">{reference.label}</CardTitle>{!content ? <CardDescription>{status === 'error' ? error ?? 'Image failed to load' : `Loading ${reference.label}…`}</CardDescription> : null}</CardHeader></Card>;
  if ((reference.mediaType === 'text/markdown' || reference.url.endsWith('.md')) && content?.source) return <Card size="compact" onClick={() => onOpen(reference)} label={`Open ${reference.label}`}><CardMedia icon={FileGlyph} /><CardHeader><CardTitle className="truncate">{reference.label}</CardTitle><CardDescription className="line-clamp-3">{content.source.split('\n').filter(Boolean).slice(0, 4).join(' ')}</CardDescription></CardHeader></Card>;
  return <Card size="compact" onClick={() => onOpen(reference)} label={`Open ${reference.label}`}><CardMedia icon={FileGlyph} /><CardHeader><CardTitle className="truncate">{reference.label}</CardTitle><CardDescription className="truncate tabular-nums">{status === 'error' ? error ?? 'Artifact failed to load' : `${reference.mediaType ?? 'artifact'} · generation ${reference.generation}`}</CardDescription></CardHeader></Card>;
}

type JournalFilter = 'all' | 'narrative' | 'decision' | 'artifact' | 'phase';
const journalFilters: ReadonlyArray<{ id: JournalFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'narrative', label: 'Narrative' },
  { id: 'decision', label: 'Decisions' },
  { id: 'artifact', label: 'Artifacts' },
  { id: 'phase', label: 'Phases' },
];
function journalMatches(entry: JournalEntryView, filter: JournalFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'phase') return entry.kind === 'phase-start' || entry.kind === 'phase-end';
  return entry.kind === filter;
}
function journalIcon(kind: JournalEntryView['kind']): IconName {
  if (kind === 'phase-start') return 'play';
  if (kind === 'phase-end') return 'check';
  if (kind === 'decision') return 'lightbulb';
  if (kind === 'artifact') return 'folder';
  return 'message-circle';
}
function JournalSurface({ entries, artifactContent, artifactLoad, artifactErrors, onLoadArtifact, onOpenEvidence }: {
  entries: readonly JournalEntryView[];
  artifactContent: Readonly<Record<string, InspectorArtifactContent>>;
  artifactLoad: Readonly<Record<string, 'loading' | 'loaded' | 'error'>>;
  artifactErrors: Readonly<Record<string, string>>;
  onLoadArtifact(reference: ArtifactReference): Promise<void>;
  onOpenEvidence(reference: EvidenceReference): void;
}) {
  const [filter, setFilter] = useState(0);
  const visible = useMemo(() => { const active = journalFilters[filter]?.id ?? 'all'; return [...entries].reverse().filter((entry) => journalMatches(entry, active)); }, [entries, filter]);
  return <div className="flex min-h-0 flex-1 flex-col">
    <header className="flex flex-col gap-2 px-4 pb-2 pt-4">
      <div className="flex items-start justify-between gap-3"><span className="flex min-w-0 flex-col gap-1"><Heading>Timeline</Heading><p className="text-caption text-muted-foreground">Goal decisions, phase transitions, and evidence in one chronological log.</p></span><span className="shrink-0 text-caption text-muted-foreground tabular-nums">{visible.length} of {entries.length}</span></div>
      <TabsSubtle size="compact" selectedIndex={filter} onSelect={setFilter} aria-label="Journal filter">{journalFilters.map((item, index) => <TabsSubtleItem index={index} label={item.label} key={item.id} />)}</TabsSubtle>
    </header>
    <ScrollArea className="min-h-0 flex-1" viewportClassName="h-full"><div className="px-3 pb-6">
      {visible.length ? <ThinkingSteps defaultOpen>
        <ThinkingStepsHeader>{`Timeline · ${visible.length}`}</ThinkingStepsHeader>
        <ThinkingStepsContent>{visible.map((entry, index) => {
          const phase = entry.kind === 'phase-start' || entry.kind === 'phase-end';
          const meta = [formatDate(entry.createdAt), entry.kind, entry.phase].filter(Boolean).join(' · ');
          return <ThinkingStep icon={journalIcon(entry.kind)} label={entry.title} description={meta} status="complete" isLast={index === visible.length - 1} key={entry.id}>
            {phase ? null : <ThinkingStepDetails summary="Details">
              <div className="flex min-w-0 flex-col gap-2 pt-1">
                <GitSpaceMarkdown>{entry.body}</GitSpaceMarkdown>
                {entry.outcome ? <p className="text-body text-muted-foreground"><span className="font-medium text-foreground">Outcome · </span>{entry.outcome}</p> : null}
                {entry.decisions.length ? <ul className="flex flex-col gap-1">{entry.decisions.map((decision, decisionIndex) => <li className="flex items-start gap-1.5 text-body text-muted-foreground" key={decisionIndex}><span className="mt-0.5 shrink-0 text-foreground">{ic(Check, 14)}</span>{decision}</li>)}</ul> : null}
                {entry.delta ? <div className="flex flex-wrap gap-1"><Badge size="compact"><span className="tabular-nums">{entry.delta.requirementsAdvanced.length}</span>&nbsp;requirements advanced</Badge><Badge size="compact"><span className="tabular-nums">{entry.delta.evidenceAdded.length}</span>&nbsp;evidence added</Badge><Badge size="compact"><span className="tabular-nums">{entry.delta.workflowNodesChanged.length}</span>&nbsp;workflow changes</Badge><Badge size="compact"><span className="tabular-nums">{entry.delta.threadsResolved}</span>&nbsp;threads resolved</Badge></div> : null}
                {entry.evidence.length ? <CardGroup border="outlined">{entry.evidence.map((reference, evidenceIndex) => <JournalEvidence reference={reference} content={reference.kind === 'artifact' ? artifactContent[artifactId(reference)] ?? null : null} status={reference.kind === 'artifact' ? artifactLoad[artifactId(reference)] : undefined} error={reference.kind === 'artifact' ? artifactErrors[artifactId(reference)] : undefined} onLoad={onLoadArtifact} onOpen={onOpenEvidence} key={`${entry.id}:${evidenceIndex}`} />)}</CardGroup> : null}
              </div>
            </ThinkingStepDetails>}
          </ThinkingStep>;
        })}</ThinkingStepsContent>
      </ThinkingSteps> : <Placeholder>No matching timeline entries.</Placeholder>}
    </div></ScrollArea>
  </div>;
}

export function Inspector(props: InspectorProps) {
  const runtimeAvailable = props.runtimeAvailable ?? true;
  const [view, setView] = useState<ActiveView>(props.initialView ?? 'goal');
  const [agentSetupDirty, setAgentSetupDirty] = useState(false);
  useEffect(() => { if (props.initialView) setView(props.initialView); }, [props.initialView]);
  const [documents, setDocuments] = useState<InspectorOpenDocument[]>([]);
  const [activeDocumentId, setActiveDocumentId] = useState<string | null>(null);
  const [fileModes, setFileModes] = useState<Record<string, RepositoryMode>>({});
  const [artifactModeById, setArtifactModeById] = useState<Record<string, 'preview' | 'source'>>({});
  const [changedOnly, setChangedOnly] = useState(false);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const activeThread = props.threads.find((thread) => thread.id === activeThreadId) ?? null;
  const setActiveThread = (thread: ReviewThreadView | null): void => setActiveThreadId(thread?.id ?? null);
  const [threadSelection, setThreadSelection] = useState<ThreadSelection | null>(null);
  const [artifactContent, setArtifactContent] = useState<Record<string, InspectorArtifactContent>>({});
  const [artifactLoad, setArtifactLoad] = useState<Record<string, 'loading' | 'loaded' | 'error'>>({});
  const [artifactErrors, setArtifactErrors] = useState<Record<string, string>>({});
  const artifactCache = useRef(new Map<string, InspectorArtifactContent>());
  const artifactRequests = useRef(new Map<string, AbortController>());
  const uploads = useArtifactUploads(props.artifactUpload);
  useEffect(() => {
    setArtifactContent({});
    setArtifactLoad({});
    setArtifactErrors({});
    return () => {
      for (const controller of artifactRequests.current.values()) controller.abort();
      artifactRequests.current.clear();
      for (const content of artifactCache.current.values()) content.dispose?.();
      artifactCache.current.clear();
    };
  }, [props.overview.spaceId]);
  const evidence = useMemo(() => collectEvidence(props.overview, props.journalEntries), [props.journalEntries, props.overview]);
  const artifacts = useMemo(() => {
    const listed = props.artifactReferences ?? evidence.filter((reference): reference is ArtifactReference => reference.kind === 'artifact');
    // Committed uploads show immediately; the catalog lists them once background publication finishes.
    return [...listed, ...uploads.uploaded.filter((upload) => !listed.some((reference) => reference.url === upload.url))];
  }, [evidence, props.artifactReferences, uploads.uploaded]);
  const activeDocument = documents.find((document) => document.id === activeDocumentId) ?? null;
  const activeMode = activeDocument ? fileModes[activeDocument.id] ?? 'current' : 'current';
  const displayedFile = activeDocument?.kind === 'file' && activeMode === 'current' && props.repositoryFile?.path === activeDocument.target && props.repositoryFile.mode === activeMode ? props.repositoryFile : null;
  const displayedDiff = activeDocument?.kind === 'file' && activeMode !== 'current' && props.repositoryDiff?.path === activeDocument.target && props.repositoryDiff.mode === activeMode ? props.repositoryDiff : null;
  const activeArtifact = activeDocument?.kind === 'artifact'
    ? activeDocument.target.startsWith('current:')
      ? artifacts.find((reference) => reference.url === activeDocument.target.slice(8)) ?? null
      : [...artifacts, ...evidence.filter((reference): reference is ArtifactReference => reference.kind === 'artifact')].find((reference) => artifactId(reference) === activeDocument.target) ?? null
    : null;
  // Read recorded usage when requested, not on every Inspector mount.
  useEffect(() => { if (runtimeAvailable && view === 'usage') props.usage.load(); }, [view, runtimeAvailable]);
  useEffect(() => { if (runtimeAvailable && view === 'agents') props.agentSetup.load(); }, [view, runtimeAvailable, props.agentSetup.sessionId]);
  const loadArtifact = async (reference: ArtifactReference): Promise<void> => {
    const key = artifactId(reference);
    if (artifactRequests.current.has(key) || artifactCache.current.has(key)) return;
    const controller = new AbortController();
    artifactRequests.current.set(key, controller);
    setArtifactLoad((current) => ({ ...current, [key]: 'loading' }));
    try {
      const content = await props.onRequestArtifact(reference, controller.signal);
      if (controller.signal.aborted) { content.dispose?.(); return; }
      artifactCache.current.get(key)?.dispose?.();
      artifactCache.current.set(key, content);
      setArtifactContent((current) => ({ ...current, [key]: content }));
      setArtifactLoad((current) => ({ ...current, [key]: 'loaded' }));
    } catch (error) {
      if (controller.signal.aborted) return;
      setArtifactErrors((current) => ({ ...current, [key]: rpcErrorMessage(error, 'inspector.artifacts.read') }));
      setArtifactLoad((current) => ({ ...current, [key]: 'error' }));
    } finally {
      if (artifactRequests.current.get(key) === controller) artifactRequests.current.delete(key);
    }
  };
  useEffect(() => { if (activeArtifact) void loadArtifact(activeArtifact); }, [props.overview.spaceId, activeArtifact ? artifactId(activeArtifact) : null]);
  const selectSurface = (next: InspectorPermanentView): void => { setView(next); setActiveDocumentId(null); setActiveThread(null); setThreadSelection(null); };
  const openDocument = (document: InspectorOpenDocument): void => { setDocuments((current) => current.some((item) => item.id === document.id) ? current : [...current, document]); setActiveDocumentId(document.id); setView('document'); setActiveThread(null); setThreadSelection(null); };
  const openProduct = (kind: 'goal' | 'workflow' | 'rubric'): void => { const record = kind === 'goal' ? props.overview.goal : kind === 'workflow' ? props.overview.workflow : props.overview.rubric; if (record) openDocument({ id: `${kind}:${record.id}`, kind, label: record.title, target: record.id }); };
  const openResource = ({ uri }: ResourceRequest): void => openDocument({ id: `resource:${uri}`, kind: 'resource', label: fileName(uri), target: uri });
  useEffect(() => { if (props.resourceRequest) openResource(props.resourceRequest); }, [props.resourceRequest]);
  const openEvidence = (reference: EvidenceReference): void => {
    if (reference.kind === 'artifact') {
      openDocument({ id: `artifact:${artifactId(reference)}`, kind: 'artifact', label: reference.label, target: artifactId(reference) });
      void loadArtifact(reference);
    } else if (reference.kind === 'git') {
      if (runtimeAvailable) openFile(reference.path, 'current');
    } else if (reference.kind === 'review-thread') {
      const thread = props.threads.find((candidate) => candidate.id === reference.threadId);
      if (thread) { setActiveThread(thread); setThreadSelection(null); }
    }
  };
  const openFile = (path: string, mode: RepositoryMode): void => { const id = `file:${path}`; setFileModes((current) => ({ ...current, [id]: mode })); openDocument({ id, kind: 'file', label: fileName(path), target: path }); if (mode === 'current') props.onRequestRepositoryFile(path, mode); else props.onRequestRepositoryDiff(path, mode); };
  const closeDocument = (id: string): void => { setDocuments((current) => { const next = current.filter((document) => document.id !== id); if (activeDocumentId === id) { const nextActive = next.at(-1)?.id ?? null; setActiveDocumentId(nextActive); setView(nextActive ? 'document' : 'goal'); } return next; }); setActiveThread(null); setThreadSelection(null); };
  const chooseMode = (mode: RepositoryMode): void => { if (!activeDocument || activeDocument.kind !== 'file') return; setFileModes((current) => ({ ...current, [activeDocument.id]: mode })); if (mode === 'current') props.onRequestRepositoryFile(activeDocument.target, mode); else props.onRequestRepositoryDiff(activeDocument.target, mode); };
  const createThread = async (body: string): Promise<void> => {
    if (!threadSelection) throw new Error('Select a line before starting a review thread.');
    const { generation, baseCommit, headCommit, blobId } = threadSelection.identity;
    if (generation === undefined || !baseCommit || !headCommit) throw new Error('The displayed content is missing its review identity. Reload the view and select the line again.');
    const created = await props.onCreateThread({
      body,
      decision: 'pending',
      anchor: {
        kind: 'line',
        path: threadSelection.path,
        generation,
        baseCommit,
        headCommit,
        blobId,
        side: threadSelection.side,
        startLine: threadSelection.startLine,
        endLine: threadSelection.endLine,
      },
    });
    setActiveThreadId(created.id);
    setThreadSelection(null);
  };
  const counts: Partial<Record<InspectorPermanentView, number>> = { subagents: props.subagents.length, files: props.repositoryEntries.filter((entry) => entry.kind === 'file' && entry.status !== 'clean').length, artifacts: artifacts.length, services: props.runtimeServices === undefined ? props.services.length : undefined };
  for (const tab of permanentTabs) if (props.sectionErrors?.[tab.id] && !props.sectionErrors[tab.id]!.retained) delete counts[tab.id];
  const threadOpen = !!(activeThread || threadSelection);
  const closeThread = (): void => { setActiveThread(null); setThreadSelection(null); };
  const threadPanel = threadOpen ? <ThreadPanel
    thread={activeThread}
    selection={threadSelection}
    onClose={closeThread}
    onCreate={createThread}
    onReply={(body) => activeThread ? props.onReplyThread(activeThread.id, activeThread.revision, body) : Promise.resolve()}
    onResolve={(resolved, decision) => activeThread ? props.onResolveThread(activeThread.id, activeThread.revision, resolved, decision) : Promise.resolve()}
  /> : null;
  let documentBody: ReactNode = null;
  if (activeDocument?.kind === 'goal' && props.overview.goal) documentBody = <ProductGoal goal={props.overview.goal} onOpenEvidence={openEvidence} />;
  else if (activeDocument?.kind === 'workflow' && props.overview.workflow) documentBody = <WorkflowDocument workflow={props.overview.workflow} />;
  else if (activeDocument?.kind === 'rubric' && props.overview.rubric) documentBody = <RubricDocument rubric={props.overview.rubric} onOpenEvidence={openEvidence} onSubmit={props.onSubmitHumanJudgment} />;
  else if (activeDocument?.kind === 'resource') documentBody = <ResourceDocument key={`${props.overview.spaceId}:${activeDocument.target}`} uri={activeDocument.target} mode={artifactModeById[activeDocument.id] ?? 'preview'} onRequest={props.onRequestResource} artifactReferences={artifacts} artifactContent={artifactContent} onRequestArtifact={loadArtifact} />;
  else if (activeDocument?.kind === 'artifact' && activeArtifact) {
    documentBody = <ArtifactDocument
      reference={activeArtifact}
      content={artifactContent[artifactId(activeArtifact)] ?? null}
      status={artifactLoad[artifactId(activeArtifact)]}
      error={artifactErrors[artifactId(activeArtifact)]}
      mode={artifactModeById[artifactId(activeArtifact)] ?? 'preview'}
      artifactReferences={artifacts}
      artifactContent={artifactContent}
      onRequest={loadArtifact}
    />;
  } else if (activeDocument?.kind === 'file' && (displayedFile || displayedDiff)) {
    const currentIdentity = displayedFile ? { generation: displayedFile.generation, baseCommit: displayedFile.commitId, headCommit: displayedFile.headCommit, blobId: displayedFile.blobId } : null;
    documentBody = <PierreViewer path={activeDocument.target} identities={currentIdentity ? { base: currentIdentity, head: currentIdentity } : diffIdentities(displayedDiff!, activeDocument.target)} patch={displayedFile ? repositoryPatch(displayedFile) : displayedDiff!.patch} threads={props.threads} onSelectThread={(thread) => { setActiveThread(thread); setThreadSelection(null); }} onSelectRange={(selection) => { setThreadSelection(selection); setActiveThread(null); }} />;
  } else if (activeDocument) {
    documentBody = <Padded><EmptyState icon={ic(FileCode02, 22)} title="Loading repository view" description="The selected file mode will render when its generation-pinned response arrives." /></Padded>;
  }
  const activeArtifactMode = activeArtifact ? artifactModeById[artifactId(activeArtifact)] ?? 'preview' : activeDocument?.kind === 'resource' ? artifactModeById[activeDocument.id] ?? 'preview' : 'preview';
  const document = activeDocument ? <div className="flex min-h-0 flex-1 flex-col">
    <header className="flex items-center justify-between gap-3 px-4 pb-2 pt-3">
      <div className="flex min-w-0 flex-col"><strong className="truncate text-body font-medium text-foreground">{activeDocument.kind === 'file' ? activeDocument.target : activeDocument.label}</strong><span className="truncate text-caption text-muted-foreground tabular-nums">{activeDocument.kind === 'file' ? `${repositoryModes.find((mode) => mode.id === activeMode)?.label} · generation ${(displayedFile ?? displayedDiff)?.generation ?? '—'}` : activeDocument.kind === 'artifact' && activeArtifact ? `${activeArtifact.hash} · generation ${activeArtifact.generation}` : `${activeDocument.kind} authority record`}</span></div>
      {!runtimeAvailable && activeDocument.kind === 'artifact' ? <Tooltip content="Open this workspace on a machine before editing artifacts"><span className="shrink-0 text-caption text-muted-foreground">Read-only artifact</span></Tooltip> : null}
      {activeDocument.kind === 'artifact' && activeArtifact && props.artifactActions ? <ArtifactActions selected={[activeArtifact]} actions={props.artifactActions} /> : null}
    </header>
    {activeDocument.kind === 'file' ? <div className="flex items-center gap-2 px-4 pb-2"><Kicker>View</Kicker><TabsSubtle size="compact" className="min-w-0 flex-1" selectedIndex={Math.max(0, repositoryModes.findIndex((mode) => mode.id === activeMode))} onSelect={(index) => { const mode = repositoryModes[index]; if (mode) chooseMode(mode.id); }} aria-label="Repository view mode">{repositoryModes.map((mode, index) => <TabsSubtleItem index={index} label={mode.label} key={mode.id} />)}</TabsSubtle></div>
      : (activeDocument.kind === 'artifact' && activeArtifact) || activeDocument.kind === 'resource' ? <div className="flex items-center gap-2 px-4 pb-2"><Kicker>View</Kicker><TabsSubtle size="compact" selectedIndex={artifactModes.indexOf(activeArtifactMode)} onSelect={(index) => { const mode = artifactModes[index]; if (mode) setArtifactModeById((current) => ({ ...current, [activeArtifact ? artifactId(activeArtifact) : activeDocument.id]: mode })); }} aria-label="Artifact view mode">{artifactModes.map((mode, index) => <TabsSubtleItem index={index} label={mode} key={mode} />)}</TabsSubtle></div> : null}
    <div className="flex min-h-0 flex-1 flex-col border-t border-border">{documentBody}{threadPanel}</div>
  </div> : <Padded><EmptyState icon={ic(File02, 22)} title="Document is no longer available" description="Close this tab or reopen its canonical record from the permanent Inspector surfaces." /></Padded>;
  const renderSurface = (id: InspectorPermanentView): ReactNode => {
    if (!runtimeAvailable && runtimeViews[id] && id !== 'files') return <Padded><EmptyState title="Live workspace unavailable" description={openWorkspaceFirst} /></Padded>;
    const failure = props.sectionErrors?.[id];
    if (failure && !failure.retained && !(id === 'files' && props.repositoryMode === 'working' && props.lfsHeldBack?.length)) {
      const label = permanentTabs.find((tab) => tab.id === id)!.label;
      return <Padded><div role="alert"><EmptyState icon={ic(AlertCircle, 22)} title={`${label} could not load`} description={failure.message} action={<Button variant="ghost" type="button" onClick={failure.retry}>Retry {label}</Button>} /></div></Padded>;
    }
    switch (id) {
      case 'overview': return props.scope ? <OverviewView scope={props.scope} workspaces={props.workspaces} onSelectWorkspace={props.onSelectWorkspace} onSetRelations={props.onSetRelations} stackStatus={props.stackStatus} /> : null;
      case 'environment': return props.environment ?? <Padded><EmptyState icon={ic(Tool02, 22)} title="Workspace setup unavailable" description="This machine does not expose the workspace environment contract." /></Padded>;
      case 'goal': return <GoalOverview overview={props.overview} openDocuments={documents.length} onOpenProduct={openProduct} onOpenEvidence={openEvidence} />;
      case 'agents': return null;
      case 'subagents': return <SubagentsSurface subagents={props.subagents} onStop={props.onStopSubagent} renderTranscript={props.renderSubagentTranscript} />;
      case 'files': return <FilesSurface entries={props.repositoryEntries.filter((entry) => entry.mode === props.repositoryMode)} heldBack={props.repositoryMode === 'working' ? props.lfsHeldBack ?? [] : []} mode={props.repositoryMode} onModeChange={props.onRepositoryModeChange} changedOnly={changedOnly} setChangedOnly={setChangedOnly} onOpen={(entry) => openFile(entry.path, props.repositoryMode)} onOpenHeldBack={path => openFile(path, 'working')} />;
      case 'artifacts': return <ArtifactsSurface references={artifacts} onOpen={(reference) => {
        if (reference.kind !== 'artifact') return;
        openDocument({ id: `artifact-current:${reference.url}`, kind: 'artifact', label: reference.label, target: `current:${reference.url}` });
        void loadArtifact(reference);
      }} actions={props.artifactActions} uploads={props.artifactUpload ? uploads : null} />;
      case 'services': return props.runtimeServices ?? <ServicesSurface services={props.services} onOpenTerminal={(name) => props.onOpenServiceTerminal?.(name)} onStart={props.onStartService} onStop={props.onStopService} />;
      case 'usage': return <UsageView sessionId={props.usage.sessionId} report={props.usage.report} status={props.usage.status} error={props.usage.error} onLoad={props.usage.load} onRefresh={props.usage.refresh} providerUsage={props.usage.providerUsage} />;
      case 'guide': return <><ChangeGuideSurface
        guide={props.overview.changeGuide}
        reviewerId={props.reviewerId}
        threads={props.threads}
        onOpenFile={(path) => openFile(path, 'current')}
        onLoadDiff={(path, mode, baseRef) => props.onLoadRepositoryDiff(path, mode, baseRef)}
        onSelectThread={(thread) => { setActiveThread(thread); setThreadSelection(null); }}
        onSelectRange={(selection) => { setThreadSelection(selection); setActiveThread(null); }}
        onMarkRead={props.onMarkGuideSectionRead}
        onGenerate={runtimeAvailable ? props.onGenerateChangeGuide : undefined}
      />{threadPanel}</>;
      default: return <JournalSurface entries={props.journalEntries} artifactContent={artifactContent} artifactLoad={artifactLoad} artifactErrors={artifactErrors} onLoadArtifact={loadArtifact} onOpenEvidence={openEvidence} />;
    }
  };
  const tabIndex = view === 'document' ? -1 : permanentTabs.findIndex((tab) => tab.id === view);
  let body: ReactNode;
  if (props.loading) body = <div className="flex flex-1 items-center justify-center p-6"><ThinkingIndicator aria-label="Loading Inspector authority state…" /></div>;
  else if (props.error) body = <Padded><EmptyState icon={ic(AlertCircle, 22)} title="Inspector could not load" description={props.error} /></Padded>;
  else if (view === 'document') body = document;
  else body = permanentTabs.map((tab, index) => {
    if (tab.id === 'agents') return null;
    const failure = props.sectionErrors?.[tab.id];
    return <TabsSubtlePanel idPrefix="inspectorTabs" index={index} selectedIndex={tabIndex} className="flex min-h-0 flex-1 flex-col" key={tab.id}>
      {failure?.retained ? <p role="alert" className="px-4 py-2 text-caption text-destructive">{tab.label} refresh failed; showing the last accepted state. {failure.message}<Button variant="ghost" size="compact" onClick={failure.retry}>Retry {tab.label}</Button></p> : null}
      {renderSurface(tab.id)}
    </TabsSubtlePanel>;
  });
  return <ResourceNavigation.Provider value={openResource}><RuntimeAvailability.Provider value={runtimeAvailable}><div className="flex h-full min-h-0 flex-col bg-surface-2" aria-label="Workspace Inspector">
    {!runtimeAvailable ? <p className="px-4 pt-3 text-caption text-muted-foreground">Cloud Inspector · Saved records. Live files, processes, terminals, and services are unavailable.</p> : null}
    <div className="flex shrink-0 items-center gap-1 px-2 pb-1 pt-2">
      <TabsSubtle idPrefix="inspectorTabs" size="compact" className="min-w-0 flex-1" selectedIndex={tabIndex} onSelect={(index) => { const tab = permanentTabs[index]; if (tab) selectSurface(tab.id); }} aria-label="Inspector views">
        {permanentTabs.map((tab, index) => !runtimeAvailable && runtimeViews[tab.id]
          ? <Tooltip content={openWorkspaceFirst} key={tab.id}><span><Button variant="ghost" size="compact" role="tab" aria-selected={false} disabled>{tab.label}</Button></span></Tooltip>
          : <TabsSubtleItem index={index} label={counts[tab.id] === undefined ? tab.label : `${tab.label} · ${counts[tab.id]}`} key={tab.id} />)}
      </TabsSubtle>
      {props.onClose ? <Button variant="ghost" size="icon-compact" type="button" aria-label="Close Inspector" onClick={() => { if (!agentSetupDirty || window.confirm('Close Inspector and discard unsaved agent definition edits?')) props.onClose?.(); }}><XClose width={16} height={16} strokeWidth={1.5} /></Button> : null}
    </div>
    {documents.length ? <div className="flex shrink-0 items-center gap-1 overflow-x-auto px-2 pb-1">
      <Kicker>Open</Kicker>
      {documents.map((item) => <span className="flex shrink-0 items-center" key={item.id}>
        <Button variant="ghost" size="compact" type="button" active={view === 'document' && activeDocumentId === item.id} onClick={() => { setActiveDocumentId(item.id); setView('document'); setActiveThread(null); setThreadSelection(null); }}>{documentIcon(item.kind)}<span className="max-w-40 truncate">{item.label}</span></Button>
        <Button variant="ghost" size="icon-compact" type="button" aria-label={`Close ${item.label}`} onClick={() => closeDocument(item.id)}>{ic(XClose, 14)}</Button>
      </span>)}
    </div> : null}
    <div className="flex min-h-0 flex-1 flex-col border-t border-border">
      <div role="tabpanel" id={`inspectorTabs-panel-${agentSetupTabIndex}`} aria-labelledby={`inspectorTabs-tab-${agentSetupTabIndex}`} hidden={view !== 'agents'} className={view === 'agents' ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
        {runtimeAvailable ? <AgentSetupView key={props.agentSetup.sessionId} state={props.agentSetup} onDirtyChange={setAgentSetupDirty} /> : <Padded><EmptyState title="Live workspace unavailable" description={openWorkspaceFirst} /></Padded>}
      </div>
      {view !== 'agents' ? body : null}
    </div>
  </div></RuntimeAvailability.Provider></ResourceNavigation.Provider>;
}
