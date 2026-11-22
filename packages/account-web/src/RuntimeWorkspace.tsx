import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { canonicalDriveResourceUrl, parseResourceUri, resourceMediaType } from '@gitspace/protocol/resource-uri';
import type { ResourceFile } from './resource-files.js';
import { APPROVAL_DECISION, APPROVE, REJECT } from '@gitspace/blocks';
import { useResultQuery } from 'result-rpc/react';
import type { CloudProjectOperation, InspectorView, LaunchSourceView, SpaceView } from '@gitspace/protocol';
import { InspectorViewCodec, rpcErrors, SpaceViewCodec } from '@gitspace/protocol/rpc-contract';
import { questionState, RuntimeIdentitySchema, RuntimeMachineIdSchema, RuntimeSnapshotSchema, type RuntimeSnapshot } from '@gitspace/protocol-runtime';
import { Button, ThinkingIndicator } from '@gitspace/ui';
import { EmptyState, GitSpaceShell, StatusDot, type GitSpaceShellProps, type SessionControlsProps } from './GitSpaceShell.js';
import { useWorkspaceRuntime } from './useWorkspaceRuntime.js';
import { useWorkspaceDraft } from './useWorkspaceDraft.js';
import { useCloudSessionControls } from './useCloudSessionControls.js';
import { useTranscriptHistory, type TranscriptHistory, type TranscriptHistorySource } from './useTranscriptHistory.js';
import { forgetFirstPaintGroup, savedCopy, schemaForm, touchFirstPaintGroup, useSavedCopy, workspaceGroup } from './first-paint-cache.js';
import { savedTranscriptSchema } from './transcriptHistoryCache.js';
import { useInference } from './InferenceContext.js';
import { SpeechProvider } from './SpeechProvider.js';
import { useRetainedQueryValue } from './useRetainedRead.js';
import { rpcClient } from './rpc-client.js';
import { ComposerStagingProvider, RequirementAcceptance } from './chat/staging.js';
import { CommentLayerProvider } from './comments/CommentLayer.js';
import { CommentsDocumentSchema, type CommentAnchor } from '@gitspace/protocol-runtime/comments';
import { artifactUploadRpcClient } from './artifact-upload-rpc.js';
import { rpcErrorMessage } from './rpc-error-message.js';
import { runtimeScope, runtimeTurns } from './runtime-shell-adapter.js';
import { workspaceMachines, workspaceMachinesSummary, workspaceStatus } from './workspace-status.js';
import { RELEASE_TARGETS } from './release.js';
import { CanonicalLaunchDialog, LaunchMachineDialog, LaunchSheet } from './LaunchSheet.js';
import { useRuntimeLaunch } from './useRuntimeLaunch.js';
import { LiveChatter } from './chatter/LiveChatter.js';
import type { ResourceRequest } from './ResourceNavigation.js';
import type { WorkspaceTerminalMachine } from './WorkspaceTerminals.js';
import type { RuntimeSessionCommand, SessionControlView } from '@gitspace/protocol-runtime/session-controls';
import { QuestionCardsContext, type QuestionCards } from './QuestionCards.js';
import { BrowserWatchDialog } from './BrowserWatchDialog.js';
import { accountLiveKey } from '@gitspace/protocol/live-notice';
import { useLiveChanges } from './live-notices.js';
import { useEventRefresh, useProjectChanges } from './SynchronizationProvider.js';
import { RepositoryAccessCard, rememberGitHubInstall, useRepositoryBridgeToasts } from './GitHubAccess.js';
import { useToasts } from './toasts.js';
import { operationActive, OperationStatusLine } from './OperationProgress.js';

