import type { ExecutionBlock } from '@gitspace/blocks';
import type { RuntimeSideAgentBlock } from '../runtime-shell-adapter.js';
import { Button, TabsSubtle, TabsSubtleItem, TabsSubtlePanel, Tooltip, ThinkingIndicator } from '@gitspace/ui';
import type { EvidenceReference, InspectorOverview, JournalEntryView, RepositoryDiffView, RepositoryFileView, RepositoryMode, RepositoryTreeEntry, ReviewAnchor, ReviewThreadView, SessionUsageReport, ServiceView } from '@gitspace/protocol';
import type { GitLfsHeldBack } from '@gitspace/protocol-workspace';
import { AlertCircle, Archive, ArrowLeft, Expand06, File02, FileCode02, Globe01, Minimize02, Tool02, XClose } from '@untitledui/icons';
import { useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { rpcErrorMessage } from '../rpc-error-message.js';
import { EmptyState, type AgentScopeView, type WorkspaceView } from '../GitSpaceShell.js';
import { OverviewView, type OverviewViewProps } from './OverviewView.js';
import { UsageView, type UsageStatus, type InspectorProviderUsageState } from './UsageView.js';
import { AgentSetupView, type InspectorAgentSetupState } from './AgentSetupView.js';
import { ArtifactActions, type ArtifactActionsHandlers } from './ArtifactActions.js';
import type { GuideShareHandlers } from './GuideShare.js';
import type { GuideDiffTarget, GuideRevisionHandlers } from '../guide/GuideRevisions.js';
import { useArtifactUploads } from './ArtifactUploads.js';
import { DriveSurface, type DriveFileView, type InspectorDrive } from './DriveSurface.js';
import type { ArtifactUploadClient } from './artifact-upload.js';
import { ResourceNavigation, type ResourceRequest } from '../ResourceNavigation.js';
import { IssuesView, openIssueCount, type IssuesViewProps } from './IssuesView.js';
import { type InspectorArtifactContent, type ArtifactReference, type ThreadSelection, diffIdentities, InspectorLayout, RuntimeAvailability, openWorkspaceFirst, repositoryModes, ic, artifactId, Kicker, Padded } from './inspector-shared.js';
import { GoalSurface, WorkflowDocument, RubricDocument } from './GoalSurface.js';
import type { GoalAutomations } from '../goal/useWorkspaceAutomations.js';
import type { SessionControlView } from '@gitspace/protocol-runtime/session-controls';
import { REPOSITORY_FILE_TYPES, RepositoryBinaryFile, repositoryPatch, PierreViewer, FilesSurface } from './FilesSurface.js';
import { ThreadPanel } from './ReviewThreads.js';
import { ArtifactDocument, ResourceDocument } from './ArtifactDocuments.js';
import { SubagentsSurface } from './SubagentsSurface.js';
import { ServicesSurface } from './ServicesSurface.js';
import { ChangeGuideSurface } from './ChangeGuideSurface.js';
import { JournalSurface } from './JournalSurface.js';
import { OpenFilesLayout, OpenFilesStrip, closeInStrip, fromRepository, openInStrip, type InspectorOpenDocument, type OpenFiles } from './OpenFiles.js';

export type InspectorPermanentView = 'overview' | 'environment' | 'browser' | 'goal' | 'agents' | 'subagents' | 'files' | 'artifacts' | 'services' | 'issues' | 'usage' | 'guide' | 'journal';
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
export interface InspectorProps {
  overview: InspectorOverview;
  /** The agent scope the Inspector is open for: a workspace, or the project's base space. */
  scope?: AgentScopeView;
  workspaces: readonly WorkspaceView[];
  onSelectWorkspace(workspaceId: string): void;
  onSetRelations?: OverviewViewProps['onSetRelations'];
  stackStatus?: OverviewViewProps['stackStatus'];
  /** The Environment tab; `openAgentSetup` switches to the Agent setup tab, `openBrowser` to the Browser tab. */
  environment?: (openAgentSetup: () => void, openBrowser: () => void) => ReactNode;
  /** The Browser tab: this workspace's browsers; `openEnvironment` switches to the Environment tab, where sites are approved. */
  browser?: (openEnvironment: () => void) => ReactNode;
  /** Browsers of this workspace with open tabs, shown on the Browser tab's label when there are any. */
  browserCount?: number;
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
  /** The workspace's own issues (its `gitspace.qa` document) and the actions on them. */
  issues?: IssuesViewProps;
  subagents: readonly (ExecutionBlock | RuntimeSideAgentBlock)[];
  onStopSubagent?(conversationId: string): Promise<void>;
  renderSubagentTranscript?(conversationId: string): ReactNode;
  usage: InspectorUsageState;
  agentSetup: InspectorAgentSetupState;
  onRequestArtifact(reference: Extract<EvidenceReference, { kind: 'artifact' }>, signal?: AbortSignal): Promise<InspectorArtifactContent>;
  artifactReferences?: readonly Extract<EvidenceReference, { kind: 'artifact' }>[];
  resourceRequest?: ResourceRequest;
  /** Opens the Change Guide at this section (asked from outside the Inspector, e.g. a chat block); a new serial opens it again. */
  guideSection?: { id: string; serial: number };
  onRequestResource?(uri: string, signal?: AbortSignal): Promise<InspectorArtifactContent>;
  artifactActions?: ArtifactActionsHandlers;
  /** Present when the viewer may upload files into the drive this space writes. */
  artifactUpload?: ArtifactUploadClient;
  /** The space's drives as the catalog lists them; the Drive tab shows nothing else. */
  drive?: InspectorDrive;
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
  /** One exhibit's diff in a Change Guide revision: between its recorded base and head commits, or since an earlier revision's head. */
  onLoadGuideDiff(path: string, target: GuideDiffTarget): Promise<RepositoryDiffView>;
  onCreateThread(input: CreateInspectorThread): Promise<ReviewThreadView>;
  onReplyThread(threadId: string, expectedRevision: number, body: string): Promise<void>;
  onResolveThread(threadId: string, expectedRevision: number, resolved: boolean, decision: ReviewThreadView['decision']): Promise<void>;
  onMarkGuideSectionRead(sectionId: string, revision: number, headCommit: string): Promise<void>;
  onSetGuideApproval(decision: 'pending' | 'approved' | 'changes-requested', note: string | null, revision: number, headCommit: string): Promise<void>;
  onGenerateChangeGuide?(): Promise<void>;
  guideShares?: GuideShareHandlers;
  guideRevisions?: GuideRevisionHandlers;
  onSubmitHumanJudgment?(criterionId: string, verdict: 'pass' | 'fail', summary: string): Promise<void>;
  /** A person accepts or reopens a goal requirement; absent without a goal. */
  onSetRequirementAcceptance?(requirementId: string, accepted: boolean): Promise<void>;
  /** The conversation's session controls; the Goal tab shows their plan and where the todo list is. */
  controls?: SessionControlView;
  /** The project's automations and this workspace's exceptions, for the Goal tab. */
  goalAutomations?: GoalAutomations;
  onStartService?(serviceName: string): Promise<void>;
  onStopService?(serviceName: string): Promise<void>;
  onOpenServiceTerminal?(terminalName: string): void;
}

const runtimeViews: Partial<Record<InspectorPermanentView, true>> = { overview: true, browser: true, agents: true, subagents: true, files: true, services: true, usage: true };

const permanentTabs: ReadonlyArray<{ id: InspectorPermanentView; label: string }> = [
  { id: 'goal', label: 'Goal' },
  { id: 'guide', label: 'Change Guide' },
  { id: 'overview', label: 'Relations' },
  { id: 'files', label: 'Files' },
  { id: 'artifacts', label: 'Drive' },
  { id: 'browser', label: 'Browser' },
  { id: 'services', label: 'Services' },
  { id: 'environment', label: 'Environment' },
  { id: 'agents', label: 'Agent setup' },
  { id: 'subagents', label: 'Subagents' },
  { id: 'usage', label: 'Usage' },
  { id: 'issues', label: 'Issues' },
  { id: 'journal', label: 'Journal' },
];
const agentSetupTabIndex = permanentTabs.findIndex((tab) => tab.id === 'agents');
/** Files and Drive stay mounted once opened, hidden while another tab shows or a file replaces their browser: the
 * tree's open folders, the drive's folder, filter and sort, and both scroll positions survive opening a file. */
const keptMounted: Partial<Record<InspectorPermanentView, true>> = { files: true, artifacts: true };
const artifactModes = ['preview', 'source'] as const;
type ProductKind = 'workflow' | 'rubric';

function fileName(path: string): string { return path.split('/').at(-1) ?? path; }
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
export function Inspector(props: InspectorProps) {
  const runtimeAvailable = props.runtimeAvailable ?? true;
  const layout = useContext(InspectorLayout);
  const full = layout?.full ?? false;
  const onFull = layout?.onFull;
  const [view, setView] = useState<InspectorPermanentView>(props.initialView ?? 'goal');
  const [agentSetupDirty, setAgentSetupDirty] = useState(false);
  useEffect(() => { if (props.initialView) setView(props.initialView); }, [props.initialView]);
  const [opened, setOpened] = useState<ReadonlySet<InspectorPermanentView>>(() => new Set());
  useEffect(() => { if (keptMounted[view]) setOpened((current) => current.has(view) ? current : new Set([...current, view])); }, [view]);
  const [openFiles, setOpenFiles] = useState<OpenFiles>({ items: [], active: null, viewing: false });
  const [product, setProduct] = useState<ProductKind | null>(null);
  const [guideFocus, setGuideFocus] = useState<{ id: string; serial: number } | null>(null);
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
  const tabStrip = useRef<HTMLDivElement>(null);
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
  // Escape returns from full width, unless a dialog, menu or list that handles Escape itself has focus.
  useEffect(() => {
    if (!full || !onFull) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (event.target instanceof Element && event.target.closest('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]')) return;
      onFull(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [full, onFull]);
  // The tab strip scrolls; keep the selected tab in view when a link elsewhere selects it.
  useEffect(() => { tabStrip.current?.querySelector('[role="tab"][aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }, [view]);
  const evidence = useMemo(() => collectEvidence(props.overview, props.journalEntries), [props.journalEntries, props.overview]);
  const artifacts = useMemo(() => {
    const listed = props.artifactReferences ?? evidence.filter((reference): reference is ArtifactReference => reference.kind === 'artifact');
    // Committed uploads show immediately; the catalog lists them once background publication finishes.
    return [...listed, ...uploads.uploaded.filter((upload) => !listed.some((reference) => reference.url === upload.url))];
  }, [evidence, props.artifactReferences, uploads.uploaded]);
  // Committed uploads show at once with their size and time; the catalog lists them once publication finishes.
  const driveFiles = useMemo<readonly DriveFileView[]>(() => {
    if (!props.drive) return [];
    const listed = props.drive.files;
    const own = props.drive.own;
    return [...listed, ...uploads.uploaded.filter((upload) => !listed.some((file) => file.url === upload.url)).map((upload) => ({
      url: upload.url, path: upload.label, hash: upload.hash, size: upload.size, mediaType: upload.mediaType, scope: own, workspaceId: null, writtenAt: upload.writtenAt,
    }))];
  }, [props.drive, uploads.uploaded]);
  const activeDocument = openFiles.items.find((document) => document.id === openFiles.active) ?? null;
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
  const closeThread = (): void => { setActiveThread(null); setThreadSelection(null); };
  const selectSurface = (next: InspectorPermanentView): void => { setView(next); setGuideFocus(null); closeThread(); };
  /** Opens a document into the strip Files and Drive share; from any other tab, its own tab (Files or Drive) shows it. */
  const openDocument = (document: InspectorOpenDocument): void => {
    setOpenFiles((current) => openInStrip(current, document));
    setView((current) => current === 'files' || current === 'artifacts' ? current : fromRepository(document) ? 'files' : 'artifacts');
    closeThread();
  };
  const showDocument = (id: string): void => { setOpenFiles((current) => ({ ...current, active: id, viewing: true })); closeThread(); };
  const closeDocument = (id: string): void => { setOpenFiles((current) => closeInStrip(current, id)); closeThread(); };
  const openProduct = (kind: ProductKind): void => { if (kind === 'workflow' ? props.overview.workflow : props.overview.rubric) setProduct(kind); };
  const openResource = ({ uri }: ResourceRequest): void => openDocument({ id: `resource:${uri}`, kind: 'resource', label: fileName(uri), target: uri });
  useEffect(() => { if (props.resourceRequest) openResource(props.resourceRequest); }, [props.resourceRequest]);
  const openFile = (path: string, mode: RepositoryMode): void => { const id = `file:${path}`; setFileModes((current) => ({ ...current, [id]: mode })); openDocument({ id, kind: 'file', label: fileName(path), target: path }); if (mode === 'current') props.onRequestRepositoryFile(path, mode); else props.onRequestRepositoryDiff(path, mode); };
  const openEvidence = (reference: EvidenceReference): void => {
    if (reference.kind === 'artifact') {
      openDocument({ id: `artifact:${artifactId(reference)}`, kind: 'artifact', label: reference.label, target: artifactId(reference) });
      void loadArtifact(reference);
    } else if (reference.kind === 'git') {
      if (runtimeAvailable) openFile(reference.path, 'current');
    } else if (reference.kind === 'review-thread') {
      const thread = props.threads.find((candidate) => candidate.id === reference.threadId);
      if (thread) { setView('guide'); setActiveThread(thread); setThreadSelection(null); }
    }
  };
  const openGuideSection = (sectionId: string): void => {
    setView('guide');
    closeThread();
    setGuideFocus((current) => ({ id: sectionId, serial: (current?.serial ?? 0) + 1 }));
  };
  useEffect(() => { if (props.guideSection) openGuideSection(props.guideSection.id); }, [props.guideSection?.serial]);
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
  const counts: Partial<Record<InspectorPermanentView, number>> = { browser: props.browserCount || undefined, subagents: props.subagents.length, files: props.repositoryEntries.filter((entry) => entry.kind === 'file' && entry.status !== 'clean').length, artifacts: artifacts.length, services: props.runtimeServices === undefined ? props.services.length : undefined, issues: props.issues ? openIssueCount(props.issues.document) : undefined };
  for (const tab of permanentTabs) if (props.sectionErrors?.[tab.id] && !props.sectionErrors[tab.id]!.retained) delete counts[tab.id];
  const threadPanel = activeThread || threadSelection ? <ThreadPanel
    thread={activeThread}
    selection={threadSelection}
    onClose={closeThread}
    onCreate={createThread}
    onReply={(body) => activeThread ? props.onReplyThread(activeThread.id, activeThread.revision, body) : Promise.resolve()}
    onResolve={(resolved, decision) => activeThread ? props.onResolveThread(activeThread.id, activeThread.revision, resolved, decision) : Promise.resolve()}
  /> : null;
  let documentBody: ReactNode = null;
  if (activeDocument?.kind === 'resource') documentBody = <ResourceDocument key={`${props.overview.spaceId}:${activeDocument.target}`} uri={activeDocument.target} mode={artifactModeById[activeDocument.id] ?? 'preview'} onRequest={props.onRequestResource} artifactReferences={artifacts} artifactContent={artifactContent} onRequestArtifact={loadArtifact} />;
  else if (activeDocument?.kind === 'artifact') {
    documentBody = activeArtifact ? <ArtifactDocument
      reference={activeArtifact}
      content={artifactContent[artifactId(activeArtifact)] ?? null}
      status={artifactLoad[artifactId(activeArtifact)]}
      error={artifactErrors[artifactId(activeArtifact)]}
      mode={artifactModeById[artifactId(activeArtifact)] ?? 'preview'}
      artifactReferences={artifacts}
      artifactContent={artifactContent}
      onRequest={loadArtifact}
    /> : <Padded><EmptyState icon={ic(File02, 22)} title="File is no longer available" description="The drive no longer lists this file. Close it, or open another from the drive." /></Padded>;
  } else if (activeDocument?.kind === 'file' && displayedFile && (displayedFile.binary || REPOSITORY_FILE_TYPES[displayedFile.path.split('.').at(-1)?.toLowerCase() ?? ''])) {
    documentBody = <RepositoryBinaryFile file={displayedFile} />;
  } else if (activeDocument?.kind === 'file' && (displayedFile || displayedDiff)) {
    const currentIdentity = displayedFile ? { generation: displayedFile.generation, baseCommit: displayedFile.commitId, headCommit: displayedFile.headCommit, blobId: displayedFile.blobId } : null;
    documentBody = <PierreViewer path={activeDocument.target} identities={currentIdentity ? { base: currentIdentity, head: currentIdentity } : diffIdentities(displayedDiff!, activeDocument.target)} patch={displayedFile ? repositoryPatch(displayedFile) : displayedDiff!.patch} threads={props.threads} onSelectThread={(thread) => { setActiveThread(thread); setThreadSelection(null); }} onSelectRange={(selection) => { setThreadSelection(selection); setActiveThread(null); }} />;
  } else if (activeDocument) {
    documentBody = <Padded><EmptyState icon={ic(FileCode02, 22)} title="Loading repository view" description="The selected file mode will render when its generation-pinned response arrives." /></Padded>;
  }
  const activeArtifactMode = activeArtifact ? artifactModeById[artifactId(activeArtifact)] ?? 'preview' : activeDocument?.kind === 'resource' ? artifactModeById[activeDocument.id] ?? 'preview' : 'preview';
  const documentPane = activeDocument ? <div className="flex min-h-0 flex-1 flex-col">
    <header className="flex items-center justify-between gap-3 px-4 pb-2 pt-3">
      <div className="flex min-w-0 flex-col"><strong className="truncate text-body font-medium text-foreground">{activeDocument.kind === 'file' ? activeDocument.target : activeDocument.label}</strong><span className="truncate text-caption text-muted-foreground tabular-nums">{activeDocument.kind === 'file' ? `${repositoryModes.find((mode) => mode.id === activeMode)?.label} · generation ${(displayedFile ?? displayedDiff)?.generation ?? '—'}` : activeArtifact ? `${activeArtifact.hash} · generation ${activeArtifact.generation}` : activeDocument.target}</span></div>
      {!runtimeAvailable && activeDocument.kind === 'artifact' ? <Tooltip content="Open this workspace on a machine before editing artifacts"><span className="shrink-0 text-caption text-muted-foreground">Read-only artifact</span></Tooltip> : null}
      {activeArtifact && props.artifactActions ? <ArtifactActions selected={[activeArtifact]} actions={props.artifactActions} /> : null}
    </header>
    {activeDocument.kind === 'file' ? <div className="flex items-center gap-2 px-4 pb-2"><Kicker>View</Kicker><TabsSubtle size="compact" className="min-w-0 flex-1" selectedIndex={Math.max(0, repositoryModes.findIndex((mode) => mode.id === activeMode))} onSelect={(index) => { const mode = repositoryModes[index]; if (mode) chooseMode(mode.id); }} aria-label="Repository view mode">{repositoryModes.map((mode, index) => <TabsSubtleItem index={index} label={mode.label} key={mode.id} />)}</TabsSubtle></div>
      : activeArtifact || activeDocument.kind === 'resource' ? <div className="flex items-center gap-2 px-4 pb-2"><Kicker>View</Kicker><TabsSubtle size="compact" selectedIndex={artifactModes.indexOf(activeArtifactMode)} onSelect={(index) => { const mode = artifactModes[index]; if (mode) setArtifactModeById((current) => ({ ...current, [activeArtifact ? artifactId(activeArtifact) : activeDocument.id]: mode })); }} aria-label="Artifact view mode">{artifactModes.map((mode, index) => <TabsSubtleItem index={index} label={mode} key={mode} />)}</TabsSubtle></div> : null}
    <div className="flex min-h-0 flex-1 flex-col border-t border-border">{documentBody}{threadPanel}</div>
  </div> : null;
  /** Files or Drive: the tab's browser beside or under the shared open-file strip. */
  const fileWorkbench = (id: 'files' | 'artifacts', browser: ReactNode): ReactNode => <OpenFilesLayout
    full={full}
    viewing={openFiles.viewing && activeDocument !== null}
    home={id === 'files' ? 'Files' : 'Drive'}
    strip={openFiles.items.length ? <OpenFilesStrip state={openFiles} onShow={showDocument} onClose={closeDocument} /> : null}
    browser={browser}
    document={view === id ? documentPane : null}
    onBack={() => { setOpenFiles((current) => ({ ...current, viewing: false })); closeThread(); }}
  />;
  const goalSurface = (): ReactNode => {
    let record: { title: string; body: ReactNode } | null = null;
    if (product === 'workflow' && props.overview.workflow) record = { title: props.overview.workflow.title, body: <WorkflowDocument workflow={props.overview.workflow} /> };
    else if (product === 'rubric' && props.overview.rubric) record = { title: props.overview.rubric.title, body: <RubricDocument rubric={props.overview.rubric} onOpenEvidence={openEvidence} onSubmit={props.onSubmitHumanJudgment} /> };
    if (!product || !record) return <GoalSurface
      overview={props.overview}
      scope={props.scope}
      controls={props.controls}
      journalEntries={props.journalEntries}
      threads={props.threads}
      viewerId={props.reviewerId}
      automations={props.goalAutomations}
      comments={{
        viewerId: props.reviewerId,
        onComment: async (stepId, body) => { await props.onCreateThread({ anchor: { kind: 'plan-step', stepId }, body, decision: 'pending' }); },
        onReply: (thread, body) => props.onReplyThread(thread.id, thread.revision, body),
        onResolve: (thread, resolved) => props.onResolveThread(thread.id, thread.revision, resolved, thread.decision),
      }}
      onSetAcceptance={props.onSetRequirementAcceptance}
      onOpenEvidence={openEvidence}
      onOpenGuideSection={openGuideSection}
      onOpenJournal={() => selectSurface('journal')}
      onOpenProduct={openProduct}
    />;
    return <div className="flex min-h-0 flex-1 flex-col">
      <Button variant="ghost" size="compact" className="mx-2 mt-2 self-start" onClick={() => setProduct(null)}><ArrowLeft width={14} height={14} strokeWidth={1.5} />Goal</Button>
      <header className="flex min-w-0 flex-col px-4 pb-2 pt-1"><strong className="truncate text-body font-medium text-foreground">{record.title}</strong><span className="text-caption text-muted-foreground">{product} authority record</span></header>
      <div className="flex min-h-0 flex-1 flex-col border-t border-border">{record.body}</div>
    </div>;
  };
  const renderSurface = (id: InspectorPermanentView): ReactNode => {
    if (!runtimeAvailable && runtimeViews[id] && id !== 'files') return <Padded><EmptyState title="Live workspace unavailable" description={openWorkspaceFirst} /></Padded>;
    const failure = props.sectionErrors?.[id];
    if (failure && !failure.retained && !(id === 'files' && props.repositoryMode === 'working' && props.lfsHeldBack?.length)) {
      const label = permanentTabs.find((tab) => tab.id === id)!.label;
      const alert = <Padded><div role="alert"><EmptyState icon={ic(AlertCircle, 22)} title={`${label} could not load`} description={failure.message} action={<Button variant="ghost" type="button" onClick={failure.retry}>Retry {label}</Button>} /></div></Padded>;
      return id === 'files' || id === 'artifacts' ? fileWorkbench(id, alert) : alert;
    }
    switch (id) {
      case 'overview': return props.scope ? <OverviewView scope={props.scope} workspaces={props.workspaces} onSelectWorkspace={props.onSelectWorkspace} onSetRelations={props.onSetRelations} stackStatus={props.stackStatus} /> : null;
      case 'environment': return props.environment?.(() => selectSurface('agents'), () => selectSurface('browser')) ?? <Padded><EmptyState icon={ic(Tool02, 22)} title="Workspace setup unavailable" description="This machine does not expose the workspace environment contract." /></Padded>;
      case 'browser': return props.browser?.(() => selectSurface('environment')) ?? <Padded><EmptyState icon={ic(Globe01, 22)} title="Browsers unavailable" description="This view has no workspace browsers to show." /></Padded>;
      case 'goal': return goalSurface();
      case 'agents': return null;
      case 'subagents': return <SubagentsSurface subagents={props.subagents} onStop={props.onStopSubagent} renderTranscript={props.renderSubagentTranscript} />;
      case 'files': return fileWorkbench('files', <FilesSurface entries={props.repositoryEntries.filter((entry) => entry.mode === props.repositoryMode)} heldBack={props.repositoryMode === 'working' ? props.lfsHeldBack ?? [] : []} mode={props.repositoryMode} onModeChange={props.onRepositoryModeChange} changedOnly={changedOnly} setChangedOnly={setChangedOnly} onOpen={(entry) => openFile(entry.path, props.repositoryMode)} onOpenHeldBack={path => openFile(path, 'working')} />);
      case 'artifacts': return fileWorkbench('artifacts', props.drive ? <DriveSurface
        drive={{ ...props.drive, files: driveFiles }}
        references={artifacts}
        uploads={props.artifactUpload ? uploads : null}
        uploadDisabledReason={runtimeAvailable ? null : openWorkspaceFirst}
        {...(props.artifactActions ? { actions: props.artifactActions } : {})}
        previewUrl={(reference) => artifactContent[artifactId(reference)]?.previewUrl ?? null}
        onRequestPreview={(reference) => void loadArtifact(reference)}
        onOpen={(reference) => {
          openDocument({ id: `artifact-current:${reference.url}`, kind: 'artifact', label: reference.label, target: `current:${reference.url}` });
          void loadArtifact(reference);
        }}
        onDownload={async (reference) => {
          await loadArtifact(reference);
          const content = artifactCache.current.get(artifactId(reference));
          if (!content) throw new Error(`${reference.label} could not be read`);
          const link = window.document.createElement('a');
          link.href = content.downloadUrl ?? content.previewUrl;
          link.download = reference.label.split('/').at(-1) ?? reference.label;
          link.click();
        }}
      /> : <Padded><EmptyState icon={ic(Archive, 22)} title="Drive unavailable" description="This view has no drive to show." /></Padded>);
      case 'services': return props.runtimeServices ?? <ServicesSurface services={props.services} onOpenTerminal={(name) => props.onOpenServiceTerminal?.(name)} onStart={props.onStartService} onStop={props.onStopService} />;
      case 'issues': return props.issues ? <IssuesView {...props.issues} /> : <Padded><EmptyState icon={ic(AlertCircle, 22)} title="Issues unavailable" description="This view has no workspace issues to show." /></Padded>;
      case 'usage': return <UsageView sessionId={props.usage.sessionId} report={props.usage.report} status={props.usage.status} error={props.usage.error} onLoad={props.usage.load} onRefresh={props.usage.refresh} providerUsage={props.usage.providerUsage} />;
      case 'guide': return <><ChangeGuideSurface
        guide={props.overview.changeGuide}
        reviewerId={props.reviewerId}
        review={{
          threads: props.threads,
          onOpenFile: (path) => openFile(path, 'current'),
          onSelectThread: (thread) => { setActiveThread(thread); setThreadSelection(null); },
          onSelectRange: (selection) => { setThreadSelection(selection); setActiveThread(null); },
        }}
        goal={props.overview.goal}
        onSetAcceptance={props.onSetRequirementAcceptance}
        onOpenEvidence={openEvidence}
        captures={{ content: (reference) => artifactContent[artifactId(reference)] ?? null, load: (reference) => void loadArtifact(reference) }}
        scope={props.scope}
        workspaces={props.workspaces}
        onSetRelations={props.onSetRelations}
        onLoadDiff={props.onLoadGuideDiff}
        onMarkRead={props.onMarkGuideSectionRead}
        onGenerate={runtimeAvailable ? props.onGenerateChangeGuide : undefined}
        shares={props.guideShares}
        revisions={props.guideRevisions}
        focusSection={guideFocus}
      />{threadPanel}</>;
      default: return <div className={full ? 'mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col' : 'flex min-h-0 flex-1 flex-col'}><JournalSurface entries={props.journalEntries} guide={props.overview.changeGuide} artifactContent={artifactContent} artifactLoad={artifactLoad} artifactErrors={artifactErrors} onLoadArtifact={loadArtifact} onOpenEvidence={openEvidence} onOpenSection={openGuideSection} /></div>;
    }
  };
  const tabIndex = permanentTabs.findIndex((tab) => tab.id === view);
  const viewLabel = permanentTabs[tabIndex]?.label ?? 'this tab';
  let body: ReactNode;
  if (props.loading) body = <div className="flex flex-1 items-center justify-center p-6"><ThinkingIndicator aria-label="Loading Inspector authority state…" /></div>;
  else if (props.error) body = <Padded><EmptyState icon={ic(AlertCircle, 22)} title="Inspector could not load" description={props.error} /></Padded>;
  else body = permanentTabs.map((tab, index) => {
    if (tab.id === 'agents') return null;
    const kept = keptMounted[tab.id] === true;
    if (kept && tab.id !== view && !opened.has(tab.id)) return null;
    const failure = props.sectionErrors?.[tab.id];
    const content = <>
      {failure?.retained ? <p role="alert" className="px-4 py-2 text-caption text-destructive">{tab.label} refresh failed; showing the last accepted state. {failure.message}<Button variant="ghost" size="compact" onClick={failure.retry}>Retry {tab.label}</Button></p> : null}
      {renderSurface(tab.id)}
    </>;
    return kept
      ? <div role="tabpanel" id={`inspectorTabs-panel-${index}`} aria-labelledby={`inspectorTabs-tab-${index}`} hidden={view !== tab.id} className={view === tab.id ? 'flex min-h-0 flex-1 flex-col' : 'hidden'} key={tab.id}>{content}</div>
      : <TabsSubtlePanel idPrefix="inspectorTabs" index={index} selectedIndex={tabIndex} className="flex min-h-0 flex-1 flex-col" key={tab.id}>{content}</TabsSubtlePanel>;
  });
  return <ResourceNavigation.Provider value={openResource}><RuntimeAvailability.Provider value={runtimeAvailable}><div className={`flex h-full min-h-0 flex-col ${full ? 'bg-background' : 'bg-surface-2'}`} aria-label="Workspace Inspector" data-inspector-layout={full ? 'full' : 'side'}>
    {!runtimeAvailable ? <p className="px-4 pt-3 text-caption text-muted-foreground">Cloud Inspector · Saved records. Live files, processes, terminals, and services are unavailable.</p> : null}
    <div ref={tabStrip} className="flex shrink-0 items-center gap-1 px-2 pb-1 pt-2">
      <TabsSubtle idPrefix="inspectorTabs" size="compact" className="min-w-0 flex-1 overflow-x-auto" selectedIndex={tabIndex} onSelect={(index) => { const tab = permanentTabs[index]; if (tab) selectSurface(tab.id); }} aria-label="Inspector views">
        {permanentTabs.map((tab, index) => !runtimeAvailable && runtimeViews[tab.id]
          ? <Tooltip content={openWorkspaceFirst} key={tab.id}><span><Button variant="ghost" size="compact" role="tab" aria-selected={false} disabled>{tab.label}</Button></span></Tooltip>
          : <TabsSubtleItem index={index} label={counts[tab.id] === undefined ? tab.label : `${tab.label} · ${counts[tab.id]}`} key={tab.id} />)}
      </TabsSubtle>
      {onFull ? full
        ? <Button variant="secondary" size="compact" className="shrink-0" onClick={() => onFull(false)}><Minimize02 width={14} height={14} strokeWidth={1.5} />Back to conversation</Button>
        : <Tooltip content={`Open ${viewLabel} at full width`} side="bottom"><Button variant="ghost" size="icon-compact" className="shrink-0" aria-label="Open at full width" onClick={() => onFull(true)}><Expand06 width={14} height={14} strokeWidth={1.5} /></Button></Tooltip> : null}
      {props.onClose && !full ? <Button variant="ghost" size="icon-compact" type="button" aria-label="Close Inspector" onClick={() => { if (!agentSetupDirty || window.confirm('Close Inspector and discard unsaved agent definition edits?')) props.onClose?.(); }}><XClose width={16} height={16} strokeWidth={1.5} /></Button> : null}
    </div>
    <div className="flex min-h-0 flex-1 flex-col border-t border-border">
      <div role="tabpanel" id={`inspectorTabs-panel-${agentSetupTabIndex}`} aria-labelledby={`inspectorTabs-tab-${agentSetupTabIndex}`} hidden={view !== 'agents'} className={view === 'agents' ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
        {runtimeAvailable ? <AgentSetupView key={props.agentSetup.sessionId} state={props.agentSetup} onDirtyChange={setAgentSetupDirty} /> : <Padded><EmptyState title="Live workspace unavailable" description={openWorkspaceFirst} /></Padded>}
      </div>
      {view !== 'agents' ? body : null}
    </div>
  </div></RuntimeAvailability.Provider></ResourceNavigation.Provider>;
}
