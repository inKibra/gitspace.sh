import type { TransportBlock, TurnBlock } from '@gitspace/blocks';
import type { PendingAskAnswer, SessionControlView } from '@gitspace/protocol';
import type { AgentSessionRenderState, SessionHistoryPage, SessionHistoryPageRequest } from '@gitspace/protocol-agent';
import type { WorkspaceStatusColor, WorkspaceStatusSummary } from '@gitspace/protocol-workspace';
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  InputField,
  InputGroup,
  ScrollArea,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SidebarInset,
  SidebarInsetTopbar,
  SidebarProvider,
  ThinkingIndicator,
  Tooltip,
  useShape,
} from '@gitspace/ui';
import { Archive, GitBranch01, LayoutRight, RefreshCcw01, Terminal, XClose } from '@untitledui/icons';
import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { AccountSidebarContext, AppSidebar, type AppSidebarProps, type SidebarDeploymentProps, type SidebarProject } from './AppSidebar.js';
import { Composer, type SendBehavior } from './Composer.js';
import type { AppView } from './routes.js';
import type { SkillView } from '@gitspace/protocol/skills-contract';
import { TurnTranscript } from './TurnTranscript.js';
import { VirtualTranscript } from './VirtualTranscript.js';
import type { TranscriptHistory } from './useTranscriptHistory.js';
import { WorkspaceTerminals, type WorkspaceTerminalsProps } from './WorkspaceTerminals.js';
import { WorkspacePicker, type WorkspacePickerItem } from './WorkspacePicker.js';
import { glyph } from './glyph.js';
import { ResourceNavigation, type ResourceRequest } from './ResourceNavigation.js';

/** Where a space lives right now, from the account-wide placement table: held by a machine, released to the cloud, or not yet known. */
export type SpaceHolderView =
  | { kind: 'held'; machineId: string; label: string }
  | { kind: 'released' }
  | { kind: 'unknown' };

export interface WorkspaceView {
  kind: 'workspace';
  id: string;
  projectId: string;
  projectName: string;
  name: string;
  branch: string;
  phase: 'plan' | 'code' | 'review' | 'ship';
  generation: number;
  possessedBy: string;
  holder: SpaceHolderView;
  status: WorkspaceStatusSummary;
  closedAt: Date | null;
  /** Workspace ids this workspace depends on / is related to (project-local); `stackedOn` is the single branch parent and always also a dependency. */
  relations: { dependsOn: readonly string[]; relatedTo: readonly string[]; stackedOn: string | null };
  /** Derived by the machine's stack validations: what blocks this workspace, what it blocks, and every finding. */
  stack: { blockedBy: readonly string[]; blocking: readonly string[]; findings: ReadonlyArray<{ code: string; message: string; workspaceId: string | null }> };
}
export interface ProjectLifecycleView {
  id: string;
  name: string;
  lifecycle: 'cloud-only' | 'provisioning' | 'active' | 'archiving' | 'archived' | 'restoring' | 'failed' | 'deleting';
  repositoryReference: string | null;
  baseBranch: string;
  role: 'gitspace-source' | null;
  source: { release: string | null; branch: string | null; commit: string | null } | null;
  revision: number;
  archivedAt: Date | null;
  updatedAt: Date;
}
export interface ProjectAgentView {
  kind: 'project';
  id: string;
  projectId: string;
  projectName: string;
  name: string;
  branch: string;
  phase: null;
  possessedBy: string;
  holder: SpaceHolderView;
  status: WorkspaceStatusSummary;
  generation: number;
  closedAt: Date | null;
}
export type AgentScopeView = WorkspaceView | ProjectAgentView;

export interface ArtifactView {
  url: string;
  name: string;
  path: string;
  scope: 'base' | 'workspace';
  size: number;
  mediaType?: string;
}

export interface SessionControlsProps {
  value: SessionControlView;
  onCycleRole(direction: 'forward' | 'backward'): Promise<void>;
  onSetModel(provider: string, model: string): Promise<void>;
  onSetThinking(thinking: string | null): Promise<void>;
  onSetFast(enabled: boolean): Promise<void>;
  onSetApproval(mode: SessionControlView['approvalMode']): Promise<void>;
  onSetGoal(enabled: boolean): Promise<void>;
  onCompact(instructions?: string): Promise<void>;
  onClearQueue(): Promise<void>;
  onRemoveQueuedMessage(kind: 'steering' | 'followUp', index: number): Promise<void>;
  onPromoteQueuedMessage(index: number): Promise<void>;
  onAnswerAsk(id: string, answers: PendingAskAnswer[]): Promise<void>;
  onStop(): Promise<void>;
  onNavigateTree(entryId: string): Promise<void>;
  onReadHistory?(request: SessionHistoryPageRequest, signal: AbortSignal): Promise<SessionHistoryPage>;
}

export interface CreateProjectInput { name: string; baseBranch: string | null; repositoryUrl: string | null }
export interface CreateWorkspaceInput { projectId: string; name: string; branch: string; phase: WorkspaceView['phase']; sourceKind: 'base' | 'branch' | 'workspace' | 'pull-request' | 'tag' | 'commit'; sourceRef: string; dependsOn: readonly string[] }
export interface ProviderAuthView { id: string; name: string; hasAuth: boolean }