export interface RuntimeInspectorContext {
  snapshot: RuntimeSnapshot;
  conversationId: string | undefined;
  sessionId: string | null;
  /** The viewed conversation's session controls (its plan and todo list); absent until they load. */
  controls?: SessionControlView;
  turns: GitSpaceShellProps['turns'];
  scope: GitSpaceShellProps['workspace'];
  workspaces: GitSpaceShellProps['workspaces'];
  onClose(): void;
  onAskAgent(text: string): Promise<void>;
  /** Adds `text` to the end of the chat composer's draft for you to finish and send; absent until the draft is loaded. */
  onCompose?: (text: string) => void;
  onSetRelations?: GitSpaceShellProps['onSetWorkspaceRelations'];
  initialView?: 'environment' | 'browser' | 'goal';
  resourceRequest?: ResourceRequest;
  /** Open the Change Guide at the section of this guide entity (a block or a comment in the chat asked to). */
  guideSection?: { entity: string; serial: number };
  /** Open the drive file a comment is on, scrolled to its anchor (a comment in the chat asked to). */
  driveFocus?: { anchor: CommentAnchor; serial: number };
  /** Opens the terminal panel on `machineId` and selects the named terminal, such as an interactive setup run. */
  onOpenTerminal(machineId: string, name: string): void;
}
export interface RuntimeWorkspaceProps {
  projectId: string;
  workspaceId: string;
  onOpenSettings: GitSpaceShellProps['onOpenSettings'];
  onSelectWorkspace(id: string): void;
  onSelectProject(id: string): void;
  renderInspector(context: RuntimeInspectorContext): ReactNode;
  creation?: ReactNode;
  /** The project change running or failed, shown in the project page's top bar. */
  projectOperation?: CloudProjectOperation | null;
  /** Opens the project's settings, where the change shows its steps. */
  onOpenProjectSettings?(): void;
  /** Shown instead of the workspace when the project has no such workspace. */
  notFound?: ReactNode;
}

/** What the workspace reads besides its runtime snapshot. Requested when the workspace opens, in parallel with
 * `runtime.watch`, and drawn from this browser's saved copies until they answer. */
export interface WorkspaceReads {
  transcript: TranscriptHistory;
  relations: { value: SpaceView | undefined; loaded: boolean; error: unknown; refetch(): Promise<void> };
  providers: { value: GitSpaceShellProps['providers']; error: unknown; refetch(): Promise<void> };
  skills: GitSpaceShellProps['skills'];
}

export function RuntimeWorkspace(props: RuntimeWorkspaceProps) {
  const { projectId, workspaceId } = props;
  const group = workspaceGroup(projectId, workspaceId);
  const saved = useMemo(() => ({
    runtime: savedCopy(group, 'runtime', schemaForm(RuntimeSnapshotSchema)),
    inspection: savedCopy(group, 'inspection', InspectorViewCodec),
    space: savedCopy(group, 'space', SpaceViewCodec),
    transcript: savedCopy(group, 'transcript', schemaForm(savedTranscriptSchema)),
  }), [group]);
  useEffect(() => { touchFirstPaintGroup(group); }, [group]);
  const viewInput = { projectId, workspaceId: workspaceId === projectId ? null : workspaceId };
  const readKey = JSON.stringify([projectId, workspaceId]);
  const inspection = useResultQuery(rpcClient.inspector.view, viewInput);
  // The project has no such workspace (a link naming the wrong project, or a deleted workspace): nothing else is read.
  const missing = inspection.state === 'failure' && (rpcErrors.workspaceNotFound.is(inspection.error) || rpcErrors.projectNotFound.is(inspection.error));
  useEffect(() => { if (missing) forgetFirstPaintGroup(group); }, [missing, group]);
  const runtime = useWorkspaceRuntime(projectId, workspaceId, !missing, saved.runtime);
  const inspectionValue = useSavedCopy(saved.inspection, useRetainedQueryValue(inspection, readKey));
  const relationQuery = useResultQuery(rpcClient.space.view, viewInput, { enabled: !missing });
  const relationValue = useSavedCopy(saved.space, useRetainedQueryValue(relationQuery, readKey));
  const inference = useInference();
  const profileId = inference?.state?.assignments.find(item => item.projectId === projectId)?.profileId ?? '';
  const providers = useResultQuery(rpcClient.providers.list, { profileId }, { enabled: !!profileId && !missing });
  const providerValues = useRetainedQueryValue(providers, profileId);
  const skills = useResultQuery(rpcClient.skills.list, {}, { enabled: !missing });
  const skillValues = useRetainedQueryValue(skills, 'skills');
  const identity = useMemo(() => RuntimeIdentitySchema.parse({ projectId, workspaceId }), [projectId, workspaceId]);
  // The main conversation's transcript does not wait for the snapshot that names it: a session command without a
  // conversation reads the runtime's main one. Once a snapshot (saved or live) names it, pages name it too.
  const conversationId = useRef<string | undefined>(undefined);
  conversationId.current = runtime.snapshot?.conversations.find(item => item.parentId === null)?.id;
  const liveCursor = runtime.live?.cursor ?? null;
  const transcriptSource = useMemo((): TranscriptHistorySource | null => missing ? null : {
    key: readKey, revision: liveCursor, saved: saved.transcript,
    page: async (request, signal) => {
      const response = await rpcClient.runtime.session({ ...identity, ...(conversationId.current ? { conversationId: conversationId.current } : {}), command: { type: 'transcriptPage', request } }, { signal });
      if (response.status === 'error') throw response.error;
      if (!response.value.transcriptPage) throw new Error('The runtime did not return a transcript page.');
      return response.value.transcriptPage;
    },
    content: async (request, signal) => {
      const response = await rpcClient.runtime.session({ ...identity, ...(conversationId.current ? { conversationId: conversationId.current } : {}), command: { type: 'transcriptContent', request } }, { signal });
      if (response.status === 'error') throw response.error;
      if (!response.value.transcriptContent) throw new Error('The runtime did not return transcript content.');
      return response.value.transcriptContent;
    },
  }, [identity, readKey, liveCursor, missing, saved.transcript]);
  const transcript = useTranscriptHistory(transcriptSource);
  const inspectionError = inspection.state === 'failure' && !missing ? rpcErrorMessage(inspection.error, 'Read workspace') : null;
  useToasts([
    runtime.error ? { key: `workspace-runtime:${runtime.error}`, tone: 'error', persistent: true, message: runtime.error, action: { label: 'Reconnect', onClick: runtime.retry } } : null,
    inspectionError ? { key: `workspace-read:${inspectionError}`, tone: 'error', persistent: true, message: inspectionError, action: { label: 'Retry workspace', onClick: () => void inspection.refetch() } } : null,
  ]);
  if (missing) return props.notFound ?? <EmptyState title="Workspace not found" description={rpcErrorMessage(inspection.error, 'Read workspace')} />;
  const reads: WorkspaceReads = {
    transcript,
    relations: { value: relationValue, loaded: relationQuery.state === 'success' && relationQuery.fetch !== 'fetching', error: relationQuery.state === 'failure' ? relationQuery.error : null, refetch: async () => { await relationQuery.refetch(); } },
    providers: { value: providerValues?.providers, error: providers.state === 'failure' ? providers.error : null, refetch: async () => { await providers.refetch(); } },
    skills: skillValues,
  };
  return <>
    {props.creation}
    {runtime.snapshot && inspectionValue ? <RuntimeWorkspaceShell {...props} snapshot={runtime.snapshot} inspection={inspectionValue} connected={runtime.connected} reads={reads} refreshInspection={async () => { await inspection.refetch(); }} /> : <EmptyState icon={<ThinkingIndicator />} title="Loading workspace…" description="Reading the cloud conversation and workspace state." />}
  </>;
}

