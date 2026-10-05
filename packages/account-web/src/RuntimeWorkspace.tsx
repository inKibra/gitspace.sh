import { useMemo, useRef, useState, type ReactNode } from 'react';
import type { TranscriptContentRequest, TranscriptPageRequest } from '@gitspace/blocks';
import { useResultQuery } from 'result-rpc/react';
import type { InspectorView } from '@gitspace/protocol';
import { RuntimeIdentitySchema, type RuntimeSnapshot } from '@gitspace/protocol-runtime';
import { Button, Dialog, DialogContent, DialogHeader, DialogTitle, ThinkingIndicator } from '@gitspace/ui';
import { EmptyState, GitSpaceShell, type GitSpaceShellProps, type SessionControlsProps } from './GitSpaceShell.js';
import { useWorkspaceRuntime } from './useWorkspaceRuntime.js';
import { useCloudSessionControls } from './useCloudSessionControls.js';
import { useTranscriptHistory } from './useTranscriptHistory.js';
import { useInference } from './InferenceContext.js';
import { useRetainedQueryValue } from './useRetainedRead.js';
import { rpcClient, createGitSpaceBrowserClient } from './rpc-client.js';
import { rpcErrorMessage } from './rpc-error-message.js';
import { runtimeScope, runtimeTurns } from './runtime-shell-adapter.js';
import { RuntimeMachines } from './RuntimeMachines.js';
import { BrowserApprovalCard } from './RuntimeBrowser.js';
import { RELEASE_TARGETS } from './release.js';
import { LaunchSheet, LaunchedBanner, RevertSheet } from './LaunchSheet.js';
import { useRuntimeLaunch } from './useRuntimeLaunch.js';
import type { ResourceRequest } from './ResourceNavigation.js';

export interface RuntimeInspectorContext {
  snapshot: RuntimeSnapshot;
  conversationId: string | undefined;
  sessionId: string | null;
  turns: GitSpaceShellProps['turns'];
  scope: GitSpaceShellProps['workspace'];
  workspaces: GitSpaceShellProps['workspaces'];
  onClose(): void;
  onAskAgent(text: string): Promise<void>;
  onSetRelations?: GitSpaceShellProps['onSetWorkspaceRelations'];
  initialView?: 'environment';
  resourceRequest?: ResourceRequest;
}
export interface RuntimeWorkspaceProps {
  projectId: string;
  workspaceId: string;
  onOpenSettings: GitSpaceShellProps['onOpenSettings'];
  onSelectWorkspace(id: string): void;
  onSelectProject(id: string): void;
  renderInspector(context: RuntimeInspectorContext): ReactNode;
  creation?: ReactNode;
}

export function RuntimeWorkspace(props: RuntimeWorkspaceProps) {
  const runtime = useWorkspaceRuntime(props.projectId, props.workspaceId);
  const inspection = useResultQuery(rpcClient.inspector.view, { projectId: props.projectId, workspaceId: props.workspaceId === props.projectId ? null : props.workspaceId });
  const saved = useRetainedQueryValue(inspection, JSON.stringify([props.projectId, props.workspaceId]));
  return <>{runtime.error ? <div role="alert" className="flex items-center gap-2 px-4 py-2 text-caption text-destructive">{runtime.error}<Button variant="ghost" onClick={runtime.retry}>Reconnect</Button></div> : null}{inspection.state === 'failure' ? <div role="alert" className="flex items-center gap-2 px-4 py-2 text-caption text-destructive">{rpcErrorMessage(inspection.error, 'Read workspace')}<Button variant="ghost" onClick={() => void inspection.refetch()}>Retry workspace</Button></div> : null}{runtime.snapshot && saved ? <RuntimeWorkspaceShell {...props} snapshot={runtime.snapshot} inspection={saved} connected={runtime.connected} refreshInspection={async () => { await inspection.refetch(); }} /> : <EmptyState icon={<ThinkingIndicator />} title="Loading workspace…" description="Reading the cloud conversation and workspace state." />}</>;
}