export interface GitSpaceShellProps {
  project: { id?: string; name: string; repository: string; connected: boolean };
  workspace: AgentScopeView;
  baseSpace: ProjectAgentView;
  workspaces: WorkspaceView[];
  projects?: readonly ProjectLifecycleView[];
  mainAgent: { id: string; title: string; state: AgentSessionRenderState; model: string; recovering?: boolean; controlsAvailable?: boolean; errorMessage?: string | null; failed?: boolean } | null;
  turns: TurnBlock[];
  transcript?: TranscriptHistory;
  history?: { loading: boolean; error: string | null; onRetry(): void };
  transport: TransportBlock[];
  artifacts: ArtifactView[];
  machines?: Array<{ id: string; label: string }>;
  onSend?: (text: string, behavior?: SendBehavior, images?: Array<{ data: string; mimeType: string }>) => void | Promise<void>;
  sessionControls?: SessionControlsProps;
  controlsError?: string;
  onRetryAgent?: () => Promise<void>;
  onSetWorkspacePhase?: (workspaceId: string, phase: WorkspaceView['phase']) => void | Promise<void>;
  onSetWorkspaceRelations?: (workspaceId: string, relations: WorkspaceView['relations']) => void | Promise<void>;
  sendPending?: boolean;
  sendError?: string;
  onSelectWorkspace?: (workspaceId: string) => void;
  onSelectProject?: (projectId: string) => void;
  onCloseSpace?: (spaceId: string) => void | Promise<void>;
  onReopenSpace?: (spaceId: string) => void | Promise<void>;
  onArchiveWorkspace?: (workspaceId: string) => void | Promise<void>;
  /** Machines a released or archived space can be opened on (online, reachable). */
  claimMachines?: Array<{ id: string; label: string }>;
  /** The machine serving this page; `null` in `onClaimWorkspace` means it. */
  homeMachineId?: string | null;
  /** Preferred machine for opening released spaces (`settings.defaults.machineId`). */
  defaultMachineId?: string | null;
  /** Present when the transcript is a read-only projection of a closed space's cloud checkpoint. */
  checkpoint?: { sessionId: string; generation: number; lastMachineId: string | null } | null;
  /** Open a released or archived space on the chosen machine; `null` opens it on the home machine. */
  onClaimWorkspace?: (workspaceId: string, machineId: string | null) => void | Promise<void>;
  onMoveWorkspace?: (spaceId: string, destinationMachineId: string) => void | Promise<void>;
  onCreateProject?: (input: CreateProjectInput) => void | Promise<void>;
  onCreateWorkspace?: (input: CreateWorkspaceInput) => void | Promise<void>;
  onArchiveProject?: (projectId: string, expectedRevision: number) => void | Promise<void>;
  onRestoreProject?: (projectId: string, expectedRevision: number) => void | Promise<void>;
  onDeleteProject?: (projectId: string, expectedRevision: number) => void | Promise<void>;
  onDeleteWorkspace?: (workspaceId: string) => void | Promise<void>;
  terminals?: WorkspaceTerminalsProps;
  /** `section` deep-links a settings tab (the Source pill opens `source`). */
  onOpenSettings?: (section?: 'source') => void;
  onNavigateView?: (view: AppView) => void;
  skills?: readonly SkillView[];
  renderInspector?: (onClose: () => void, initialView?: 'environment', resource?: ResourceRequest) => ReactNode;
  renderEnvironmentStatus?: (onInspect: () => void) => ReactNode;
  /** Signed-in user shown in the sidebar footer. */
  user?: { name: string; handle?: string | null };
  /** Machine-local model provider auth state; drives the composer's not-connected notice. */
  providers?: readonly ProviderAuthView[];
  /** Self-development: drives the sidebar's Source pill, launched badges, and launch actions. */
  deployment?: SidebarDeploymentProps | null;
  /** Strip pinned to the top of the agent canvas (the post-launch `Now running …` notice). */
  launchBanner?: ReactNode;
}

const STATUS_COLOR: Record<WorkspaceStatusColor, string> = { dim: 'var(--muted-foreground)', green: '#22c55e', blue: '#3b82f6', orange: '#f97316', red: '#ef4444' };
export const PHASE_LABEL: Record<WorkspaceView['phase'], string> = { plan: 'Plan', code: 'Code', review: 'Review', ship: 'Ship' };
export const PHASES: readonly WorkspaceView['phase'][] = ['plan', 'code', 'review', 'ship'];
export function workspacePhaseLabel(phase: WorkspaceView['phase'] | null | undefined): string {
  return phase === null ? 'Unassigned' : phase === undefined ? 'Phase unknown' : PHASE_LABEL[phase];
}

function selectOptions(options: readonly { value: string; label: ReactNode; disabled?: boolean }[]): ReactNode {
  return <SelectContent>{options.map((option, index) => <SelectItem value={option.value} index={index} disabled={option.disabled} key={option.value}>{option.label}</SelectItem>)}</SelectContent>;
}

export function workspaceStatusLabel(space: Pick<AgentScopeView, 'closedAt' | 'holder'> & { status?: AgentScopeView['status'] }): string {
  if (space.closedAt) return 'Archived';
  if (space.holder.kind === 'released') return 'Closed';
  switch (space.status?.primaryColor) {
    case 'green': return 'Working';
    case 'blue': return 'Waiting';
    case 'orange': return 'Needs attention';
    case 'red': return 'Failed';
    case 'dim': return 'Not started';
    default: return 'Status unknown';
  }
}

/** Row suffix: the machine holding the space, or `released` when it is closed in the cloud but not archived. */
export function spaceHolderLabel(space: Pick<AgentScopeView, 'closedAt' | 'holder'>): string | null {
  if (space.closedAt) return null;
  switch (space.holder.kind) {
    case 'held': return space.holder.label;
    case 'released': return 'released';
    case 'unknown': return null;
  }
}

export function StatusDot({ color, pulse = false }: { color: WorkspaceStatusColor; pulse?: boolean }) {
  return <span className="status-dot" data-pulse={pulse || undefined} style={{ color: STATUS_COLOR[color] }} aria-hidden />;
}