/** The production shell, fed by accepted runtime snapshots (or this browser's saved copy until one arrives), the
 * workspace's reads, and the existing typed RPC client. */
export function RuntimeWorkspaceShell({ snapshot, inspection, connected, reads, refreshInspection, ...props }: RuntimeWorkspaceProps & { snapshot: RuntimeSnapshot; inspection: InspectorView; connected: boolean; reads: WorkspaceReads; refreshInspection(): Promise<void> }) {
  const conversation = snapshot.conversations.find(item => item.parentId === null);
  const conversationId = conversation?.id;
  const session = useCloudSessionControls(snapshot, conversationId);
  const value = session.result?.control;
  const run = session.run;
  const inference = useInference();
  const deployment = useResultQuery(rpcClient.deployment.status, {}, { enabled: inspection.project.role === 'gitspace-source' });
  const deploymentValue = useRetainedQueryValue(deployment, inspection.project.id);
  const launch = useRuntimeLaunch(deploymentValue, deployment.refetch);
  const [launchRequest, setLaunchRequest] = useState<{ source: LaunchSourceView; targets: typeof RELEASE_TARGETS } | null>(null);
  const relationValue = reads.relations.value;
  // A project whose private repository the GitHub App does not reach syncs through the machine attached to its base
  // workspace under a toast; with no such machine, or while its repository waits for a machine to copy it in (the
  // cloud's import was refused), it shows the ways in instead of a transcript.
  const projectView = inspection.workspace.kind === 'base' && inspection.project.repositoryReference !== null;
  const accessQuery = useResultQuery(rpcClient.github.projectAccess, { projectId: props.projectId }, { enabled: projectView });
  const accessValue = useRetainedQueryValue(accessQuery, props.projectId);
  useEventRefresh(useLiveChanges(accountLiveKey('github')), () => accessQuery.refetch(), projectView);
  // A refused import (a project operation) leaves the repository waiting for a copy.
  useEventRefresh(useProjectChanges(props.projectId), () => accessQuery.refetch(), projectView);
  const blocked = projectView && accessValue && accessValue.state !== 'ready' ? accessValue : null;
  const bridged = blocked && blocked.state !== 'awaits-copy' && !blocked.awaitsCopy && blocked.bridge ? { access: blocked, bridge: blocked.bridge } : null;
  const walled = blocked && !bridged ? blocked : null;
  // The agent's start, which imports the repository, was refused while there was no way in: it starts again once there is.
  const wasWalled = useRef(false);
  useEffect(() => {
    if (walled) { wasWalled.current = true; return; }
    if (!wasWalled.current) return;
    wasWalled.current = false;
    void session.run({ type: 'control' }).catch(() => {});
  }, [walled === null]);
  const installApp = async () => {
    const result = await rpcClient.github.install.start({ projectId: props.projectId });
    if (result.status === 'error') throw result.error;
    rememberGitHubInstall(props.projectId);
    return result.value.url;
  };
  // The chosen machine copies the base branch in, then is attached to the base workspace to keep it in sync.
  const copyThroughMachine = async (machineId: string) => {
    const copied = await rpcClient.project.seed({ projectId: props.projectId, machineId });
    if (copied.status === 'error') throw copied.error;
    const base = RuntimeIdentitySchema.parse({ projectId: props.projectId, workspaceId: props.projectId });
    const attached = await rpcClient.runtime.attachment.cache.request({ ...base, machineId: RuntimeMachineIdSchema.parse(machineId) });
    if (attached.status === 'error') throw attached.error;
    await accessQuery.refetch();
  };
  const [actionError, setActionError] = useState<string | null>(null);
  const [terminalChoice, setTerminalChoice] = useState<{ spaceId: string; machineId: string } | null>(null);
  const scope = useMemo(() => runtimeScope(snapshot, inspection, relationValue), [snapshot, inspection, relationValue]);
  const relationsEditable = reads.relations.loaded && scope.relationsReady;
  const relationAuthority = useRef({ value: relationValue, editable: relationsEditable });
  relationAuthority.current = { value: relationValue, editable: relationsEditable };
  const turns = useMemo(() => runtimeTurns(snapshot, conversationId), [snapshot, conversationId]);
  const identity = useMemo(() => RuntimeIdentitySchema.parse(snapshot), [snapshot.projectId, snapshot.workspaceId]);
  const draft = useWorkspaceDraft(snapshot, connected, async input => {
    const result = await rpcClient.runtime.draft({ ...identity, ...input });
    if (result.status === 'error') throw result.error;
    return result.value;
  });
  const transcript = reads.transcript;
  // Asks, plans, take-over requests and lifecycle approvals answer on their cards in the transcript, which also show
  // how they ended. An open approval that gates a tool (a machine-attach request, the project agent's batch of
  // answers) has no call there and answers above the composer, through the same questions.
  const question = snapshot.questions.find(item => item.conversationId === conversationId && item.kind === 'approval' && item.tool !== undefined && questionState(item) === 'open');
  const controls: SessionControlsProps | undefined = value ? {
    value: question ? { ...value, pendingAsk: { id: question.id, source: 'gitspace', links: [], questions: [{ id: APPROVAL_DECISION, question: question.prompt, header: 'Approval required', multi: false, recommended: null, written: false, options: [APPROVE, REJECT].map(label => ({ label, description: null, preview: null })) }] } } : value,
    onCycleRole: async direction => { await run({ type: 'cycleRole', direction }); },
    onSetModel: async (provider, model) => { await run({ type: 'setModel', provider, model }); },
    onSetThinking: async thinking => { await run({ type: 'setThinking', thinking }); },
    onSetFast: async enabled => { await run({ type: 'setFast', enabled }); },
    onSetGoal: async enabled => { await run({ type: 'setGoal', enabled }); },
    onCompact: async instructions => { await run({ type: 'compact', ...(instructions ? { instructions } : {}) }); },
    onClearQueue: async () => { await run({ type: 'clearQueue' }); },
    onRemoveQueuedMessage: async (kind, index) => { await run({ type: 'removeQueuedMessage', kind, index }); },
    onPromoteQueuedMessage: async index => { await run({ type: 'promoteQueuedMessage', index }); },
    onDismissAutomationRun: async runId => {
      const response = await rpcClient.automations.cancelRun({ projectId: identity.projectId, runId });
      if (response.status === 'error') throw response.error;
      // The withdrawn message leaves the agent's queue without changing anything the controls reread on.
      await run({ type: 'control' });
    },
    onStop: async () => { await run({ type: 'stop' }); },
    onNavigateTree: async entryId => { await run({ type: 'navigateTree', entryId }); transcript.refresh(); },
    onReadHistory: async (request, signal) => { const result = await run({ type: 'historyPage', request }, signal); if (!result.historyPage) throw new Error('The runtime did not return a history page.'); return result.historyPage; },
  } : undefined;
  const ask = async (text: string) => { await run({ type: 'prompt', text }); };
  const perform = async (operation: () => Promise<void>) => { setActionError(null); try { await operation(); } catch (error) { setActionError(rpcErrorMessage(error, 'Workspace action')); } };
  const setRelations: NonNullable<GitSpaceShellProps['onSetWorkspaceRelations']> = async (workspaceId, relations) => {
    if (!relationsEditable || !relationAuthority.current.editable || relationAuthority.current.value !== relationValue || !relationValue?.workspaces.some(workspace => workspace.id === workspaceId)) {
      throw new Error('Workspace relations must finish loading before they can be changed.');
    }
    try {
      const result = await rpcClient.workspace.setRelations({ workspaceId, dependsOn: [...relations.dependsOn], relatedTo: [...relations.relatedTo], stackedOn: relations.stackedOn });
      if (result.status === 'error') throw result.error;
    } finally {
      await Promise.all([reads.relations.refetch(), refreshInspection()]);
    }
  };
  const spaceId = snapshot.workspaceId;
  const status = workspaceStatus(snapshot);
  const machines = workspaceMachines(snapshot);
  const environment = workspaceMachinesSummary(machines);
  // Terminals open only on a ready machine the user picked for this workspace: never a default machine.
  const terminalMachines = machines.flatMap((machine): WorkspaceTerminalMachine[] => machine.ready ? [{ id: machine.id, label: inspection.machines.find(candidate => candidate.id === machine.id)?.label ?? machine.id }] : []);
  const selectTerminalMachine = (machineId: string) => setTerminalChoice({ spaceId, machineId });
  const generation = scope.workspace.generation;
  const acceptRequirement = useCallback(async (requirementId: string, accepted: boolean) => {
    const overview = await rpcClient.inspector.overview({ spaceId, expectedGeneration: generation });
    if (overview.status === 'error') throw overview.error;
    if (!overview.value.goal) throw new Error('This workspace has no goal.');
    const result = await rpcClient.inspector.requirement.setAcceptance({ expectedGeneration: generation, input: { projectId: snapshot.projectId, spaceId, expectedRevision: overview.value.goal.revision, requirementId, accepted } });
    if (result.status === 'error') throw result.error;
  }, [snapshot.projectId, spaceId, generation]);
  // One resolver per workspace version, so every message showing a file shares its URL.
  const resolveResourceFile = useMemo(() => {
    // A repository file's bytes by version and type: one object URL each for the page's life.
    const repositoryUrls = new Map<string, string>();
    return async (uri: string, hash: string | null): Promise<ResourceFile> => {
      const resource = parseResourceUri(uri);
      if (resource?.kind === 'repo') {
        const read = await rpcClient.inspector.repository.file({ spaceId, expectedGeneration: generation, mode: 'current', path: resource.path, ...(resource.commit ? { commit: resource.commit } : {}) });
        if (read.status === 'error') throw new Error(rpcErrorMessage(read.error, 'Open repository file'));
        const bytes = read.value.encoding === 'base64' ? Uint8Array.from(atob(read.value.content), character => character.charCodeAt(0)) : new TextEncoder().encode(read.value.content);
        const mediaType = resourceMediaType(resource.path);
        const version = read.value.blobId ?? undefined;
        const key = version ? `${version}:${mediaType}` : null;
        const url = (key ? repositoryUrls.get(key) : undefined) ?? URL.createObjectURL(new Blob([bytes], { type: mediaType ?? 'application/octet-stream' }));
        if (key) repositoryUrls.set(key, url);
        return { url, downloadUrl: url, size: bytes.length, mediaType, version, expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString() };
      }
      if (resource?.kind !== 'drive') throw new Error('Only drive:// and repo:// files can be shown here');
      // A message's pinned version (`hash`) is served as that version's immutable URL.
      const result = await rpcClient.inspector.artifacts.file({ spaceId, expectedGeneration: generation, url: canonicalDriveResourceUrl(resource, String(spaceId) === String(snapshot.projectId) ? 'base' : 'workspace'), hash });
      if (result.status === 'error') throw new Error(rpcErrorMessage(result.error, 'Open file'));
      const { hash: version, ...file } = result.value;
      return { ...file, version };
    };
  }, [spaceId, snapshot.projectId, generation]);
  const sessionCommand = useCallback(async (command: RuntimeSessionCommand) => {
    const response = await rpcClient.runtime.session({ ...identity, ...(conversationId ? { conversationId } : {}), command });
    if (response.status === 'error') throw response.error;
    return response.value;
  }, [identity, conversationId]);
  const questionCards = useMemo<QuestionCards>(() => ({ questions: snapshot.questions, request: sessionCommand,
    answer: async (questionId, answer) => {
      const response = await rpcClient.runtime.answer({ ...identity, questionId, answer });
      if (response.status === 'error') throw response.error;
    },
    watch: (card, onClose) => <BrowserWatchDialog identity={identity} request={sessionCommand} target={{ source: card.source, groupId: card.groupId, targetId: card.targetId, title: card.title, url: card.url, label: card.browser }} focusInChrome={card.source === 'chrome'} takeover onClose={onClose} /> }), [snapshot.questions, sessionCommand, identity]);
  // The staged answers to the workspace's questions, which wait as chips for the next message.
  const stagedAnswers = useMemo(() => CommentsDocumentSchema.safeParse(snapshot.documents['gitspace.comments']).data?.answers ?? [], [snapshot.documents]);
  const deploymentError = deployment.state === 'failure' ? rpcErrorMessage(deployment.error, 'Read deployment status') : null;
  const relationsError = reads.relations.error !== null ? rpcErrorMessage(reads.relations.error, "Load this project's workspaces") : null;
  useToasts([
    actionError ? { key: `workspace-action:${actionError}`, tone: 'error', message: actionError, onDismiss: () => setActionError(null) } : null,
    status.cloud.conflicts.length ? {
      key: `merge-conflicts:${status.cloud.conflicts.join('\n')}`, tone: 'error', persistent: true,
      message: <><strong className="font-medium">Workspace merge conflicts.</strong> Machine changes reached the cloud working copy with conflicts. Resolve these files before continuing.<ul aria-label="Conflicting files" className="mt-1 list-inside list-disc break-all font-mono">{status.cloud.conflicts.map(path => <li key={path}>{path}</li>)}</ul></>,
    } : null,
    deploymentError ? { key: `deployment-status:${deploymentError}`, tone: 'error', persistent: true, message: deploymentError, action: { label: 'Retry deployment status', onClick: () => void deployment.refetch() } } : null,
    // The account keeps its latest launch after it ends: only one still running, or one that failed, is news.
    launch.launch && !launch.open && launch.launch.status !== 'succeeded' ? { key: `launch-progress:${launch.launch.launchId}:${launch.launch.status}`, tone: launch.launch.status === 'failed' ? 'error' : 'info', persistent: true, message: launch.launch.status === 'failed' ? launch.launch.error ?? 'The launch did not finish.' : 'A launch is running.', action: { label: 'Show launch progress', onClick: () => launch.setOpen(true) } } : null,
    launch.mark ? { key: `launched:${launch.mark.sha}`, tone: 'info', persistent: true, message: <>Now running <strong>{launch.mark.label}</strong></>, action: { label: 'Back to default', onClick: () => void perform(launch.backToDefault) }, onDismiss: launch.dismiss } : null,
    relationsError ? { key: `workspace-relations:${relationsError}`, tone: 'error', persistent: true, message: relationsError, action: { label: 'Retry', onClick: () => void reads.relations.refetch() } } : null,
    relationValue?.statusError ? { key: `workspace-statuses:${relationValue.statusError}`, tone: 'warning', persistent: true, message: `Workspace statuses are unavailable: ${relationValue.statusError}`, action: { label: 'Retry', onClick: () => void reads.relations.refetch() } } : null,
  ]);
  useRepositoryBridgeToasts(bridged, installApp, () => props.onOpenSettings?.('github'));
  return <>
    <QuestionCardsContext.Provider value={questionCards}>
    <CommentLayerProvider conversationId={conversationId} document={snapshot.documents['gitspace.comments']} rows={transcript.rows} generation={transcript.generation} request={sessionCommand}>
    <ComposerStagingProvider answers={stagedAnswers}>
    <RequirementAcceptance.Provider value={acceptRequirement}>
    <SpeechProvider projectId={identity.projectId} workspaceId={identity.workspaceId}>
    {/* No onSend, so a closed composer, until the draft binding exists: text typed before it would be replaced by the workspace draft. A session command in flight only holds the send (sendPending); the box stays editable. */}
    <GitSpaceShell project={{ id: inspection.project.id, name: inspection.project.name, repository: inspection.project.repositoryReference ?? '', connected }} {...scope} mainAgent={{ id: value?.sessionId ?? conversationId ?? 'root', title: conversation?.title ?? 'Workspace agent', state: conversation?.status === 'running' ? 'running' : conversation?.status === 'waiting' ? 'permission-needed' : 'waiting', model: value?.model ?? '', controlsAvailable: true, recovering: !value, failed: conversation?.status === 'failed', errorMessage: conversation?.error ?? null, retry: conversation?.retry ?? null }} turns={turns} transcript={conversationId ? transcript : undefined} history={conversationId ? { loading: transcript.initialLoading, saved: transcript.saved, error: transcript.error, onRetry: transcript.refresh } : undefined} transport={[]} artifacts={[]} sessionControls={controls} skills={reads.skills} providers={reads.providers.value} draft={draft} sendPending={session.pending} onSend={value && draft ? async (text, streamingBehavior, draft, decisions, comments, answers) => { await run({ type: 'prompt', text, streamingBehavior, draftRevision: draft?.draftRevision, draftText: draft?.text, decisions: decisions?.length ? decisions : undefined, comments: comments?.length ? [...comments] : undefined, answers: answers?.length ? [...answers] : undefined }); } : undefined}
      onRetryAgent={async () => { await run({ type: 'resume' }); }} onContinueAgent={async () => { await run({ type: 'continue' }); }} onOpenSettings={props.onOpenSettings} onSelectProject={props.onSelectProject} onSelectWorkspace={props.onSelectWorkspace}
      controlsError={session.error ?? (reads.providers.error !== null ? rpcErrorMessage(reads.providers.error, 'Load provider authentication') : inference?.error) ?? undefined}
      onRetryControls={() => { void run({ type: 'control' }).catch(() => {}); void reads.providers.refetch(); void inference?.refresh(); }}
      runtimeSummary={{ holder: scope.workspace.holder, closedAt: scope.workspace.closedAt, generation: scope.workspace.generation, status: scope.workspace.status, freshness: connected ? 'fresh' : 'stale', detail: connected ? null : 'Reconnecting to cloud runtime' }}
      onSetWorkspacePhase={async (_id, phase, expectedPhase) => { await run({ type: 'setWorkspacePhase', phase, expectedPhase }); await refreshInspection(); }}
      projectOperation={props.projectOperation
        ? <Button variant="ghost" size="compact" className="max-w-80" onClick={props.onOpenProjectSettings}><span className="flex min-w-0 items-center gap-1 text-caption text-muted-foreground"><OperationStatusLine operation={props.projectOperation} /><span className="shrink-0">· Details</span></span></Button>
        : undefined}
      onUpdateBase={props.projectOperation && operationActive(props.projectOperation) ? undefined : () => perform(async () => {
        const result = await rpcClient.project.updateBase({ projectId: inspection.project.id });
        if (result.status === 'error') throw result.error;
      })}
      onSetWorkspaceRelations={relationsEditable ? setRelations : undefined}
      deployment={deploymentValue ? { status: deploymentValue, launch: launch.launch, isGitSpaceProject: inspection.project.role === 'gitspace-source', branch: inspection.project.baseBranch, onLaunch: workspaceId => setLaunchRequest({ source: { kind: 'workspace', workspaceId }, targets: RELEASE_TARGETS }), onLaunchBranch: () => perform(async () => {
        const checked = await rpcClient.deployment.checkCanonical({});
        if (checked.status === 'error') throw checked.error;
        if (!checked.value.canonical) throw new Error(`${inspection.project.baseBranch} has no head to launch`);
        const { repository, branch, commit } = checked.value.canonical;
        setLaunchRequest({ source: { kind: 'canonical', repository, branch, commit }, targets: RELEASE_TARGETS });
      }), onBackToDefault: () => perform(launch.backToDefault) } : null}
      access={walled ? {
        card: onAttachMachine => <RepositoryAccessCard access={walled} copy={{ machines: inspection.machines.filter(machine => machine.state === 'online'), onCopy: copyThroughMachine }} onOpenSettings={() => props.onOpenSettings?.('github')} onInstall={installApp} onAttachMachine={onAttachMachine} />,
        notice: `The project agent starts once GitSpace can read ${walled.state === 'awaits-copy' ? walled.origin : walled.repository}.`,
      } : undefined}
      renderEnvironmentStatus={onInspect => <Button variant="ghost" size="compact" className="min-h-10 gap-2 tabular-nums" onClick={onInspect} aria-label={`Environment · ${environment.count} machines · ${environment.label}`}><StatusDot color={environment.color} />Environment · {environment.count} {environment.count === 1 ? 'machine' : 'machines'}</Button>}
      artifactUpload={artifactUploadRpcClient({ spaceId, expectedGeneration: scope.workspace.generation }, () => scope.workspace.generation)}
      sessionCommand={sessionCommand}
      resolveResourceFile={resolveResourceFile}
      terminals={{
        spaceId, machines: terminalMachines, machineId: terminalChoice?.spaceId === spaceId ? terminalChoice.machineId : null,
        onSelectMachine: selectTerminalMachine,
        events: (machineId, name, after, signal) => rpcClient.terminals.events({ spaceId, machineId, name, after }, { signal }),
        live: (machineId, name, after, signal) => rpcClient.terminals.live({ spaceId, machineId, name, after }, { signal }),
        create: async machineId => { const result = await rpcClient.terminals.create({ spaceId, machineId }); if (result.status === 'error') throw result.error; return result.value; },
        send: async (machineId, name, data) => { const result = await rpcClient.terminals.send({ spaceId, machineId, name, data }); if (result.status === 'error') throw result.error; },
        stop: async (machineId, name) => { const result = await rpcClient.terminals.stop({ spaceId, machineId, name }); if (result.status === 'error') throw result.error; },
      }}
      renderInspector={(onClose, initialView, resourceRequest, openTerminal, guideSection, driveFocus) => props.renderInspector({ snapshot, conversationId, sessionId: value?.sessionId ?? conversationId ?? null, controls: value, turns, scope: scope.workspace, workspaces: scope.workspaces, onClose, onAskAgent: ask, onCompose: draft ? text => draft.onChange(/\S$/u.test(draft.text) ? `${draft.text} ${text}` : `${draft.text}${text}`) : undefined, onSetRelations: relationsEditable ? setRelations : undefined, initialView, resourceRequest, guideSection, driveFocus, onOpenTerminal: (machineId, name) => { selectTerminalMachine(machineId); openTerminal(name); } })}
      chatter={<LiveChatter projectId={inspection.project.id} projectName={inspection.project.name} workspaceId={identity.workspaceId} workspaces={scope.workspaces.filter(workspace => workspace.closedAt === null).map(({ id, name }) => ({ id, name }))} onOpenWorkspace={props.onSelectWorkspace} />}
    />
    </SpeechProvider>
    </RequirementAcceptance.Provider>
    </ComposerStagingProvider>
    </CommentLayerProvider>
    </QuestionCardsContext.Provider>
    {launchRequest?.source.kind === 'workspace' ? <LaunchMachineDialog key={launchRequest.source.workspaceId} projectId={props.projectId} workspaceId={launchRequest.source.workspaceId} machines={inspection.machines} onClose={() => setLaunchRequest(null)} onLaunch={async machineId => { await launch.start(launchRequest.source, machineId, launchRequest.targets); setLaunchRequest(null); }} /> : null}
    {launchRequest?.source.kind === 'canonical' ? <CanonicalLaunchDialog canonical={launchRequest.source} machines={inspection.machines} onClose={() => setLaunchRequest(null)} onLaunch={async machineId => { await launch.start(launchRequest.source, machineId, launchRequest.targets); setLaunchRequest(null); }} /> : null}
    {launch.launch ? <LaunchSheet launch={launch.launch} open={launch.open && !launchRequest} onOpenChange={launch.setOpen} onRetry={() => launch.launch!.source.kind === 'release' ? perform(launch.backToDefault) : setLaunchRequest({ source: launch.launch!.source, targets: launch.launch!.targets })} onDiscard={() => launch.discard(launch.launch!.launchId)} /> : null}
  </>;
}