/** The production shell, fed by accepted runtime snapshots and the existing typed RPC client. */
export function RuntimeWorkspaceShell({ snapshot, inspection, connected, refreshInspection, ...props }: RuntimeWorkspaceProps & { snapshot: RuntimeSnapshot; inspection: InspectorView; connected: boolean; refreshInspection(): Promise<void> }) {
  const [selected, setSelected] = useState<string>();
  const conversation = snapshot.conversations.find(item => item.id === selected) ?? snapshot.conversations.find(item => item.parentId === null);
  const conversationId = conversation?.id;
  const session = useCloudSessionControls(snapshot, conversationId);
  const value = session.result?.control;
  const run = session.run;
  const inference = useInference();
  const profileId = inference?.state?.assignments.find(item => item.projectId === snapshot.projectId)?.profileId ?? '';
  const providers = useResultQuery(rpcClient.providers.list, { profileId }, { enabled: !!profileId });
  const providerValues = useRetainedQueryValue(providers, profileId);
  const skills = useResultQuery(rpcClient.skills.list, {});
  const skillValues = useRetainedQueryValue(skills, 'skills');
  const deployment = useResultQuery(rpcClient.deployment.status, {}, { enabled: inspection.project.role === 'gitspace-source' });
  const deploymentValue = useRetainedQueryValue(deployment, inspection.project.id);
  const launch = useRuntimeLaunch(deploymentValue, deployment.refetch);
  const relationQuery = useResultQuery(rpcClient.space.view, { projectId: props.projectId, workspaceId: inspection.workspace.kind === 'base' ? null : props.workspaceId });
  const relationValue = useRetainedQueryValue(relationQuery, JSON.stringify([props.projectId, props.workspaceId]));
  const [actionError, setActionError] = useState<string | null>(null);
  const [machinesOpen, setMachinesOpen] = useState(false);
  const [terminalMachineId, setTerminalMachineId] = useState<string>();
  const scope = useMemo(() => runtimeScope(snapshot, inspection, relationValue?.workspaces), [snapshot, inspection, relationValue]);
  const relationsEditable = relationQuery.state === 'success' && relationQuery.fetch !== 'fetching' && scope.relationsReady;
  const relationAuthority = useRef({ value: relationValue, editable: relationsEditable });
  relationAuthority.current = { value: relationValue, editable: relationsEditable };
  const turns = useMemo(() => runtimeTurns(snapshot, conversationId), [snapshot, conversationId]);
  const identity = useMemo(() => RuntimeIdentitySchema.parse(snapshot), [snapshot.projectId, snapshot.workspaceId]);
  const transcriptSource = useMemo(() => conversationId ? {
    key: JSON.stringify([snapshot.projectId, snapshot.workspaceId, conversationId]), revision: snapshot.cursor,
    page: async (request: TranscriptPageRequest, signal: AbortSignal) => {
      const response = await rpcClient.runtime.session({ ...identity, conversationId, command: { type: 'transcriptPage', request } }, { signal });
      if (response.status === 'error') throw response.error;
      if (!response.value.transcriptPage) throw new Error('The runtime did not return a transcript page.');
      return response.value.transcriptPage;
    },
    content: async (request: TranscriptContentRequest, signal: AbortSignal) => {
      const response = await rpcClient.runtime.session({ ...identity, conversationId, command: { type: 'transcriptContent', request } }, { signal });
      if (response.status === 'error') throw response.error;
      if (!response.value.transcriptContent) throw new Error('The runtime did not return transcript content.');
      return response.value.transcriptContent;
    },
  } : null, [identity, conversationId, snapshot.cursor]);
  const transcript = useTranscriptHistory(transcriptSource);
  const question = snapshot.questions.find(item => item.conversationId === conversationId && item.answer === null);
  const controls: SessionControlsProps | undefined = value ? {
    value: value.pendingAsk || !question || question.browser ? value : { ...value, pendingAsk: { id: question.id, source: 'gitspace', links: [], questions: [{ id: question.id, question: question.prompt, header: question.kind === 'approval' ? 'Approval required' : null, multi: false, recommended: null, options: (question.kind === 'approval' ? ['Approve', 'Reject'] : question.choices).map(label => ({ label, description: null, preview: null })) }] } },
    onCycleRole: async direction => { await run({ type: 'cycleRole', direction }); },
    onSetModel: async (provider, model) => { await run({ type: 'setModel', provider, model }); },
    onSetThinking: async thinking => { await run({ type: 'setThinking', thinking }); },
    onSetFast: async enabled => { await run({ type: 'setFast', enabled }); },
    onSetApproval: async approvalMode => { await run({ type: 'setApproval', approvalMode }); },
    onSetGoal: async enabled => { await run({ type: 'setGoal', enabled }); },
    onCompact: async instructions => { await run({ type: 'compact', ...(instructions ? { instructions } : {}) }); },
    onClearQueue: async () => { await run({ type: 'clearQueue' }); },
    onRemoveQueuedMessage: async (kind, index) => { await run({ type: 'removeQueuedMessage', kind, index }); },
    onPromoteQueuedMessage: async index => { await run({ type: 'promoteQueuedMessage', index }); },
    onAnswerAsk: async (id, answers) => {
      if (value.pendingAsk?.id === id || question?.id !== id) { await run({ type: 'answerAsk', id, answers }); return; }
      const answer = answers.find(item => item.id === id);
      if (!answer) throw new Error('An answer is required.');
      const selectedAnswer = answer.selectedOptions[0];
      if (question.kind === 'approval' && selectedAnswer !== 'Approve' && selectedAnswer !== 'Reject') throw new Error('Choose Approve or Reject.');
      const response = await rpcClient.runtime.answer({ ...identity, questionId: id, answer: question.kind === 'approval' ? selectedAnswer === 'Approve' : answer.customInput || [...answer.selectedOptions] });
      if (response.status === 'error') throw response.error;
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
      await Promise.all([relationQuery.refetch(), refreshInspection()]);
    }
  };
  const attached = inspection.machines.filter(machine => snapshot.attachments.some(item => item.machineId === machine.id && item.state === 'ready'));
  const machine = attached.find(item => item.id === terminalMachineId) ?? attached.find(item => item.id === snapshot.attachments.find(item => item.role === 'primary')?.machineId) ?? attached[0];
  const terminalClient = useMemo(() => machine?.rpcEndpoint ? createGitSpaceBrowserClient({ url: machine.rpcEndpoint }) : null, [machine?.rpcEndpoint]);
  const spaceId = snapshot.workspaceId;
  return <>
    {props.creation}
    {actionError ? <p role="alert" className="px-4 py-2 text-caption text-destructive">{actionError}</p> : null}
    {deployment.state === 'failure' ? <div role="alert" className="flex items-center gap-2 px-4 py-2 text-caption text-destructive">{rpcErrorMessage(deployment.error, 'Read deployment status')}<Button variant="ghost" onClick={() => void deployment.refetch()}>Retry deployment status</Button></div> : null}
    {launch.launch && !launch.open ? <Button variant="ghost" size="compact" onClick={() => launch.setOpen(true)}>Show launch progress</Button> : null}
    {relationQuery.state === 'failure' ? <div role="alert" className="flex items-center gap-2 px-4 py-2 text-caption text-destructive">{rpcErrorMessage(relationQuery.error, 'Read workspace relations')}<Button variant="ghost" onClick={() => void relationQuery.refetch()}>Retry relations</Button></div> : null}
    <GitSpaceShell project={{ id: inspection.project.id, name: inspection.project.name, repository: inspection.project.repositoryReference ?? '', connected }} {...scope} mainAgent={{ id: value?.sessionId ?? conversationId ?? 'root', title: conversation?.title ?? 'Workspace agent', state: conversation?.status === 'running' ? 'running' : conversation?.status === 'waiting' ? 'permission-needed' : 'waiting', model: value?.model ?? '', controlsAvailable: true, recovering: !value, failed: conversation?.status === 'failed' }} turns={turns} transcript={conversationId ? transcript : undefined} history={conversationId ? { loading: transcript.initialLoading, error: transcript.error, onRetry: transcript.refresh } : undefined} transport={[]} artifacts={[]} sessionControls={controls} skills={skillValues} providers={providerValues?.providers} sendPending={session.pending} onSend={value ? async (text, streamingBehavior, images) => { await run({ type: 'prompt', text, streamingBehavior, images: images?.map(image => ({ type: 'image', ...image })) }); } : undefined}
      onRetryAgent={async () => { await run({ type: 'resume' }); }} onOpenSettings={props.onOpenSettings} onSelectProject={props.onSelectProject} onSelectWorkspace={props.onSelectWorkspace}
      controlsError={session.error ?? (providers.state === 'failure' ? rpcErrorMessage(providers.error, 'Load provider authentication') : inference?.error) ?? undefined}
      onRetryControls={() => { void run({ type: 'control' }).catch(() => {}); void providers.refetch(); void inference?.refresh(); }}
      approvalCard={question?.browser ? <BrowserApprovalCard key={`${question.id}:${question.browser.id}`} request={question.browser} requestDetails={question.prompt} connected={connected} machineName={inspection.machines.find(machine => machine.id === question.browser?.machineId)?.label} onAnswer={async approved => {
        const response = await rpcClient.runtime.answer({ ...identity, questionId: question.id, answer: approved, expectedBrowserPreparationId: question.browser!.id });
        if (response.status === 'error') throw response.error;
        await run({ type: 'control' });
      }} /> : undefined}
      runtimeSummary={{ holder: scope.workspace.holder, closedAt: scope.workspace.closedAt, generation: scope.workspace.generation, status: scope.workspace.status, freshness: connected ? 'fresh' : 'stale', detail: connected ? null : 'Reconnecting to cloud runtime' }}
      onSetWorkspacePhase={async (_id, phase) => { await perform(async () => { await run({ type: 'setWorkspacePhase', phase }); await refreshInspection(); }); }}
      onSetWorkspaceRelations={relationsEditable ? setRelations : undefined}
      deployment={deploymentValue ? { status: deploymentValue, launch: launch.launch, isGitSpaceProject: inspection.project.role === 'gitspace-source', onLaunch: workspaceId => perform(() => launch.start(workspaceId, RELEASE_TARGETS)), onRevert: () => perform(launch.revert) } : null}
      launchBanner={launch.mark ? <LaunchedBanner mark={launch.mark} onRevert={() => perform(launch.revert)} onDismiss={launch.dismiss} /> : undefined}
      renderEnvironmentStatus={() => <><Button variant="ghost" size="compact" onClick={() => setMachinesOpen(true)}>Machines · {snapshot.attachments.filter(item => item.state !== 'detached').length}</Button>{snapshot.conversations.length > 1 ? <select aria-label="Conversation" className="min-h-10 max-w-40 bg-transparent text-caption" value={conversationId} onChange={event => setSelected(event.target.value)}>{snapshot.conversations.map(item => <option key={item.id} value={item.id}>{item.title || (item.parentId ? 'Subagent' : 'Main agent')}</option>)}</select> : null}{attached.length > 1 ? <select aria-label="Terminal machine" className="min-h-10 max-w-40 bg-transparent text-caption" value={machine?.id} onChange={event => setTerminalMachineId(event.target.value)}>{attached.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select> : null}</>}
      terminals={terminalClient ? { spaceId, events: (name, after, signal) => terminalClient.terminals.events({ spaceId, name, after }, { signal }), live: (name, signal) => terminalClient.terminals.live({ spaceId, name }, { signal }), create: async () => { const result = await terminalClient.terminals.create({ spaceId }); if (result.status === 'error') throw result.error; return result.value; }, send: async (name, data) => { const result = await terminalClient.terminals.send({ spaceId, name, data }); if (result.status === 'error') throw result.error; }, stop: async name => { const result = await terminalClient.terminals.stop({ spaceId, name }); if (result.status === 'error') throw result.error; } } : undefined}
      renderInspector={(onClose, initialView, resourceRequest) => props.renderInspector({ snapshot, conversationId, sessionId: value?.sessionId ?? conversationId ?? null, turns, scope: scope.workspace, workspaces: scope.workspaces, onClose, onAskAgent: ask, onSetRelations: relationsEditable ? setRelations : undefined, initialView, resourceRequest })}
    />
    {launch.launch ? <LaunchSheet launch={launch.launch} open={launch.open} onOpenChange={launch.setOpen} onRetry={() => perform(() => launch.start(launch.launch!.workspaceId, launch.launch!.targets))} /> : null}
    {launch.revertProgress ? <RevertSheet progress={launch.revertProgress} open={launch.open} onOpenChange={launch.setOpen} onRetry={() => perform(launch.revert)} /> : null}
    <Dialog open={machinesOpen} onOpenChange={setMachinesOpen}><DialogContent className="flex max-h-[85dvh] max-w-3xl flex-col overflow-hidden"><DialogHeader><DialogTitle>Workspace machines</DialogTitle></DialogHeader><RuntimeMachines snapshot={snapshot} conversationId={conversationId} onSelectConversation={id => { setSelected(id); setMachinesOpen(false); }} /></DialogContent></Dialog>
  </>;
}