// ── Page scaffolding shared by the wide views ──
export function PageHeader({ kicker, title, description, actions }: { kicker?: ReactNode; title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return <header className="flex items-end justify-between gap-6 pb-6">
    <div className="flex min-w-0 flex-col gap-1">
      {kicker ? <span className="text-caption text-muted-foreground">{kicker}</span> : null}
      <h1 className="text-display font-semibold tracking-tight text-foreground">{title}</h1>
      {description ? <p className="max-w-2xl text-body text-muted-foreground">{description}</p> : null}
    </div>
    {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
  </header>;
}
export function PageCanvas({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <ScrollArea className="min-h-0 flex-1" viewportClassName="h-full"><div className={`mx-auto w-full max-w-5xl px-8 pb-24 pt-8 ${className}`}>{children}</div></ScrollArea>;
}
export function EmptyState({ icon, title, description, action }: { icon?: ReactNode; title: ReactNode; description?: ReactNode; action?: ReactNode }) {
  const shape = useShape();
  return <section className={`${shape.container} flex min-h-52 flex-col items-center justify-center gap-2 bg-surface-2 p-8 text-center shadow-surface-1`}>
    {icon ? <span className="text-muted-foreground">{icon}</span> : null}
    <strong className="text-subtitle font-semibold text-foreground">{title}</strong>
    {description ? <p className="max-w-md text-body text-muted-foreground">{description}</p> : null}
    {action ? <div className="pt-2">{action}</div> : null}
  </section>;
}

export function TranscriptHistoryNotice({ loading, error, onRetry }: NonNullable<GitSpaceShellProps['history']>) {
  if (!loading && !error) return null;
  return <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 sm:px-6">
    <div className="min-w-0 flex-1">
      {loading ? <p role="status" className="flex items-center gap-2 text-caption text-muted-foreground"><ThinkingIndicator size="compact" />Loading transcript history…</p> : null}
      {error ? <p role="alert" className="text-caption text-destructive [overflow-wrap:anywhere]">Transcript history could not be loaded: {error}</p> : null}
    </div>
    {error ? <Button variant="ghost" className="min-h-10" disabled={loading} onClick={onRetry}>Retry transcript</Button> : null}
  </div>;
}

// ── Agent canvas ──
function AgentCanvas({ workspace, mainAgent, sessionControls, controlsError, onRetryAgent, turns, transcript, history, transport, onSend, pending, error, onReopenSpace, onClaimWorkspace, claimMachines = [], homeMachineId = null, defaultMachineId = null, checkpoint = null, providers, skills, banner }: {
  workspace: AgentScopeView;
  mainAgent: GitSpaceShellProps['mainAgent'];
  sessionControls?: SessionControlsProps;
  controlsError?: string;
  onRetryAgent?: GitSpaceShellProps['onRetryAgent'];
  turns: TurnBlock[];
  transcript?: TranscriptHistory;
  history?: GitSpaceShellProps['history'];
  transport: TransportBlock[];
  onSend?: GitSpaceShellProps['onSend'];
  pending: boolean;
  error?: string;
  onReopenSpace?: GitSpaceShellProps['onReopenSpace'];
  onClaimWorkspace?: GitSpaceShellProps['onClaimWorkspace'];
  claimMachines?: GitSpaceShellProps['claimMachines'];
  homeMachineId?: GitSpaceShellProps['homeMachineId'];
  defaultMachineId?: GitSpaceShellProps['defaultMachineId'];
  checkpoint?: GitSpaceShellProps['checkpoint'];
  providers?: readonly ProviderAuthView[];
  skills?: readonly SkillView[];
  banner?: ReactNode;
}) {
  const shape = useShape();
  const running = mainAgent ? mainAgent.state === 'running' || mainAgent.state === 'permission-needed' || mainAgent.state === 'retrying' : false;
  const pendingAsk = sessionControls?.value.pendingAsk ?? null;
  // Released: closed in the cloud with its files kept somewhere; the transcript above is the checkpoint, read-only.
  const released = !workspace.closedAt && workspace.holder.kind === 'released';
  const inactive = mainAgent?.controlsAvailable === false;
  const idle = !!workspace.closedAt || !mainAgent || mainAgent.state === 'closed' || released || inactive;
  const [chosenMachineId, setChosenMachineId] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const openingRef = useRef(false);
  const open = async (): Promise<void> => {
    if (openingRef.current) return;
    openingRef.current = true;
    setOpening(true);
    setOpenError(null);
    try {
      if (workspace.closedAt) await onClaimWorkspace?.(workspace.id, null);
      else if (released && claimMachineId) await onClaimWorkspace?.(workspace.id, claimMachineId);
      else if (onRetryAgent) await onRetryAgent();
      else await onReopenSpace?.(workspace.id);
    } catch (failure) { setOpenError(failure instanceof Error ? failure.message : String(failure)); }
    finally { openingRef.current = false; setOpening(false); }
  };
  const claimMachineId = [chosenMachineId, defaultMachineId, homeMachineId, claimMachines[0]?.id ?? null]
    .find((candidate): candidate is string => !!candidate && claimMachines.some((machine) => machine.id === candidate)) ?? null;
  const lastMachine = checkpoint?.lastMachineId ? claimMachines.find((machine) => machine.id === checkpoint.lastMachineId)?.label ?? checkpoint.lastMachineId : null;
  const idleTitle = workspace.closedAt
    ? (workspace.kind === 'project' ? 'Project archived' : 'Workspace archived')
    : released
      ? `Closed${lastMachine ? ` · last on ${lastMachine}` : ''}`
      : mainAgent?.failed ? 'Agent failed'
        : inactive ? mainAgent.recovering ? 'Agent is recovering' : 'Agent is inactive'
          : `${workspace.kind === 'project' ? 'Base' : PHASE_LABEL[workspace.phase]} agent not started`;
  const idleDetail = workspace.closedAt
    ? 'Files, history, artifacts, and review state are preserved.'
    : released
      ? 'Read-only until it is reopened; local files are retained.'
      : mainAgent?.recovering ? 'Restoring the saved session. Prompts become available when recovery finishes.'
        : inactive ? 'Files and transcript are preserved. Retry when you are ready.' : 'Start this space’s canonical agent.';
  const virtualTranscript = transcript !== undefined;
  // Chat semantics: open at the newest message and follow new content unless
  // the reader has scrolled up to look at something.
  const viewport = useRef<HTMLDivElement | null>(null);
  const composerOverlay = useRef<HTMLDivElement | null>(null);
  const [composerOverlayHeight, setComposerOverlayHeight] = useState(0);
  useLayoutEffect(() => {
    const element = composerOverlay.current;
    if (!element) return;
    const measure = () => setComposerOverlayHeight(element.offsetHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const following = useRef(true);
  const touchStartTop = useRef<number | null>(null);
  const onTranscriptScroll = useCallback(() => {
    const element = viewport.current;
    if (element) following.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
  }, []);
  const onTranscriptTouchStart = useCallback(() => {
    touchStartTop.current = viewport.current?.scrollTop ?? null;
  }, []);
  const onTranscriptTouchEnd = useCallback(() => {
    const start = touchStartTop.current;
    touchStartTop.current = null;
    const element = viewport.current;
    if (!element || start === null) return;
    if (element.scrollTop !== start) onTranscriptScroll();
    else if (following.current) element.scrollTop = element.scrollHeight;
  }, [onTranscriptScroll]);
  // Touch detection replaces the viewport after mount; bind to the actual node, not the workspace.
  const bindTranscriptViewport = useCallback((root: HTMLDivElement | null) => {
    viewport.current?.removeEventListener('scroll', onTranscriptScroll);
    const element = root?.querySelector<HTMLDivElement>('[data-slot=scroll-area-viewport]') ?? null;
    viewport.current = virtualTranscript ? null : element;
    touchStartTop.current = null;
    if (!element || virtualTranscript) return;
    element.addEventListener('scroll', onTranscriptScroll, { passive: true });
    if (following.current) element.scrollTop = element.scrollHeight;
  }, [onTranscriptScroll, virtualTranscript]);
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!virtualTranscript && element && following.current && touchStartTop.current === null) element.scrollTop = element.scrollHeight;
  }, [turns, transport, composerOverlayHeight, virtualTranscript]);
  return <div className="relative flex min-h-0 min-w-0 flex-1 flex-col" style={{ '--composer-overlay-height': `${composerOverlayHeight}px` } as CSSProperties}>
    {history ? <TranscriptHistoryNotice {...history} /> : null}
    {mainAgent?.errorMessage || mainAgent?.failed ? <p role="alert" className="shrink-0 whitespace-pre-wrap break-words px-4 py-2 text-caption text-destructive">Agent failure: {mainAgent.errorMessage ?? 'No failure reason was recorded for this session.'}</p> : null}
    {controlsError ? <p role="alert" className="shrink-0 whitespace-pre-wrap break-words px-4 py-2 text-caption text-destructive">{controlsError}</p> : null}
    <ScrollArea ref={bindTranscriptViewport} onTouchStartCapture={transcript ? undefined : onTranscriptTouchStart} onTouchEndCapture={transcript ? undefined : onTranscriptTouchEnd} onTouchCancelCapture={transcript ? undefined : onTranscriptTouchEnd} className="min-h-0 flex-1" viewportClassName="h-full">
      {transcript
        ? <VirtualTranscript history={transcript} transport={transport} onAnswer={pendingAsk && sessionControls ? (answers) => sessionControls.onAnswerAsk(pendingAsk.id, answers) : undefined} />
        : <TurnTranscript turns={turns} transport={transport} onAnswer={pendingAsk && sessionControls ? (answers) => sessionControls.onAnswerAsk(pendingAsk.id, answers) : undefined} />}
    </ScrollArea>
    {banner ? <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-center px-6 pt-3"><div className="pointer-events-auto">{banner}</div></div> : null}
    <div ref={composerOverlay} className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center px-6 pb-4">
      <div className="w-full max-w-xl">
        {idle
          ? <div className={`${shape.container} pointer-events-auto flex items-center gap-3 bg-surface-3 p-3 shadow-surface-3`}>
              <span className="text-muted-foreground"><Archive width={16} height={16} strokeWidth={1.5} /></span>
              <span className="min-w-0 flex-1">
                <span className="block text-body text-foreground">{idleTitle}</span>
                <span className="block text-caption text-muted-foreground">{idleDetail}</span>
              </span>
              {released && claimMachines.length
                ? <span className="flex items-center gap-1 text-caption text-muted-foreground">
                    <span className="max-md:hidden">Open on</span>
                    <Select size="compact" value={claimMachineId ?? ''} disabled={opening} onValueChange={(value) => setChosenMachineId(value)}><SelectTrigger variant="borderless" aria-label="Open on machine" />{selectOptions(claimMachines.map((machine) => ({ value: machine.id, label: machine.label })))}</Select>
                  </span>
                : null}
              <Button variant="secondary" size="compact" className="min-h-10" loading={opening} disabled={opening || (inactive && !released && !workspace.closedAt && !onRetryAgent) || (released && claimMachines.length > 0 && !claimMachineId)} onClick={() => void open()} leadingIcon={glyph(RefreshCcw01)}>{opening ? onRetryAgent ? 'Retrying agent…' : 'Opening…' : workspace.closedAt ? 'Restore' : released ? 'Reopen' : onRetryAgent ? 'Retry agent' : 'Start'}</Button>
              {openError ? <p role="alert" className="text-caption text-destructive">{openError}</p> : null}
            </div>
          : <Composer workspace={workspace} controls={sessionControls} providers={providers} skills={skills} running={running} onSend={onSend} pending={pending} recovering={mainAgent?.recovering} error={error} />}
      </div>
    </div>
  </div>;
}

// ── Projects ──
export function CreateProjectDialog({ open, onOpenChange, onSubmit, pending, error }: { open: boolean; onOpenChange(open: boolean): void; onSubmit(input: CreateProjectInput): Promise<void>; pending: boolean; error: string | null }) {
  const [form, setForm] = useState<Record<'name' | 'baseBranch' | 'repositoryUrl', string>>({ name: '', baseBranch: '', repositoryUrl: '' });
  const set = (key: keyof typeof form) => (value: string) => setForm((current) => ({ ...current, [key]: value }));
  return <Dialog open={open} onOpenChange={(next) => { if (!pending) onOpenChange(next); }}>
    <DialogContent>
      <DialogHeader><DialogTitle>Create or import</DialogTitle><DialogDescription>Paste a repository address to import it, or leave it empty to create a new repository.</DialogDescription></DialogHeader>
      <form id="create-project-form" className="flex flex-col gap-4" onSubmit={(event) => { event.preventDefault(); if (!pending) void onSubmit({ name: form.name.trim(), baseBranch: form.baseBranch.trim() || null, repositoryUrl: form.repositoryUrl.trim() || null }); }}>
        <InputGroup>
          <InputField index={0} label="Project name" placeholder="My project" value={form.name} onChange={set('name')} required autoFocus />
          <InputField index={1} label="Repository address (optional)" placeholder="https://github.com/owner/repository" value={form.repositoryUrl} onChange={set('repositoryUrl')} />
          <InputField index={2} label="Base branch (optional)" placeholder={form.repositoryUrl.trim() ? 'Detect repository default branch' : 'main'} value={form.baseBranch} onChange={set('baseBranch')} />
        </InputGroup>
        <p className="text-caption text-muted-foreground">Use the repository’s root URL, an SSH address, or owner/repository for GitHub. A .git suffix is optional. GitHub imports use your shared SSH key; add it to your GitHub account in Settings → Git.</p>
        {error ? <p role="alert" className="text-caption text-destructive">{error}</p> : null}
      </form>
      <DialogFooter>
        <Button variant="secondary" type="button" disabled={pending} onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button type="submit" form="create-project-form" variant="primary" loading={pending} disabled={pending}>{pending ? 'Creating project…' : 'Create project'}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

export function CreateWorkspaceDialog({ projectId, workspaces, initialPhase = 'code', onOpenChange, onSubmit, pending, error }: { projectId: string | null; workspaces: readonly WorkspacePickerItem[]; initialPhase?: WorkspaceView['phase']; onOpenChange(open: boolean): void; onSubmit(input: CreateWorkspaceInput): Promise<void>; pending: boolean; error: string | null }) {
  const [form, setForm] = useState<Record<'name' | 'branch' | 'sourceRef', string>>({ name: '', branch: '', sourceRef: '' });
  const [sourceKind, setSourceKind] = useState<CreateWorkspaceInput['sourceKind']>('base');
  const [phase, setPhase] = useState<WorkspaceView['phase']>(initialPhase);
  const [dependsOn, setDependsOn] = useState<string[]>([]);
  const set = (key: keyof typeof form) => (value: string) => setForm((current) => ({ ...current, [key]: value }));
  const candidates = workspaces.filter((workspace) => workspace.projectId === projectId && !workspace.closedAt);
  const source = sourceKind === 'workspace' ? candidates.find((workspace) => workspace.id === form.sourceRef || workspace.name === form.sourceRef) ?? null : null;
  const dependencies = [...(source ? [source] : []), ...dependsOn.flatMap((id) => candidates.find((workspace) => workspace.id === id) ?? [])];
  const ceiling = dependencies.find((dependency) => dependency.phase != null && PHASES.indexOf(dependency.phase) < PHASES.indexOf(phase));
  return <Dialog open={projectId !== null} onOpenChange={(next) => { if (!pending) onOpenChange(next); }}>
    <DialogContent>
      <DialogHeader><DialogTitle>Create from source</DialogTitle><DialogDescription>Start a workspace from a branch, pull request, tag, commit, or another workspace.</DialogDescription></DialogHeader>
      <form id="create-workspace-form" className="flex flex-col gap-4" onSubmit={(event) => { event.preventDefault(); if (projectId && !pending) void onSubmit({ projectId, name: form.name, branch: form.branch, phase, sourceKind, sourceRef: form.sourceRef, dependsOn: dependsOn.filter((id) => id !== source?.id) }); }}>
        <InputGroup>
          <InputField index={0} label="Name" value={form.name} onChange={set('name')} required autoFocus />
          <InputField index={1} label="Branch" placeholder="feature/my-change" value={form.branch} onChange={set('branch')} required />
          <InputField index={2} label="Source reference" placeholder="main, workspace id, PR number, tag, or SHA" value={form.sourceRef} onChange={set('sourceRef')} error={error ?? undefined} />
        </InputGroup>
        <div className="grid grid-cols-2 gap-3">
          <Select value={sourceKind} onValueChange={(value) => setSourceKind(value as CreateWorkspaceInput['sourceKind'])}><SelectTrigger aria-label="Source" />{selectOptions([{ value: 'base', label: 'Base branch' }, { value: 'branch', label: 'Branch' }, { value: 'workspace', label: 'Workspace' }, { value: 'pull-request', label: 'Pull request' }, { value: 'tag', label: 'Tag' }, { value: 'commit', label: 'Commit' }])}</Select>
          <Select value={phase} onValueChange={(value) => setPhase(value as WorkspaceView['phase'])}><SelectTrigger aria-label="Phase" />{selectOptions(PHASES.map((item) => ({ value: item, label: PHASE_LABEL[item] })))}</Select>
        </div>
        {sourceKind === 'workspace' ? <section className="flex flex-col gap-2">
          <span className="text-caption font-medium text-muted-foreground">{source ? <>Stacked on <strong className="text-foreground">{source.name}</strong> · <span className="font-mono">{source.branch}</span></> : 'Stacked on'}</span>
          {source ? null : <WorkspacePicker workspaces={candidates} onPick={set('sourceRef')} label="Pick the source workspace" placeholder="Search for the workspace to stack on" empty="No open workspaces to stack on." />}
        </section> : null}
        <section className="flex flex-col gap-2">
          <span className="flex flex-wrap items-center gap-1 text-caption font-medium text-muted-foreground">Depends on{dependencies.length ? null : <span className="font-normal"> · none</span>}
            {dependencies.map((dependency) => <span key={dependency.id} className="inline-flex items-center gap-0.5">
              <Badge variant="dot" size="compact" color={dependency.id === source?.id ? 'blue' : 'gray'}>{dependency.name}</Badge>
              {dependency.id === source?.id ? null : <Button variant="ghost" size="icon-compact" type="button" aria-label={`Remove dependency ${dependency.name}`} onClick={() => setDependsOn((current) => current.filter((id) => id !== dependency.id))}><XClose width={12} height={12} strokeWidth={1.5} /></Button>}
            </span>)}
          </span>
          <WorkspacePicker workspaces={candidates} exclude={dependencies.map((dependency) => dependency.id)} onPick={(id) => setDependsOn((current) => [...current, id])} label="Add a dependency" placeholder="Search workspaces to depend on" limit={4} empty="No other open workspaces." />
          {ceiling ? <p className="text-caption text-destructive">{PHASE_LABEL[phase]} is ahead of {ceiling.name} ({workspacePhaseLabel(ceiling.phase)}); a workspace cannot pass the phase of what it depends on.</p> : null}
        </section>
      </form>
      <DialogFooter>
        <Button variant="secondary" type="button" disabled={pending} onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button type="submit" form="create-workspace-form" variant="primary" loading={pending} disabled={pending || ceiling !== undefined}>{pending ? 'Creating workspace…' : 'Create workspace'}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}


// ── Resize handles ──
function InspectorResizeHandle({ width, onWidth }: { width: number; onWidth: (width: number) => void }) {
  return <div className="inspector-resize-handle" role="separator" aria-label="Resize inspector" aria-orientation="vertical" tabIndex={0} onDoubleClick={() => onWidth(440)} onPointerDown={(event) => {
    const handle = event.currentTarget;
    const startX = event.clientX;
    const startWidth = width;
    const maxWidth = Math.max(340, Math.min(1200, (handle.parentElement?.getBoundingClientRect().width ?? window.innerWidth) - 420));
    handle.setPointerCapture(event.pointerId);
    const move = (next: PointerEvent): void => onWidth(Math.min(maxWidth, Math.max(300, startWidth + startX - next.clientX)));
    const finish = (): void => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', finish);
      handle.removeEventListener('pointercancel', finish);
      if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
  }} onKeyDown={(event) => {
    if (event.key === 'ArrowLeft') onWidth(Math.min(1200, width + 20));
    if (event.key === 'ArrowRight') onWidth(Math.max(300, width - 20));
  }} />;
}

function TerminalResizeHandle({ height, onHeight }: { height: number; onHeight: (height: number) => void }) {
  return <div className="terminal-resize-handle" role="separator" aria-label="Resize terminal pane" aria-orientation="horizontal" tabIndex={0} onPointerDown={(event) => {
    const handle = event.currentTarget;
    const startY = event.clientY;
    const startHeight = height;
    const maxHeight = Math.max(220, (handle.parentElement?.getBoundingClientRect().height ?? 700) - 180);
    handle.setPointerCapture(event.pointerId);
    const move = (next: PointerEvent): void => onHeight(Math.min(maxHeight, Math.max(180, startHeight + startY - next.clientY)));
    const finish = (): void => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', finish);
      handle.removeEventListener('pointercancel', finish);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
  }} onKeyDown={(event) => {
    if (event.key === 'ArrowUp') onHeight(height + 20);
    if (event.key === 'ArrowDown') onHeight(Math.max(180, height - 20));
  }} />;
}

// ── Shell ──
export function GitSpaceShell({ projects, workspace, baseSpace, workspaces, mainAgent, turns, transcript, history, transport, machines = [], onSend, sessionControls, controlsError, onRetryAgent, onSetWorkspacePhase, sendPending = false, sendError, onSelectWorkspace, onSelectProject, onCloseSpace, onReopenSpace, onArchiveWorkspace, onClaimWorkspace, claimMachines, homeMachineId, defaultMachineId, checkpoint, onMoveWorkspace, onCreateProject, onCreateWorkspace, onOpenSettings, onNavigateView, terminals, skills, renderInspector, renderEnvironmentStatus, user, providers, deployment, launchBanner }: GitSpaceShellProps) {
  const accountSidebar = useContext(AccountSidebarContext);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [inspectorSection, setInspectorSection] = useState<'environment' | undefined>();
  const [resourceRequest, setResourceRequest] = useState<{ spaceId: string; request: ResourceRequest } | null>(null);
  const [inspectorWidth, setInspectorWidth] = useState(() => {
    if (typeof window === 'undefined') return 440;
    const stored = Number(window.localStorage.getItem('gitspace:inspector-width'));
    return Number.isFinite(stored) && stored > 0 ? Math.min(1200, Math.max(300, stored)) : 440;
  });
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [terminalHeight, setTerminalHeight] = useState(300);
  const [newWorkspaceFor, setNewWorkspaceFor] = useState<{ projectId: string; phase: WorkspaceView['phase'] } | null>(null);
  const [newProject, setNewProject] = useState(false);
  const [createPending, setCreatePending] = useState(false);
  const createPendingRef = useRef(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [closePendingSpaceId, setClosePendingSpaceId] = useState<string | null>(null);
  const [closeError, setCloseError] = useState<string | null>(null);
  const [openPendingSpaceId, setOpenPendingSpaceId] = useState<string | null>(null);
  const openPendingRef = useRef(false);
  const requestOpen = async (spaceId: string, restore = false): Promise<void> => {
    if (openPendingRef.current) return;
    openPendingRef.current = true;
    setOpenPendingSpaceId(spaceId);
    setCloseError(null);
    try {
      if (restore) await onClaimWorkspace?.(spaceId, null);
      else await onReopenSpace?.(spaceId);
    } catch (cause) { setCloseError(cause instanceof Error ? cause.message : String(cause)); }
    finally { openPendingRef.current = false; setOpenPendingSpaceId(null); }
  };
  const restoreHome = onClaimWorkspace ? (spaceId: string) => requestOpen(spaceId, true) : undefined;
  const requestClose = async (spaceId: string): Promise<void> => {
    if (!onCloseSpace || closePendingSpaceId) return;
    setClosePendingSpaceId(spaceId);
    setCloseError(null);
    try {
      await onCloseSpace(spaceId);
    } catch (failure) {
      setCloseError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setClosePendingSpaceId(null);
    }
  };

  const updateInspectorWidth = (width: number): void => {
    const next = Math.round(width);
    setInspectorWidth(next);
    window.localStorage.setItem('gitspace:inspector-width', String(next));
  };
  const navigate = (nextView: AppView): void => {
    onNavigateView?.(nextView);
    if (nextView !== 'agent') { setInspectorOpen(false); setTerminalOpen(false); }
  };
  const sidebarProjects = useMemo<SidebarProject[]>(() => {
    const byProject = new Map<string, SidebarProject>((projects ?? []).map((item) => [item.id, { id: item.id, name: item.name, lifecycle: item.lifecycle, workspaces: [] }]));
    byProject.set(baseSpace.projectId, { ...byProject.get(baseSpace.projectId), id: baseSpace.projectId, name: baseSpace.projectName, base: baseSpace, workspaces: [] });
    for (const item of workspaces) {
      const entry: SidebarProject = byProject.get(item.projectId) ?? { id: item.projectId, name: item.projectName, workspaces: [] };
      entry.workspaces.push({ id: item.id, projectId: item.projectId, name: item.name, branch: item.branch, closedAt: item.closedAt, runtime: item });
      byProject.set(item.projectId, entry);
    }
    return [...byProject.values()];
  }, [projects, baseSpace, workspaces]);
  const running = mainAgent?.state === 'running';
  const recovering = mainAgent?.recovering === true;

  const sidebar: AppSidebarProps = {
    view: 'agent',
    onView: navigate,
    selected: { projectId: workspace.projectId, workspaceId: workspace.kind === 'workspace' ? workspace.id : null },
    projects: sidebarProjects,
    machines,
    onSelectProject,
    onSelectWorkspace: (target) => { onSelectWorkspace?.(target.id); navigate('agent'); },
    onClose: requestClose,
    closePendingSpaceId,
    onReopen: onReopenSpace ? requestOpen : undefined,
    onArchive: onArchiveWorkspace,
    onRestore: restoreHome,
    onMove: onMoveWorkspace,
    onNewWorkspace: onCreateWorkspace ? (projectId) => setNewWorkspaceFor({ projectId, phase: 'code' }) : undefined,
    onNewProject: onCreateProject ? () => setNewProject(true) : undefined,
    onOpenSettings,
    user,
    deployment,
  };
  useLayoutEffect(() => { accountSidebar?.(sidebar); });
  useLayoutEffect(() => () => { accountSidebar?.(null); }, [accountSidebar]);
  const content = <ResourceNavigation.Provider value={renderInspector ? (request) => { setResourceRequest({ spaceId: workspace.id, request }); setInspectorSection(undefined); setInspectorOpen(true); } : null}>
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <SidebarInsetTopbar className="pr-3">
        <nav aria-label="Location" className="flex min-w-0 flex-1 items-center gap-2 text-body">
          <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground max-md:hidden"><GitBranch01 width={14} height={14} strokeWidth={1.5} /><span className="truncate">{workspace.projectName}</span><span>/</span><span className="truncate font-mono text-caption">{workspace.branch}</span></span>
          {workspace.kind === 'workspace' ? <><span className="text-muted-foreground max-md:hidden">·</span><span className="truncate font-semibold text-foreground">{workspace.name}</span></> : null}
        </nav>
        <div className="flex items-center gap-1">
            {renderEnvironmentStatus?.(() => { setInspectorSection('environment'); setInspectorOpen(true); })}
            <span className="flex items-center gap-2 pr-2 text-caption text-muted-foreground"><StatusDot color={workspace.status.primaryColor} pulse={running || recovering} /><span className="max-md:hidden">{recovering ? 'Recovering agent…' : workspaceStatusLabel(workspace)}</span></span>
            {workspace.kind === 'workspace' && onSetWorkspacePhase ? <Select size="compact" value={workspace.phase} onValueChange={(value) => void onSetWorkspacePhase(workspace.id, value as WorkspaceView['phase'])}><SelectTrigger variant="borderless" aria-label="Workspace phase" />{selectOptions(PHASES.map((phase) => ({ value: phase, label: PHASE_LABEL[phase] })))}</Select> : null}
            {!workspace.closedAt && workspace.holder.kind === 'released' && onReopenSpace ? <Button variant="secondary" size="compact" loading={openPendingSpaceId === workspace.id} disabled={openPendingSpaceId !== null} onClick={() => void requestOpen(workspace.id)} leadingIcon={glyph(RefreshCcw01)}>{openPendingSpaceId === workspace.id ? 'Opening…' : 'Reopen'}</Button> : null}
            {!workspace.closedAt && workspace.holder.kind !== 'released' && onCloseSpace ? <Button variant="ghost" size="compact" loading={closePendingSpaceId === workspace.id} disabled={closePendingSpaceId !== null} onClick={() => void requestClose(workspace.id)} leadingIcon={glyph(XClose)}>{closePendingSpaceId === workspace.id ? running ? 'Stopping agent…' : 'Closing…' : running ? 'Stop and close' : 'Close'}</Button> : null}
            {sessionControls?.value.context ? <Tooltip content={`${Math.round(sessionControls.value.context.tokens).toLocaleString()} of ${Math.round(sessionControls.value.context.contextWindow).toLocaleString()} tokens`} side="bottom"><span className="tabular-nums px-2 text-caption text-muted-foreground">{Math.round(sessionControls.value.context.percent)}%</span></Tooltip> : null}
            {terminals ? <Tooltip content="Terminals" side="bottom"><Button variant="ghost" size="icon-compact" aria-label="Open terminals" aria-pressed={terminalOpen} onClick={() => setTerminalOpen((value) => !value)}><Terminal width={16} height={16} strokeWidth={1.5} /></Button></Tooltip> : null}
            {renderInspector ? <Tooltip content="Inspector" side="bottom"><Button variant="ghost" size="icon-compact" aria-label="Open Inspector" aria-pressed={inspectorOpen} onClick={() => setInspectorOpen((value) => !value)}><LayoutRight width={16} height={16} strokeWidth={1.5} /></Button></Tooltip> : null}
        </div>
      </SidebarInsetTopbar>
      {closeError ? <p role="alert" className="shrink-0 px-4 py-1 text-right text-caption text-destructive">{closeError}</p> : null}
      {openPendingSpaceId ? <p role="status" className="shrink-0 px-4 py-1 text-right text-caption text-muted-foreground">Opening workspace and checking canonical cloud state…</p> : null}

      <div className="workspace-workbench" data-terminal-open={terminalOpen && !!terminals || undefined} style={{ '--inspector-width': `${inspectorWidth}px`, '--terminal-height': `${terminalHeight}px` } as CSSProperties}>
            <div className="workspace-content">
              <div className="conversation-stage">
                <AgentCanvas key={workspace.id} workspace={workspace} mainAgent={mainAgent} sessionControls={sessionControls} controlsError={controlsError} onRetryAgent={onRetryAgent} turns={turns} transcript={transcript} history={history} transport={transport} onSend={onSend} pending={sendPending || closePendingSpaceId === workspace.id} error={sendError} onReopenSpace={onReopenSpace} onClaimWorkspace={onClaimWorkspace} claimMachines={claimMachines} homeMachineId={homeMachineId} defaultMachineId={defaultMachineId} checkpoint={checkpoint} providers={providers} skills={skills} banner={launchBanner} />
              </div>
              {inspectorOpen && renderInspector ? <InspectorResizeHandle width={inspectorWidth} onWidth={updateInspectorWidth} /> : null}
              {inspectorOpen && renderInspector ? <aside className="inspector-pane flex min-w-0 flex-col" aria-label="Inspector">{renderInspector(() => { setInspectorOpen(false); setInspectorSection(undefined); setResourceRequest(null); }, inspectorSection, resourceRequest?.spaceId === workspace.id ? resourceRequest.request : undefined)}</aside> : null}
            </div>
            {terminalOpen && terminals ? <><TerminalResizeHandle height={terminalHeight} onHeight={setTerminalHeight} /><section className="min-h-0 min-w-0 overflow-hidden"><WorkspaceTerminals {...terminals} onClose={() => setTerminalOpen(false)} /></section></> : null}
          </div>
    </div>
    {onCreateProject ? <CreateProjectDialog open={newProject} onOpenChange={(open) => { setNewProject(open); if (!open) setCreateError(null); }} pending={createPending} error={newProject ? createError : null} onSubmit={async (input) => {
      if (createPendingRef.current) return;
      createPendingRef.current = true;
      setCreatePending(true);
      setCreateError(null);
      try { await onCreateProject(input); setNewProject(false); } catch (failure) { setCreateError(failure instanceof Error ? failure.message : String(failure)); } finally { createPendingRef.current = false; setCreatePending(false); }
    }} /> : null}
    {onCreateWorkspace ? <CreateWorkspaceDialog key={newWorkspaceFor ? `${newWorkspaceFor.projectId}:${newWorkspaceFor.phase}` : 'closed'} projectId={newWorkspaceFor?.projectId ?? null} initialPhase={newWorkspaceFor?.phase} workspaces={workspaces} onOpenChange={(open) => { if (!open) { setNewWorkspaceFor(null); setCreateError(null); } }} pending={createPending} error={createError} onSubmit={async (input) => {
      if (createPendingRef.current) return;
      createPendingRef.current = true;
      setCreatePending(true);
      setCreateError(null);
      try { await onCreateWorkspace(input); setNewWorkspaceFor(null); } catch (failure) { setCreateError(failure instanceof Error ? failure.message : String(failure)); } finally { createPendingRef.current = false; setCreatePending(false); }
    }} /> : null}
  </ResourceNavigation.Provider>;
  return accountSidebar ? content : <SidebarProvider className="gitspace-shell" persist={false}><AppSidebar {...sidebar} /><SidebarInset className="overflow-hidden">{content}</SidebarInset></SidebarProvider>;
}
