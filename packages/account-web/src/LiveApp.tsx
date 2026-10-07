import { RuntimeIdentitySchema } from '@gitspace/protocol-runtime';
import type { RuntimeAccountBrowserRelayStatus } from '@gitspace/protocol-runtime';
import { accountBrowserStatus, downloadAccountBrowserExtension, unpairAccountBrowser } from './browser-relay-client.js';
import { runtimeLfsHeldBack, useLfsTransition, type ConfirmLfsTransition } from './LfsTransition.js';
import { executionAgentId, type ExecutionBlock, type SideAgentBlock, type TurnBlock } from '@gitspace/blocks';
import type { InspectorView, RuntimeSettingValue, RepositoryDiffView, RepositoryFileView, RepositoryMode, UserSettings } from '@gitspace/protocol';
import { DEFAULT_INFERENCE_PROFILE_ID, inferenceSettingMetadata } from '@gitspace/protocol/inference';
import { executionHash, projectEnvironmentState, lifecycleExecutionOutcome, isLifecycleRunActive, latestLifecycleRun, latestExecutionRun, type EnvironmentBundle as ProtocolEnvironmentBundle } from '@gitspace/protocol-environment';
import type { ProjectMcpGrantRpcView } from '@gitspace/protocol/mcp-contract';
import type { ProjectCronView } from '@gitspace/protocol/cron-contract';
import type { CloudImageSelection } from '@gitspace/protocol/cloud-image';
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, InputField, InputGroup, ScrollArea, Select, SelectContent, SelectItem, SelectTrigger, SidebarInset, SidebarInsetTopbar, SidebarProvider, ThinkingIndicator, Tooltip } from '@gitspace/ui';
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ComponentProps, type ContextType, type ReactNode } from 'react';
import { isTaggedError } from 'result-rpc';
import { ResultRpcProvider, useResultMutation, useResultQuery, useResultRuntime } from 'result-rpc/react';
import { CreateWorkspaceDialog, EmptyState, PageCanvas, PageHeader, type GitSpaceShellProps } from './GitSpaceShell.js';
import { AccountWorkPages } from './AccountWorkPages.js';
import { createGitSpaceBrowserClient, rpcClient } from './rpc-client.js';
import { currentDevice, DEVICE_REJECTED_EVENT, deviceRejected, setCurrentDevice } from './device-session.js';
import { createApiClient, enrollDevice, type ApiClientDraft, type BrowserDevice } from './device.js';
import { requestMcpAccess } from './mcp-access.js';
import { applyAppearance } from './appearance.js';
import type { ProviderLoginFlow, ProvidersSectionProps } from './ProvidersSection.js';
import { forgetProviderLogin, readProviderLogin, saveProviderLogin, type RecoverableProviderLogin } from './provider-login-recovery.js';
import { SettingsPage } from './SettingsPage.js';
import { InferenceProvider, useInference } from './InferenceContext.js';
import { InferencePage } from './InferencePage.js';
import { EnvironmentView } from './environment/EnvironmentView.js';
import { LifecycleLogDialog } from './environment/LifecycleLogDialog.js';
import type { EnvironmentViewModel, LifecyclePhase, LifecycleRun, TrustState } from './environment/types.js';
import { Inspector } from './inspector/index.js';
import { ACCOUNT_DIRECTORY_CHANGED, PRODUCT_ROUTE_LABELS, isGlobalView, navigateProductUrl, productRouteFromLocation, setProductRoute, type AppView, type ProductRoute } from './routes.js';
import { AccountSidebarContext, AppSidebar, type AppSidebarProps, type SidebarProject } from './AppSidebar.js';
import { accountHandleFromUrl, browserInvitationStatus, canConnectBrowser, cancelBrowserInvitation, createBrowserInvitation, enrollmentTokenForLocation, recoverAccountBrowser } from './browser-enrollment.js';
import { AccountConnectPage } from './AccountConnectPage.js';
import { ServiceAccessApproval } from './ServiceAccessApproval.js';
import { SkillsPage } from './SkillsPage.js';
import { PluginsPage } from './PluginsPage.js';
import { ProjectSecretsPage, type ProjectSecretsProps } from './ProjectSecretsPage.js';
import { ProjectCronsPage, type ProjectCronTargetOption } from './ProjectCronsPage.js';
import { AccountDirectoryContext, useWorkspaceProjection } from './useAccountDirectory.js';
import { invalidatesRead, useRetainedRead, useRetainedQueryValue } from './useRetainedRead.js';
import { rpcErrorMessage } from './rpc-error-message.js';
import { useRepositoryTree } from './useRepositoryTree.js';
import type { ResourceRequest } from './ResourceNavigation.js';
import { loadInspectorContent, loadInspectorResource } from './resource-content.js';
import { SynchronizationProvider, useAccountSettings, useAccountGitIdentity, useAccountRuntimeConfiguration, useAccountMachines, useAccountCloudImages, useAccountProjects, useEnvironmentSynchronization, useEventRefresh, useProjectSynchronization, useSpaceSynchronization } from './SynchronizationProvider.js';
import { RuntimeWorkspace, type RuntimeInspectorContext } from './RuntimeWorkspace.js';
import { useRuntimeInspectorState } from './useRuntimeInspectorState.js';
import { CloudCreationProgress } from './CloudCreationProgress.js';


function isRetryableConnectionError(error: Error): boolean {
  const message = `${error.name} ${error.message}`.toLowerCase();
  if ([
    'unauthorized',
    'forbidden',
    'device rejected',
    'device revoked',
    'unsupported protocol',
    'schema mismatch',
  ].some((marker) => message.includes(marker))) return false;
  return [
    'client/protocol-violation',
    'connection',
    'network',
    'failed to fetch',
    'fetch failed',
    'timeout',
    'timed out',
    'reset',
    'socket',
    'service unavailable',
    'bad gateway',
    'gateway timeout',
  ].some((marker) => message.includes(marker));
}

function spaceOpeningError(cause: unknown): string {
  const error = cause instanceof Error ? cause : new Error(String(cause));
  const tag = isTaggedError(error) ? error._tag : '';
  if (tag === 'client/timeout' || tag === 'client/protocol-violation' || tag === 'client/network-failure' || tag === 'client/offline' || isRetryableConnectionError(error) || /tunnel_|machine_offline/iu.test(`${error.name} ${error.message}`)) {
    return `The selected machine did not return a usable response. The workspace may still be opening, so its remote outcome is unknown. Check cloud state before another attempt. Details: ${rpcErrorMessage(error, 'Open workspace')}`;
  }
  return rpcErrorMessage(cause, 'Open workspace');
}


function optionalQueryParameter(name: string): string | null {
  if (typeof window === 'undefined') return null;
  return new URL(window.location.href).searchParams.get(name);
}

const CONFIGURE_ENVIRONMENT_PROMPT = 'Use the workspace-lifecycle skill to help me configure this repository. Inspect the repository and our shared environment ledger, then discuss the local preparation and cloud resources this project needs. Propose the five lifecycle phases and profiles. Do not edit files or run lifecycle scripts until I review the plan; approval to edit is not approval to execute.';


function LiveEnvironment({ projectId, projectName, workspaceName, spaceId, workspace, generation, machineId, runtimeAvailable, onAskAgent }: { projectId: string; projectName: string; workspaceName: string; spaceId: string; workspace: boolean; generation: number; machineId?: string; runtimeAvailable: boolean; onAskAgent?: (text: string) => Promise<void> }) {
  const query = useResultQuery(rpcClient.environment.get, { spaceId });
  const machines = useAccountMachines();
  const retained = useRetainedRead(query, JSON.stringify([spaceId, generation, machineId]));
  const synchronized = useEnvironmentSynchronization(spaceId);
  const read = { ...retained, value: retained.value && synchronized.value ? { ...retained.value, ...projectEnvironmentState(synchronized.value) } : retained.value };
  const machineValues = useRetainedQueryValue(machines, 'machines');
  const [runnerId, setRunnerId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [readingEvidence, setReadingEvidence] = useState(false);
  const [evidence, setEvidence] = useState<{ title: string; output: string; approvalHash?: string } | null>(null);
  const [logSelection, setLogSelection] = useState<{ runId: string; script: { id: string; label: string } } | null>(null);
  const lfsTransition = useLfsTransition();
  if (!read.value) return read.error ? <div className="flex flex-col gap-2 p-4"><p role="alert" className="text-caption text-destructive">{rpcErrorMessage(read.error, 'environment.get')}</p><Button variant="ghost" size="compact" onClick={() => void query.refetch()}>Retry environment</Button></div> : <p className="p-4 text-caption text-muted-foreground" role="status">Loading environment…</p>;
  const runners = (machineValues ?? []).filter((candidate) => candidate.state === 'online' && candidate.desiredState === 'online' && candidate.rpcEndpoint);
  const runner = runners.find((candidate) => candidate.id === runnerId) ?? runners[0];
  const remote = read.value;
  const bundle = JSON.parse(remote.bundleJson) as ProtocolEnvironmentBundle;
  const mutate = (operation: () => Promise<unknown>): void => {
    if (busy) return;
    setActionError(null); setBusy(true);
    void operation().then(() => query.refetch()).catch((error: unknown) => setActionError(rpcErrorMessage(error, 'Update environment'))).finally(() => setBusy(false));
  };
  const saveBundle = (next: ProtocolEnvironmentBundle): void => mutate(async () => {
    const result = await rpcClient.environment.putBundle({ spaceId, bundleJson: JSON.stringify(next) });
    if (result.status === 'error') throw result.error;
  });
  const loadEvidence = (operation: () => Promise<void>): void => {
    if (readingEvidence) return;
    setReadingEvidence(true); setActionError(null);
    void operation().catch((error: unknown) => setActionError(rpcErrorMessage(error, 'Read environment evidence'))).finally(() => setReadingEvidence(false));
  };
  const openExecution = (targetId: string, approve: boolean): void => loadEvidence(async () => {
    const origin = remote.lifecycle.browserOrigins.find((entry) => entry.hash === targetId);
    if (origin) {
      setEvidence({ title: `Browser origin: ${origin.pattern}`, output: `Allow logged-in Chrome access to ${origin.pattern}.\nOnly tabs in this workspace's browser group are accessible.`, ...(approve ? { approvalHash: origin.hash } : {}) });
      return;
    }
    const execution = remote.executions.find((item) => item.id === targetId);
    if (!execution) throw new Error('Execution is no longer present. Refresh the environment.');
    const content = execution.content;
    if (await executionHash({ kind: execution.kind, command: content }) !== execution.hash) throw new Error('Script content changed. Refresh and review the new content before approval.');
    setEvidence({ title: execution.label, output: content, ...(approve ? { approvalHash: execution.hash } : {}) });
  });
  const openRunLog = (runId: string, script: { id: string; label: string }): void => setLogSelection({ runId, script });
  const openSecrets = (): void => {
    navigateProductUrl(setProductRoute(new URL(window.location.href), 'secrets'));
  };
  const lastRun = (executionHash: string, executionId: string): LifecycleRun => {
    const run = latestExecutionRun(remote.lifecycle, executionHash, { profile: remote.selectedProfile, machineId });
    if (!run) return { status: 'never' };
    const step = run.results.find((result) => result.id === executionId);
    const status = lifecycleExecutionOutcome(run, executionId);
    const relativeTime = new Date(step?.finishedAt ?? step?.startedAt ?? run.startedAt).toLocaleString();
    if (status === 'not-started' || status === 'running' || status === 'interrupted') return { status, relativeTime, ...(step?.output ? { output: step.output } : {}) };
    const duration = step?.startedAt && step.finishedAt ? `${Math.max(0, Date.parse(step.finishedAt) - Date.parse(step.startedAt))}ms` : undefined;
    return { status, relativeTime, ...(duration ? { duration } : {}), output: step?.output ?? '', ...(step?.exitCode != null ? { exitCode: step.exitCode } : {}) };
  };
  const checksRun = latestLifecycleRun(remote.lifecycle, 'checks', { machineId, profile: remote.selectedProfile });
  const latestChecks = checksRun && !isLifecycleRunActive(checksRun) ? checksRun : undefined;
  const selectedLogRun = logSelection && remote.lifecycle.runs.find((run) => run.id === logSelection.runId);
  const trustFor = (execution: typeof remote.executions[number] | undefined): TrustState => {
    const approval = execution && remote.lifecycle.approvals.find((item) => item.executionHash === execution.hash && item.scope === execution.approval);
    return approval
      ? { status: 'approved', commandHash: approval.executionHash, approvedBy: approval.approvedBy, approvedAt: new Date(approval.approvedAt).toLocaleString() }
      : { status: 'pending', commandHash: execution?.hash ?? '' };
  };
  const model: EnvironmentViewModel = {
    project: { name: projectName, repository: projectName },
    workspace: { name: workspaceName, profile: remote.selectedProfile, machineId: machineId ?? 'unavailable', generation },
    bundle: {
      default: bundle.defaultProfile,
      checks: Object.fromEntries(Object.entries(bundle.checks).map(([id, definition]) => [id, definition.kind === 'built-in'
        ? { id, label: definition.label ?? definition.check, source: 'catalog' as const, requirement: definition.requirement, probe: remote.executions.find((item) => item.kind === 'check' && item.id === id)?.command, trust: trustFor(remote.executions.find((item) => item.kind === 'check' && item.id === id)) }
        : { id, label: definition.label, source: 'custom' as const, probe: definition.command, trust: trustFor(remote.executions.find((item) => item.kind === 'check' && item.id === id)) }])),
      profiles: Object.fromEntries(Object.entries(bundle.profiles).map(([name, profile]) => [name, { checks: profile.checks, secrets: profile.secrets, inputs: profile.values, notes: profile.notes ?? '' }])),
      inputs: bundle.values,
    },
    machines: [{
      id: machineId ?? 'unavailable',
      label: runtimeAvailable ? machineId ?? 'current machine' : 'no active machine',
      platform: navigator.platform.toLowerCase().includes('mac') ? 'darwin' : navigator.platform.toLowerCase().includes('win') ? 'win32' : 'linux',
      current: true,
      capabilities: Object.fromEntries(remote.executions.filter((item) => item.kind === 'check').map((item) => {
        const result = latestChecks?.results.find((candidate) => candidate.id === item.id);
        return [item.id, result?.exitCode != null ? { status: result.exitCode === 0 ? 'pass' as const : 'fail' as const, output: result.output || `Exited ${result.exitCode}` } : { status: 'unprobed' as const }];
      })),
    }],
    lifecycle: remote.executions.filter((item) => item.kind === 'script').map((item) => ({
      id: item.id,
      phase: item.phase!,
      path: `${item.phase}/${item.fileName}`,
      command: item.command,
      interactive: item.interactive,
      ...(item.fileName?.match(/\.([a-z][a-z0-9-]*)\.sh$/u)?.[1] ? { profiles: [item.fileName.match(/\.([a-z][a-z0-9-]*)\.sh$/u)![1]!] } : {}),
      trust: trustFor(item),
      lastRun: lastRun(item.hash, item.id),
    })),
    executions: remote.executions,
    ledger: remote.lifecycle,
    configured: remote.lifecycle.bundleJson !== null || remote.executions.length > 0,
    secrets: remote.effective.secrets.map((name) => ({ name, source: remote.secretMetadata.find((secret) => secret.name === name)?.source === 'account' ? 'user' : 'project', granted: remote.configuredSecrets.includes(name), requiredBy: [remote.selectedProfile] })),
    inputValues: Object.entries(remote.values.effective).map(([name, value]) => ({ name, value, source: name in remote.values.workspace ? 'workspace' : name in remote.values.project ? 'project' : name in remote.values.global ? 'account' : 'bundle' })),
  };
  const updateProfile = (transform: (profile: ProtocolEnvironmentBundle['profiles'][string]) => ProtocolEnvironmentBundle['profiles'][string]): ProtocolEnvironmentBundle => ({
    ...bundle,
    profiles: { ...bundle.profiles, [remote.selectedProfile]: transform(bundle.profiles[remote.selectedProfile]!) },
  });
  return <div className="flex min-h-0 flex-1 flex-col">
    {read.refreshing ? <p role="status" className="sr-only">Refreshing environment…</p> : null}
    {read.error ? <p role="alert" className="px-4 py-2 text-caption text-destructive">Environment refresh failed; showing the last accepted state. {rpcErrorMessage(read.error, 'environment.get')}<Button variant="ghost" size="compact" onClick={() => void query.refetch()}>Retry environment</Button></p> : null}
    {machines.state === 'failure' ? <p role="alert" className="px-4 py-2 text-caption text-destructive">{rpcErrorMessage(machines.error, 'Load machine directory')}</p> : null}
    {actionError ? <p role="alert" tabIndex={0} className="max-h-24 shrink-0 overflow-auto whitespace-pre-wrap break-words px-4 py-2 text-caption text-destructive">{actionError}</p> : null}
    {!runtimeAvailable && !remote.lifecycle.destroyedAt ? <section className="flex flex-col gap-2 px-4 pt-4" aria-label="Cloud lifecycle runner">
      <p className="text-caption text-muted-foreground">Retire cloud resources on an online machine without opening the workspace agent. Choosing a runner does not execute scripts.</p>
      {runners.length ? <Select value={runner?.id ?? ''} onValueChange={setRunnerId} disabled={busy}><SelectTrigger aria-label="Cloud lifecycle runner" /><SelectContent>{runners.map((candidate, index) => <SelectItem value={candidate.id} index={index} key={candidate.id}>{candidate.label}</SelectItem>)}</SelectContent></Select> : <p className="text-caption text-muted-foreground">No online runner. Records remain available.</p>}
    </section> : null}
    <EnvironmentView
      model={model}
      busy={busy}
      runtimeAvailable={runtimeAvailable}
      cloudRunnerAvailable={runtimeAvailable || !!runner}
      onConfigure={onAskAgent ? () => mutate(() => onAskAgent(CONFIGURE_ENVIRONMENT_PROMPT)) : undefined}
      onRecoverRun={(runId) => mutate(async () => { const result = await rpcClient.environment.recoverRun({ spaceId, runId }); if (result.status === 'error') throw result.error; })}
      onCancelRun={(runId) => mutate(async () => { const result = await rpcClient.environment.cancelRun({ spaceId, runId }); if (result.status === 'error') throw result.error; })}
      onOpenRunLog={openRunLog}
      onProfileChange={(profile) => mutate(async () => { const result = await rpcClient.environment.setProfile({ spaceId, profile }); if (result.status === 'error') throw result.error; })}
      onApprove={(targetId) => openExecution(targetId, true)}
      onRevoke={(targetId) => {
        const origin = remote.lifecycle.browserOrigins.find((entry) => entry.hash === targetId);
        const execution = remote.executions.find((item) => item.id === targetId);
        const hash = origin?.hash ?? execution?.hash;
        const approval = remote.lifecycle.approvals.find((entry) => entry.executionHash === hash && entry.scope === 'project')
          ?? remote.lifecycle.approvals.find((entry) => entry.executionHash === hash && entry.scope === 'workspace');
        if (approval) mutate(async () => { const result = await rpcClient.environment.revokeApproval({ spaceId, scope: approval.scope, executionHash: approval.executionHash }); if (result.status === 'error') throw result.error; });
      }}
      onGrantSecret={openSecrets}
      onInputChange={(name, value) => mutate(async () => { const result = await rpcClient.environment.putValue({ spaceId, scope: workspace ? 'workspace' : 'project', name, value }); if (result.status === 'error') throw result.error; })}
      onFixCheck={onAskAgent ? (checkId) => mutate(() => onAskAgent(`Inspect the failing environment check ${checkId} using the environment tool with method get and its durable run logs. Explain the cause and propose a fix; do not grant yourself execution approval.`)) : undefined}
      onUpdateCheck={(checkId, patch) => saveBundle({ ...bundle, checks: { ...bundle.checks, [checkId]: bundle.checks[checkId]?.kind === 'command' ? { kind: 'command', label: patch.label ?? bundle.checks[checkId].label, command: patch.probe ?? bundle.checks[checkId].command } : { ...bundle.checks[checkId]!, label: patch.label, requirement: patch.requirement } } })}
      onDeleteCheck={(checkId) => saveBundle({ ...bundle, checks: Object.fromEntries(Object.entries(bundle.checks).filter(([id]) => id !== checkId)), profiles: Object.fromEntries(Object.entries(bundle.profiles).map(([name, profile]) => [name, { ...profile, checks: profile.checks.filter((id) => id !== checkId) }])) })}
      onAddCheck={(check) => saveBundle({ ...updateProfile((profile) => ({ ...profile, checks: [...new Set([...profile.checks, check.id])] })), checks: { ...bundle.checks, [check.id]: check.source === 'catalog' ? { kind: 'built-in', check: check.id, label: check.label, requirement: check.requirement } : { kind: 'command', command: check.probe ?? '', label: check.label } } })}
      onAddValue={(name, defaultValue) => saveBundle({ ...updateProfile((profile) => ({ ...profile, values: [...new Set([...profile.values, name])] })), values: { ...bundle.values, [name]: defaultValue ? { default: defaultValue } : {} } })}
      onOpenSecrets={openSecrets}
      onOpenLifecycleFile={(scriptId) => openExecution(scriptId, false)}
      onRunChecks={() => mutate(async () => { const result = await rpcClient.environment.runChecks({ spaceId, runId: crypto.randomUUID() }); if (result.status === 'error') throw result.error; })}
      onOpenLifecycleOutput={(scriptId) => { const execution = remote.executions.find((item) => item.id === scriptId); const run = execution && latestExecutionRun(remote.lifecycle, execution.hash, { profile: remote.selectedProfile, machineId }); if (run && execution) openRunLog(run.id, { id: execution.id, label: execution.label }); }}
      onRunLifecycle={(phase: LifecyclePhase, options) => mutate(async () => {
        if (phase === 'workspace/dematerialize') {
          const snapshot = await configurationResult(rpcClient.runtime.snapshot(RuntimeIdentitySchema.parse({ projectId, workspaceId: spaceId })));
          if (!await lfsTransition.confirm(runtimeLfsHeldBack(snapshot), () => onAskAgent ? onAskAgent('Help me review and commit the uncommitted Git LFS changes before removing this checkout.') : selectInspection(projectId, workspace ? spaceId : null))) return;
        }
        if (phase === 'cloud/destroy' && !options?.retire) throw new Error('Explicit human retirement confirmation is required.');
        const client = runtimeAvailable ? rpcClient : runner?.rpcEndpoint ? createGitSpaceBrowserClient({ url: runner.rpcEndpoint }) : null;
        if (!client) throw new Error('Choose an online cloud lifecycle runner.');
        if (!runtimeAvailable && phase !== 'cloud/destroy') throw new Error('Open the workspace before requesting setup or local preparation.');
        const result = await client.environment.runPhase({ spaceId, runId: crypto.randomUUID(), phase, rerun: options?.rerun ?? null, interactive: options?.interactive });
        if (result.status === 'error') throw result.error;
      })}
    />
    {lfsTransition.dialog}
    {selectedLogRun && logSelection ? <LifecycleLogDialog key={`${spaceId}:${selectedLogRun.id}:${logSelection.script.id}`} run={selectedLogRun} script={logSelection.script} revision={remote.lifecycle.revision} loadPage={async (runId, offset, signal) => { const result = await rpcClient.environment.runLog({ spaceId, runId, offset }, { signal }); if (result.status === 'error') throw result.error; return result.value; }} onClose={() => setLogSelection(null)} /> : null}
    <Dialog open={evidence !== null} onOpenChange={(open) => { if (!open) setEvidence(null); }}>
      <DialogContent size="sm"><DialogHeader><DialogTitle>{evidence?.approvalHash ? 'Review environment permission' : evidence?.title}</DialogTitle><DialogDescription>{evidence?.approvalHash ? 'Approves only this exact item. Changed content requires a new approval. This does not execute commands or authorize retirement.' : 'Saved lifecycle evidence. Logs remain available after a checkout is removed.'}</DialogDescription></DialogHeader>
        {evidence?.approvalHash ? <code className="break-all font-mono text-caption text-muted-foreground">{evidence.approvalHash}</code> : null}
        <pre className="max-h-[55vh] overflow-auto whitespace-pre-wrap break-words font-mono text-caption">{evidence?.output || 'No output recorded.'}</pre>
        {actionError ? <p role="alert" className="text-caption text-destructive">{actionError}</p> : null}
        <DialogFooter><Button variant="secondary" onClick={() => setEvidence(null)}>Close</Button>{evidence?.approvalHash ? <Button variant="primary" disabled={busy} onClick={() => mutate(async () => { const result = await rpcClient.environment.approve({ spaceId, scope: workspace ? 'workspace' : 'project', executionHash: evidence.approvalHash! }); if (result.status === 'error') throw result.error; setEvidence(null); })}>Approve this content</Button> : null}</DialogFooter>
      </DialogContent>
    </Dialog>
  </div>;
}

export function LiveInspector({
  projectId,
  spaceId,
  generation,
  reviewerId,
  sessionId,
  turns,
  scope,
  workspaces,
  onSelectWorkspace,
  onSetRelations,
  refreshToken,
  onClose,
  onGenerateChangeGuide,
  runtimeAvailable,
  controlsAvailable,
  onAskAgent,
  initialView,
  resourceRequest,
  runtimeContext,
}: {
  projectId: string;
  spaceId: string;
  generation: number;
  reviewerId: string;
  sessionId: string | null;
  turns: TurnBlock[];
  scope?: GitSpaceShellProps['workspace'];
  workspaces: GitSpaceShellProps['workspaces'];
  onSelectWorkspace: NonNullable<GitSpaceShellProps['onSelectWorkspace']>;
  onSetRelations?: GitSpaceShellProps['onSetWorkspaceRelations'];
  refreshToken: number;
  onClose: () => void;
  onGenerateChangeGuide?: () => Promise<void>;
  runtimeAvailable: boolean;
  controlsAvailable: boolean;
  onAskAgent?: (text: string) => Promise<void>;
  initialView?: 'environment';
  resourceRequest?: ResourceRequest;
  runtimeContext?: RuntimeInspectorContext;
}) {
  const request = { spaceId, expectedGeneration: generation };
  const queryRuntime = useResultRuntime();
  const runtimeInspector = useRuntimeInspectorState(runtimeContext);
  const overview = useResultQuery(rpcClient.inspector.overview, request);
  const artifactCatalog = useResultQuery(rpcClient.inspector.artifacts.list, request);
  const [secondaryQueries, setSecondaryQueries] = useState({ repository: false, journal: false, threads: false, services: false });
  const [repositoryMode, setRepositoryMode] = useState<RepositoryMode>('current');
  const readKey = JSON.stringify([projectId, spaceId, generation, scope?.possessedBy]);
  const repository = useRepositoryTree(spaceId, generation, repositoryMode, readKey, runtimeAvailable && secondaryQueries.repository);
  const journal = useResultQuery(rpcClient.inspector.journal.list, request, { enabled: secondaryQueries.journal });
  const threads = useResultQuery(rpcClient.inspector.review.list, request, { enabled: secondaryQueries.threads });
  const services = useResultQuery(rpcClient.inspector.services.list, request, { enabled: runtimeAvailable && secondaryQueries.services });
  const [usageRequested, setUsageRequested] = useState(false);
  // Reads are driven below rather than by query auto-refetch: a large session
  // tree must finish before a later invalidation starts another traversal.
  const usage = useResultQuery(rpcClient.session.usage, { sessionId: sessionId ?? '' }, { enabled: false });
  const [usageRevision, setUsageRevision] = useState(0);
  const [usageSettled, setUsageSettled] = useState(0);
  const usageInFlight = useRef(false);
  const usageLastRead = useRef<{ sessionId: string; revision: number } | null>(null);
  const [agentsRequested, setAgentsRequested] = useState(false);
  const agents = useResultQuery(rpcClient.session.agents, { sessionId: sessionId ?? '' }, { enabled: !runtimeContext && runtimeAvailable && controlsAvailable && agentsRequested && sessionId !== null });
  const stackedOn = scope?.kind === 'workspace' ? scope.relations.stackedOn : null;
  const stackStatus = useResultQuery(rpcClient.workspace.stackStatus, { workspaceId: spaceId }, { enabled: runtimeAvailable && stackedOn !== null && scope?.kind === 'workspace' && !scope.closedAt });
  const overviewRead = useRetainedRead(overview, readKey);
  const artifactValue = useRetainedQueryValue(artifactCatalog, readKey);
  const repositoryValue = useRetainedQueryValue(repository, JSON.stringify([readKey, repositoryMode]));
  const journalValue = useRetainedQueryValue(journal, readKey);
  const threadsValue = useRetainedQueryValue(threads, readKey);
  const servicesValue = useRetainedQueryValue(services, readKey);
  const sessionReadKey = runtimeAvailable && controlsAvailable && sessionId !== null ? JSON.stringify([readKey, sessionId]) : null;
  const usageRead = useRetainedRead(usage, sessionReadKey);
  const agentsRead = useRetainedRead(agents, sessionReadKey);
  const stackValue = useRetainedQueryValue(stackStatus, JSON.stringify([readKey, stackedOn]));
  const [repositoryFile, setRepositoryFile] = useState<RepositoryFileView | null>(null);
  const [repositoryDiff, setRepositoryDiff] = useState<RepositoryDiffView | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const lastRefreshToken = useRef(refreshToken);
  const repositoryRequest = useRef<AbortController | null>(null);
  const repositoryScope = useRef(readKey);
  repositoryScope.current = readKey;
  useEffect(() => {
    repositoryRequest.current?.abort();
    setRepositoryFile(null);
    setRepositoryDiff(null);
    return () => { repositoryRequest.current?.abort(); };
  }, [readKey, runtimeAvailable]);
  const subagents = useMemo(() => {
    const byAgent = new Map<string, ExecutionBlock | SideAgentBlock>();
    for (const turn of turns) for (const agent of turn.sideAgents) byAgent.set(agent.agentId, agent);
    for (const turn of turns) {
      for (const item of turn.items) if (item.type === 'execution' && item.kind === 'agent') byAgent.set(executionAgentId(item) ?? item.executionId, item);
    }
    return [...byAgent.values()];
  }, [turns]);

  useEffect(() => {
    if (overview.state !== 'success') return;
    const timers = [
      setTimeout(() => setSecondaryQueries((current) => ({ ...current, repository: true })), 0),
      setTimeout(() => setSecondaryQueries((current) => ({ ...current, journal: true })), 75),
      setTimeout(() => setSecondaryQueries((current) => ({ ...current, threads: true })), 150),
      setTimeout(() => setSecondaryQueries((current) => ({ ...current, services: true })), 225),
    ];
    return () => { for (const timer of timers) clearTimeout(timer); };
  }, [overview.state]);

  useEffect(() => {
    if (runtimeContext || !runtimeAvailable || !controlsAvailable || !usageRequested || sessionId === null || usageInFlight.current) return;
    if (usageLastRead.current?.sessionId === sessionId && usageLastRead.current.revision === usageRevision) return;
    usageInFlight.current = true;
    usageLastRead.current = { sessionId, revision: usageRevision };
    void usage.refetch().finally(() => {
      usageInFlight.current = false;
      setUsageSettled((current) => current + 1);
    });
  }, [runtimeAvailable, controlsAvailable, usageRequested, sessionId, usageRevision, usageSettled, usage.refetch]);

  useEffect(() => {
    if (!runtimeAvailable || !controlsAvailable || !usageRequested || sessionId === null) return;
    const timer = setTimeout(() => setUsageRevision((current) => current + 1), 1_500);
    return () => clearTimeout(timer);
  }, [turns, refreshToken, runtimeAvailable, controlsAvailable, usageRequested, sessionId]);

  useEventRefresh(refreshToken, () => setUsageRevision((current) => current + 1), runtimeAvailable && controlsAvailable && usageRequested && sessionId !== null);

  useEffect(() => {
    if (refreshToken === 0 || refreshToken === lastRefreshToken.current) return;
    lastRefreshToken.current = refreshToken;
    void Promise.all([
      overview.refetch(), journal.refetch(), threads.refetch(), artifactCatalog.refetch(),
      ...(runtimeAvailable ? [repository.refetch(), services.refetch(), ...(stackedOn !== null ? [stackStatus.refetch()] : [])] : []),
    ]);
  }, [refreshToken, runtimeAvailable, readKey]);

  const projectSynchronization = useProjectSynchronization(projectId);
  useEventRefresh(projectSynchronization.cursor, () => artifactCatalog.refetch(), !runtimeAvailable);

  if (!overviewRead.value) {
    return overviewRead.error
      ? <div className="flex h-full flex-col items-center justify-center gap-2 p-6" aria-label="Workspace Inspector"><EmptyState title="Inspector could not load" description={rpcErrorMessage(overviewRead.error, 'inspector.overview')} action={<Button variant="ghost" type="button" onClick={() => void overview.refetch()}>Retry Inspector</Button>} /></div>
      : <div className="flex h-full flex-col items-center justify-center gap-2 p-6" aria-label="Workspace Inspector"><ThinkingIndicator /><span className="text-body text-muted-foreground">Loading Inspector authority state…</span></div>;
  }
  const overviewValue = overviewRead.value;

  const beginRepositoryRead = () => {
    repositoryRequest.current?.abort();
    const controller = new AbortController();
    repositoryRequest.current = controller;
    setActionError(null);
    setRepositoryFile(null);
    setRepositoryDiff(null);
    return { signal: controller.signal, current: () => !controller.signal.aborted && repositoryScope.current === readKey };
  };
  const requestRepositoryFile = (path: string, mode: RepositoryMode): void => {
    const pending = beginRepositoryRead();
    void rpcClient.inspector.repository.file({ ...request, path, mode }, { signal: pending.signal }).then((result) => {
      if (!pending.current()) return;
      if (result.status === 'error') throw result.error;
      if (result.value.spaceId !== spaceId || result.value.generation !== generation || result.value.path !== path || result.value.mode !== mode) throw new Error('Repository file response does not match the requested view.');
      setRepositoryFile(result.value);
    }).catch((error: unknown) => { if (pending.current()) setActionError(rpcErrorMessage(error, 'inspector.repository.file')); });
  };
  const requestRepositoryDiff = (path: string | null, mode: Exclude<RepositoryMode, 'current'>, baseRef?: string): void => {
    const pending = beginRepositoryRead();
    void rpcClient.inspector.repository.diff({ ...request, path, mode, baseRef: baseRef ?? null }, { signal: pending.signal }).then((result) => {
      if (!pending.current()) return;
      if (result.status === 'error') throw result.error;
      if (result.value.spaceId !== spaceId || result.value.generation !== generation || result.value.path !== path || result.value.mode !== mode) throw new Error('Repository diff response does not match the requested view.');
      setRepositoryDiff(result.value);
    }).catch((error: unknown) => { if (pending.current()) setActionError(rpcErrorMessage(error, 'inspector.repository.diff')); });
  };
  const refreshOverviewAndThreads = async (): Promise<void> => {
    await Promise.all([overview.refetch(), threads.refetch()]);
  };
  const artifactReferences = artifactValue ? artifactValue.artifacts.map((artifact) => ({
    kind: 'artifact' as const, url: artifact.url, hash: artifact.hash, label: artifact.path,
    mediaType: artifact.mediaType,
    generation: artifactValue.scopes.find((scope) => scope.workspaceId === (artifact.workspaceId ?? projectId))?.generation ?? 0,
  })) : [];

  return <><div className="shrink-0">
    {overviewRead.refreshing ? <p role="status" className="sr-only">Refreshing Inspector…</p> : null}
    {overviewRead.error ? <p role="alert" className="px-4 py-2 text-caption text-destructive">Inspector overview refresh failed; showing the last accepted state. {rpcErrorMessage(overviewRead.error, 'inspector.overview')}<Button variant="ghost" size="compact" onClick={() => void overview.refetch()}>Retry overview</Button></p> : null}
    {threads.state === 'failure' ? <p role="alert" className="px-4 py-2 text-caption text-destructive">Review threads {threadsValue ? 'refresh failed; showing the last accepted state.' : 'could not load.'} {rpcErrorMessage(threads.error, 'inspector.review.list')}<Button variant="ghost" size="compact" onClick={() => void threads.refetch()}>Retry review threads</Button></p> : null}
    {stackStatus.state === 'failure' ? <p role="alert" className="px-4 py-2 text-caption text-destructive">Stack status {stackValue ? 'refresh failed; showing the last accepted state.' : 'could not load.'} {rpcErrorMessage(stackStatus.error, 'workspace.stackStatus')}<Button variant="ghost" size="compact" onClick={() => void stackStatus.refetch()}>Retry stack status</Button></p> : null}
    {actionError ? <p role="alert" className="px-3 py-1 text-caption text-destructive">{actionError}</p> : null}
  </div><Inspector
    overview={overviewValue}
    runtimeAvailable={runtimeAvailable}
    initialView={initialView}
    resourceRequest={resourceRequest}
    onRequestResource={(uri, signal) => loadInspectorResource({
      readArtifact: (input, options) => rpcClient.inspector.artifacts.read(input, options),
      readResource: (input, options) => rpcClient.inspector.resources.read(input, options),
      ...(runtimeContext ? { readBrowserArtifact: async (input: { machineId: string; artifactId: string; offset: number; limit: number }, signal?: AbortSignal) => {
        const response = await rpcClient.runtime.session({ projectId: runtimeContext.snapshot.projectId, workspaceId: runtimeContext.snapshot.workspaceId, ...(runtimeContext.conversationId ? { conversationId: runtimeContext.conversationId } : {}), command: { type: 'browserArtifact', ...input } }, { signal });
        if (response.status === 'error') throw response.error;
        if (!response.value.browserArtifact) throw new Error('The machine did not return browser artifact content.');
        return response.value.browserArtifact;
      } } : {}),
    }, { spaceId, projectId, generation, sessionId, runtimeAvailable }, uri, signal)}
    scope={scope}
    workspaces={workspaces}
    environment={<LiveEnvironment projectId={projectId} projectName={scope?.projectName ?? projectId} workspaceName={scope?.name ?? spaceId} spaceId={spaceId} workspace={spaceId !== projectId} generation={generation} machineId={scope?.holder.kind === 'held' ? scope.holder.machineId : undefined} runtimeAvailable={runtimeAvailable} onAskAgent={onAskAgent} />}
    onSelectWorkspace={onSelectWorkspace}
    onSetRelations={onSetRelations}
    stackStatus={stackValue ?? null}
    repositoryEntries={repositoryValue ?? []}
    lfsHeldBack={runtimeLfsHeldBack(runtimeContext?.snapshot)}
    repositoryMode={repositoryMode}
    onRepositoryModeChange={setRepositoryMode}
    repositoryFile={repositoryFile}
    repositoryDiff={repositoryDiff}
    journalEntries={journalValue ?? []}
    artifactReferences={artifactReferences}
    artifactActions={artifactValue ? {
      projectFiles: artifactValue.artifacts.filter((artifact) => artifact.scope === 'base').map(({ path, hash }) => ({ path, hash })),
      copy: async (files) => {
        try {
          const result = await rpcClient.inspector.artifacts.copyToProject({ ...request, files, expectedProjectGeneration: artifactValue.scopes.find((scope) => scope.workspaceId === projectId)?.generation ?? 0 });
          if (result.status === 'error') throw result.error;
        } finally { await artifactCatalog.refetch(); }
      },
      listShares: async (url) => {
        const result = await rpcClient.inspector.artifacts.shares.list({ ...request, url });
        if (result.status === 'error') throw result.error;
        return result.value;
      },
      createShare: async (reference, expiresAt) => {
        const result = await rpcClient.inspector.artifacts.shares.create({ ...request, url: reference.url, hash: reference.hash, expiresAt });
        if (result.status === 'error') throw result.error;
        return result.value;
      },
      revokeShare: async (id) => {
        const result = await rpcClient.inspector.artifacts.shares.revoke({ ...request, id });
        if (result.status === 'error') throw result.error;
      },
    } : undefined}
    artifactUpload={{
      begin: async (input) => {
        const result = await rpcClient.inspector.artifacts.uploadBegin({ ...request, ...input });
        if (result.status === 'error') throw result.error;
        return result.value;
      },
      chunk: async (input, signal) => {
        const result = await rpcClient.inspector.artifacts.uploadChunk({ ...request, ...input }, { signal });
        if (result.status === 'error') throw result.error;
        return result.value;
      },
      commit: async (uploadId) => {
        try {
          const result = await rpcClient.inspector.artifacts.uploadCommit({ ...request, uploadId });
          if (result.status === 'error') throw result.error;
          const artifact = result.value;
          return {
            kind: 'artifact', url: artifact.url, hash: artifact.hash, label: artifact.path, mediaType: artifact.mediaType,
            generation: artifactValue?.scopes.find((scope) => scope.workspaceId === (artifact.workspaceId ?? projectId))?.generation ?? generation,
          };
        } finally { await artifactCatalog.refetch(); }
      },
      abort: async (uploadId) => {
        const result = await rpcClient.inspector.artifacts.uploadAbort({ ...request, uploadId });
        if (result.status === 'error') throw result.error;
      },
    }}
    onLoadRepositoryDiff={async (path, mode, baseRef) => {
      const result = await rpcClient.inspector.repository.diff({ ...request, path, mode, baseRef: baseRef ?? null });
      if (result.status === 'error') throw result.error;
      if (repositoryScope.current !== readKey || result.value.spaceId !== spaceId || result.value.generation !== generation || result.value.path !== path || result.value.mode !== mode) throw new Error('Guide diff response does not match the requested view.');
      return result.value;
    }}
    threads={threadsValue ?? []}
    services={servicesValue ?? []}
    subagents={runtimeInspector?.subagents ?? subagents}
    usage={runtimeInspector?.usage ?? {
      sessionId,
      report: usageRead.value ?? null,
      status: !controlsAvailable || !usageRequested || sessionId === null ? 'idle' : usage.fetch === 'fetching' || usage.state === 'pending' ? 'loading' : usageRead.error ? 'error' : 'ready',
      ...(usageRead.error ? { error: rpcErrorMessage(usageRead.error, 'Load session usage') } : {}),
      load: () => setUsageRequested(true),
      refresh: () => { if (!runtimeAvailable || !controlsAvailable || sessionId === null) return; setUsageRequested(true); setUsageRevision((current) => current + 1); },
    }}
    agentSetup={runtimeInspector?.agentSetup ?? {
      sessionId,
      report: agentsRead.value ?? null,
      status: !controlsAvailable || !agentsRequested || sessionId === null ? 'idle' : agents.fetch === 'fetching' || agents.state === 'pending' ? 'loading' : agentsRead.error ? 'error' : 'ready',
      ...(agentsRead.error ? { error: rpcErrorMessage(agentsRead.error, 'session.agents') } : {}),
      load: () => { if (!runtimeAvailable || !controlsAvailable || sessionId === null) return; if (agentsRequested) { if (agents.fetch !== 'fetching') void agents.refetch(); } else setAgentsRequested(true); },
      refresh: () => { if (!runtimeAvailable || !controlsAvailable || sessionId === null) return; if (agentsRequested) { if (agents.fetch !== 'fetching') void agents.refetch(); } else setAgentsRequested(true); },
      save: async (input) => {
        if (!runtimeAvailable || !controlsAvailable || sessionId === null) throw new Error('The workspace session is unavailable.');
        const result = await rpcClient.session.saveAgent({ sessionId, ...input });
        if (result.status === 'error') throw result.error;
        queryRuntime.cache.update(rpcClient.session.agents, { sessionId }, () => result.value);
        void repository.refetch();
        return result.value;
      },
    }}
    onRequestArtifact={(reference, signal) => loadInspectorContent(
      // Catalog URLs carry raw names ("report (1).zip", "100% done.txt"); resource URIs reject raw whitespace, `?`, `#`, and bare `%`.
      rpcClient.inspector.artifacts.read({ spaceId, expectedGeneration: generation, url: reference.url.replace(/[\u0000-\u0020\u007f?#]|%(?![0-9A-Fa-f]{2})/gu, encodeURIComponent), hash: reference.hash }, { signal }),
      reference.url,
      signal,
    )}
    reviewerId={reviewerId}
    sectionErrors={{
      files: repository.state === 'failure' ? { message: rpcErrorMessage(repository.error, 'inspector.repository.tree'), retained: repositoryValue !== undefined, retry: () => void repository.refetch() } : undefined,
      journal: journal.state === 'failure' ? { message: rpcErrorMessage(journal.error, 'inspector.journal.list'), retained: journalValue !== undefined, retry: () => void journal.refetch() } : undefined,
      services: services.state === 'failure' ? { message: rpcErrorMessage(services.error, 'inspector.services.list'), retained: servicesValue !== undefined, retry: () => void services.refetch() } : undefined,
      artifacts: artifactCatalog.state === 'failure' ? { message: rpcErrorMessage(artifactCatalog.error, 'inspector.artifacts.list'), retained: artifactValue !== undefined, retry: () => void artifactCatalog.refetch() } : undefined,
    }}
    onClose={onClose}
    onRequestRepositoryFile={requestRepositoryFile}
    onRequestRepositoryDiff={requestRepositoryDiff}
    onCreateThread={async ({ anchor, body, decision }) => {
      const now = new Date().toISOString();
      const result = await rpcClient.inspector.review.create({
        expectedGeneration: generation,
        input: {
          projectId,
          spaceId,
          id: crypto.randomUUID(),
          anchor,
          decision,
          message: { id: crypto.randomUUID(), authorId: reviewerId, body, createdAt: now },
        },
      });
      if (result.status === 'error') throw result.error;
      await refreshOverviewAndThreads();
      return result.value;
    }}
    onReplyThread={async (threadId, expectedRevision, body) => {
      const result = await rpcClient.inspector.review.reply({
        expectedGeneration: generation,
        input: {
          projectId,
          spaceId,
          threadId,
          expectedRevision,
          message: { id: crypto.randomUUID(), authorId: reviewerId, body, createdAt: new Date().toISOString() },
        },
      });
      if (result.status === 'error') throw result.error;
      await refreshOverviewAndThreads();
    }}
    onResolveThread={async (threadId, expectedRevision, resolved, decision) => {
      const result = await rpcClient.inspector.review.resolve({
        expectedGeneration: generation,
        input: { projectId, spaceId, threadId, expectedRevision, resolved, decision },
      });
      if (result.status === 'error') throw result.error;
      await refreshOverviewAndThreads();
    }}
    onStartService={async (serviceName) => {
      const result = await rpcClient.inspector.services.start({ spaceId, expectedGeneration: generation, serviceName });
      if (result.status === 'error') throw result.error;
      await services.refetch();
    }}
    onStopService={async (serviceName) => {
      const result = await rpcClient.inspector.services.stop({ spaceId, expectedGeneration: generation, serviceName });
      if (result.status === 'error') throw result.error;
      await services.refetch();
    }}
    onGenerateChangeGuide={onGenerateChangeGuide}
    onMarkGuideSectionRead={async (sectionId, revision, headCommit) => {
      const result = await rpcClient.inspector.guide.markSectionRead({
        expectedGeneration: generation,
        input: { projectId, spaceId, sectionId, revision, headCommit, reviewerId },
      });
      if (result.status === 'error') throw result.error;
      await overview.refetch();
    }}
    onSetGuideApproval={async (decision, note, revision, headCommit) => {
      const result = await rpcClient.inspector.guide.setApproval({
        expectedGeneration: generation,
        input: { projectId, spaceId, decision, note, revision, headCommit, reviewerId },
      });
      if (result.status === 'error') throw result.error;
      await overview.refetch();
    }}
    onSubmitHumanJudgment={overviewValue.rubric ? async (criterionId, verdict, summary) => {
      const result = await rpcClient.inspector.rubric.appendJudgment({
        expectedGeneration: generation,
        input: {
          projectId,
          spaceId,
          expectedRevision: overviewValue.rubric!.revision,
          criterionId,
          judgment: {
            id: crypto.randomUUID(),
            kind: 'human',
            verdict,
            summary,
            actorId: reviewerId,
            evidence: [],
            createdAt: new Date().toISOString(),
          },
        },
      });
      if (result.status === 'error') throw result.error;
      await overview.refetch();
    } : undefined}
  /></>;
}

function useProductLocation(): URL {
  const [location, setLocation] = useState(() => new URL(window.location.href));
  useEffect(() => {
    const changed = () => setLocation(new URL(window.location.href));
    window.addEventListener('popstate', changed);
    return () => window.removeEventListener('popstate', changed);
  }, []);
  return location;
}

function refreshInspection(): void {
  window.dispatchEvent(new Event(ACCOUNT_DIRECTORY_CHANGED));
}

type AccountWorkActions = Required<ComponentProps<typeof AccountWorkPages>['actions']>;
const AccountWorkActionsContext = createContext<AccountWorkActions | null>(null);
/** The sidebar can open a project's Settings from any route; the Projects view renders the dialog. */
const ProjectSettingsContext = createContext<{ projectId: string | null; onChange(projectId: string | null): void } | null>(null);

/** The account frame survives settings, machine availability, and every pane replacement. */
function AccountFrame({ children }: { children: ReactNode }) {
  const location = useProductLocation();
  const route = productRouteFromLocation(location);
  const projects = useAccountProjects();
  const settings = useAccountSettings();
  const settingsValue = useRetainedQueryValue(settings, 'account-settings');
  const machines = useAccountMachines();
  const machineValues = useRetainedQueryValue(machines, 'account-machines');
  useEffect(() => {
    if (isConfigurationView(route) && settings.state === 'success') applyAppearance(settings.value.defaults.appearance);
  }, [route, settings.state, settings.state === 'success' ? settings.value.defaults.appearance : null]);
  const [runtimeSidebar, setRuntimeSidebar] = useState<AppSidebarProps | null>(null);
  const [sidebarActionError, setSidebarActionError] = useState<string | null>(null);
  const [closePendingSpaceId, setClosePendingSpaceId] = useState<string | null>(null);
  const [newWorkspaceProject, setNewWorkspaceProject] = useState<string | null>(null);
  const [createPending, setCreatePending] = useState(false);
  const createPendingRef = useRef(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [settingsProjectId, setSettingsProjectId] = useState<string | null>(null);
  const projectSettings = useMemo(() => ({ projectId: settingsProjectId, onChange: setSettingsProjectId }), [settingsProjectId]);
  const projectId = location.searchParams.get('project');
  const workspaceId = location.searchParams.get('workspace');
  const retainedProjects = useRetainedQueryValue(projects, 'account-projects');
  const projectValues = useMemo(() => retainedProjects ?? [], [retainedProjects]);
  const { directory, acceptRuntime } = useWorkspaceProjection(projectValues);
  const live = route === 'agent' && runtimeSidebar?.selected?.projectId === projectId && runtimeSidebar.selected.workspaceId === workspaceId ? runtimeSidebar : null;
  const sidebarProjects: SidebarProject[] = projectValues.map((project) => ({
    id: project.id, name: project.name, lifecycle: project.lifecycle,
    ...directory[project.id], workspaces: directory[project.id]?.workspaces ?? [],
  }));
  const frameView = route === 'agent' && !projectId ? 'projects' : route;
  useEffect(() => { if (frameView !== 'projects') setSettingsProjectId(null); }, [frameView]);
  const globalSidebar = frameView !== 'agent' && runtimeSidebar?.view === frameView && runtimeSidebar.selected === null ? runtimeSidebar : null;
  const accountDirectory = useMemo(() => ({
    projects: projectValues,
    directory,
    acceptRuntime,
    loading: projects.state === 'pending' && projectValues.length === 0,
    refresh: refreshInspection,
  }), [projectValues, directory, acceptRuntime, projects.state]);
  const lfsTransition = useLfsTransition();
  const actions = useAccountWorkActions(accountDirectory, lfsTransition.confirm);
  const runSidebarAction = async (operation: () => void | Promise<void>): Promise<void> => {
    setSidebarActionError(null);
    try { await operation(); }
    catch (cause) { setSidebarActionError(rpcErrorMessage(cause, 'Workspace action')); }
  };
  const navigate = (view: ProductRoute, section?: 'source'): void => {
    const url = setProductRoute(new URL(window.location.href), view);
    if (section) url.searchParams.set('section', section);
    else url.searchParams.delete('section');
    navigateProductUrl(url);
  };
  return <AccountWorkActionsContext.Provider value={actions}><ProjectSettingsContext.Provider value={projectSettings}><AccountSidebarContext.Provider value={setRuntimeSidebar}><AccountDirectoryContext.Provider value={accountDirectory}>
    <SidebarProvider className="gitspace-shell" persist={false}>
      <AppSidebar {...(live ?? globalSidebar)} view={frameView} onView={navigate} selected={route === 'agent' && projectId ? { projectId, workspaceId } : null} projects={sidebarProjects} machines={(machineValues ?? []).filter((machine) => machine.state === 'online' && machine.rpcEndpoint !== null).map(({ id, label }) => ({ id, label }))} onSelectProject={(id) => selectInspection(id, null)} onSelectWorkspace={(workspace) => selectInspection(workspace.projectId, workspace.id)} onOpenSettings={(section) => navigate('settings', section)} user={settingsValue ? { name: settingsValue.profile.displayName, handle: settingsValue.profile.handle } : undefined}
        closePendingSpaceId={closePendingSpaceId}
        onClose={async (spaceId) => {
          if (closePendingSpaceId) return;
          setClosePendingSpaceId(spaceId);
          try { await runSidebarAction(() => actions.onCloseSpace(spaceId)); }
          finally { setClosePendingSpaceId(null); }
        }}
        onReopen={(spaceId) => runSidebarAction(() => actions.onReopenSpace(spaceId))}
        onArchive={(spaceId) => runSidebarAction(() => actions.onArchiveWorkspace(spaceId))}
        onRestore={(spaceId) => runSidebarAction(() => actions.onClaimWorkspace(spaceId, null))}
        onNewWorkspace={(id) => { setCreateError(null); setNewWorkspaceProject(id); }}
        onOpenProjectSettings={(id) => { setSettingsProjectId(id); navigate('projects'); }}
      />
      <SidebarInset className="min-w-0 overflow-hidden">
        {!live ? <SidebarInsetTopbar><nav aria-label="Location" className="min-w-0"><span aria-current="page" className="truncate text-body font-medium">{frameView === 'agent' ? projectValues.find((project) => project.id === projectId)?.name ?? 'Your account' : PRODUCT_ROUTE_LABELS[frameView]}</span></nav></SidebarInsetTopbar> : null}
        {projects.state === 'failure' ? <div role="alert" className="flex items-center gap-2 px-4 py-2 text-caption text-destructive"><span>{rpcErrorMessage(projects.error, 'Load project directory')}</span><Button variant="ghost" size="compact" onClick={() => void projects.refetch()}>Retry</Button></div> : null}
        {sidebarActionError ? <div role="alert" className="flex items-center gap-2 px-4 py-2 text-caption text-destructive"><span>Workspace action: {sidebarActionError}</span><Button variant="ghost" size="compact" onClick={() => setSidebarActionError(null)}>Dismiss</Button></div> : null}
        {children}
        {lfsTransition.dialog}
      </SidebarInset>
      <CreateWorkspaceDialog key={newWorkspaceProject ?? 'closed'} projectId={newWorkspaceProject} workspaces={sidebarProjects.flatMap((project) => project.workspaces.map((workspace) => ({ ...workspace, phase: workspace.definition?.phase ?? workspace.runtime?.phase ?? null })))} pending={createPending} error={createError} onOpenChange={(open) => { if (!open && !createPendingRef.current) { setNewWorkspaceProject(null); setCreateError(null); } }} onSubmit={async (input) => {
        if (createPendingRef.current) return;
        createPendingRef.current = true; setCreatePending(true); setCreateError(null);
        try { await actions.onCreateWorkspace(input); setNewWorkspaceProject(null); }
        catch (cause) { setCreateError(rpcErrorMessage(cause, 'Create workspace')); }
        finally { createPendingRef.current = false; setCreatePending(false); }
      }} />
    </SidebarProvider>
  </AccountDirectoryContext.Provider></AccountSidebarContext.Provider></ProjectSettingsContext.Provider></AccountWorkActionsContext.Provider>;
}

type LiveWorkspaceProps = { onOpenSettings: (section?: 'source') => void };

function selectInspection(projectId: string, workspaceId: string | null): void {
  const url = new URL(window.location.href);
  url.searchParams.set('project', projectId);
  if (workspaceId) url.searchParams.set('workspace', workspaceId);
  else url.searchParams.delete('workspace');
  navigateProductUrl(setProductRoute(url, 'agent'));
}


function LiveWorkspace(props: LiveWorkspaceProps) {
  const location = useProductLocation();
  const projects = useAccountProjects();
  const projectId = location.searchParams.get('project') ?? '';
  const workspaceId = location.searchParams.get('workspace');
  const projectValues = useRetainedQueryValue(projects, 'projects');
  const account = useContext(AccountDirectoryContext);
  if (!projectId) return <AccountWork view="projects" />;
  if (!projectValues && projects.state === 'failure') return <PageCanvas><EmptyState title="Project directory unavailable" description={rpcErrorMessage(projects.error, 'Load project directory')} action={<Button variant="ghost" onClick={() => void projects.refetch()}>Retry</Button>} /></PageCanvas>;
  if (!projectValues) return <PageCanvas><EmptyState icon={<ThinkingIndicator />} title="Loading projects…" description="Reading your account without starting a machine." /></PageCanvas>;
  const selectedProject = projectValues.find((project) => project.id === projectId);
  if (!selectedProject) return <PageCanvas><EmptyState title="Project not found" description="Choose another project from your account sidebar." /></PageCanvas>;
  return <RuntimeWorkspace key={JSON.stringify([projectId, workspaceId])} projectId={projectId} workspaceId={workspaceId ?? projectId} onOpenSettings={props.onOpenSettings} onSelectProject={(id) => selectInspection(id, null)} onSelectWorkspace={(id) => selectInspection(projectId, id)} renderInspector={(context) => <RuntimeInspector context={context} />} creation={workspaceId ? <CloudCreationProgress projectId={projectId} workspaceId={workspaceId} onDeleted={() => selectInspection(projectId, null)} /> : null} />;
}

export function RuntimeInspector({ context }: { context: RuntimeInspectorContext }) {
  const [reviewerId, setReviewerId] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void currentDevice().then((device) => { if (!cancelled) setReviewerId(device?.deviceId ?? null); });
    return () => { cancelled = true; };
  }, []);
  if (!reviewerId) return <EmptyState title="Loading Inspector…" description="Reading browser identity." />;
  return <LiveInspector projectId={context.snapshot.projectId} spaceId={context.snapshot.workspaceId} generation={context.scope.generation} reviewerId={reviewerId} sessionId={context.sessionId} turns={context.turns} scope={context.scope} workspaces={context.workspaces} onSelectWorkspace={(id) => selectInspection(context.snapshot.projectId, id)} onSetRelations={context.onSetRelations} refreshToken={context.snapshot.cursor} resourceRequest={context.resourceRequest} initialView={context.initialView} runtimeAvailable controlsAvailable={context.sessionId !== null} onAskAgent={context.onAskAgent} onGenerateChangeGuide={() => context.onAskAgent('Use the review-guide-narrator skill to generate or refresh the Change Guide.')} onClose={context.onClose} runtimeContext={context} />;
}




function GitSpaceProduct() {
  const location = useProductLocation();
  const route = productRouteFromLocation(location);
  const queryRuntime = useResultRuntime();
  const [draft, setDraft] = useState<UserSettings | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  // Preview the draft's scheme immediately; saving persists it for every machine.
  useEffect(() => { if (draft) applyAppearance(draft.defaults.appearance); }, [draft?.defaults.appearance]);
  const forceOnboarding = new URL(window.location.href).searchParams.get('mode') === 'onboarding';
  const settingsQuery = useAccountSettings();
  const settingsValue = useRetainedQueryValue(settingsQuery, 'settings');
  const productProjectsQuery = useAccountProjects();
  const productProjectsValue = useRetainedQueryValue(productProjectsQuery, 'projects');
  const selectedProjectId = location.searchParams.get('project') ?? '';
  const inference = useInference()!;
  const profileId = route === 'inference'
    ? location.searchParams.get('profile') ?? DEFAULT_INFERENCE_PROFILE_ID
    : !settingsValue?.onboardingComplete || forceOnboarding
      ? DEFAULT_INFERENCE_PROFILE_ID
      : inference.state?.assignments.find((assignment) => assignment.projectId === selectedProjectId)?.profileId ?? '';
  const activeProfile = inference.state?.profiles.find((profile) => profile.id === profileId);
  const providerScope = useRef(profileId);
  providerScope.current = profileId;
  const workspaceAvailability = useResultQuery(rpcClient.inspector.availability, { projectId: selectedProjectId, workspaceId: optionalQueryParameter('workspace') }, { enabled: selectedProjectId.length > 0 });
  const workspaceAvailabilityValue = useRetainedQueryValue(workspaceAvailability, JSON.stringify([selectedProjectId, optionalQueryParameter('workspace')]));
  const runtimeMetadataEnabled = route === 'settings' || route === 'inference' || forceOnboarding || (settingsValue !== undefined && !settingsValue.onboardingComplete) || workspaceAvailabilityValue?.runtimeAvailable === true;
  const machinesQuery = useAccountMachines();
  const machinesValue = useRetainedQueryValue(machinesQuery, 'machines');
  const cloudImagesQuery = useAccountCloudImages();
  const cloudImagesValue = useRetainedQueryValue(cloudImagesQuery, 'cloud-images');
  const imageDefaultQuery = useResultQuery(rpcClient.machine.image.defaults.get, {}, { enabled: runtimeMetadataEnabled });
  const imageDefaultValue = useRetainedQueryValue(imageDefaultQuery, 'cloud-image-default');
  const setCloudImage = useResultMutation(rpcClient.machine.image.set);
  const retryCloudImage = useResultMutation(rpcClient.machine.image.retry);
  const cancelCloudImage = useResultMutation(rpcClient.machine.image.cancel);
  const recoverWithCloudImage = useResultMutation(rpcClient.machine.image.recover);
  const setCloudImageDefault = useResultMutation(rpcClient.machine.image.defaults.set);
  const onlineMachineIds = (machinesValue ?? []).filter((machine) => machine.state === 'online' && machine.desiredState === 'online' && machine.rpcEndpoint).map((machine) => machine.id).sort().join(',');
  const runtimeAvailable = runtimeMetadataEnabled && onlineMachineIds.length > 0;
  const runtimeQuery = useResultQuery(rpcClient.settings.runtime.get, {}, { enabled: runtimeMetadataEnabled });
  const gitIdentityQuery = useAccountGitIdentity();
  const runtimeRead = useRetainedQueryValue(runtimeQuery, 'runtime-settings');
  const runtimeConfiguration = useAccountRuntimeConfiguration();
  const runtimeDocument = useRetainedQueryValue(runtimeConfiguration, 'runtime-document');
  const runtimeValue = runtimeRead;
  useEffect(() => {
    if (runtimeDocument && runtimeRead && runtimeDocument.generation > runtimeRead.document.generation) void runtimeQuery.refetch();
  }, [runtimeDocument?.generation, runtimeRead?.document.generation]);
  const gitIdentityValue = useRetainedQueryValue(gitIdentityQuery, 'git-identity');
  const settingsRuntimeValue = runtimeValue ?? { schema: [], document: runtimeDocument ?? { generation: 0, content: '', checksum: '', updatedAt: new Date(0).toISOString(), updatedBy: 'unavailable' }, sync: { status: 'error' as const, message: runtimeQuery.state === 'failure' ? rpcErrorMessage(runtimeQuery.error, 'settings.runtime.get') : 'Runtime settings are unavailable' } };
  const settingsGitIdentityValue = gitIdentityValue ?? null;
  const updateSettings = useResultMutation(rpcClient.settings.update);
  const reserveHandle = useResultMutation(rpcClient.settings.reserveHandle);
  const setRuntimeSetting = useResultMutation(rpcClient.settings.runtime.set);
  const updateMachineNotes = useResultMutation(rpcClient.machine.updateNotes);
  const ensureStarterProject = useResultMutation(rpcClient.project.ensureGitSpace);
  const createSandboxMachine = useResultMutation(rpcClient.machine.createSandbox);
  const sleepMachine = useResultMutation(rpcClient.machine.sleep);
  const resumeMachine = useResultMutation(rpcClient.machine.resume);
  const destroyMachine = useResultMutation(rpcClient.machine.destroy);
  const devicesQuery = useResultQuery(rpcClient.devices.list, {});
  const devicesValue = useRetainedQueryValue(devicesQuery, 'devices');
  const revokeDevice = useResultMutation(rpcClient.devices.revoke);
  const [browserDevice, setBrowserDevice] = useState<BrowserDevice | null>(null);
  useEffect(() => { void currentDevice().then(setBrowserDevice); }, []);
  const currentBrowserView = devicesValue?.find(device => device.current);
  const canManageMcp = Boolean(browserDevice && currentBrowserView?.current && currentBrowserView.deviceId === browserDevice.deviceId && currentBrowserView.kind === 'browser' && currentBrowserView.active && currentBrowserView.scope === 'user' && currentBrowserView.capabilities.includes('devices.manage'));
  // Settings → Source reads the same status entry LiveWorkspace polls; revert is only offered there.
  const settingsDeploymentQuery = useResultQuery(rpcClient.deployment.status, {}, { enabled: runtimeMetadataEnabled });
  const settingsDeploymentValue = useRetainedQueryValue(settingsDeploymentQuery, 'deployment');
  const revertDeployment = useResultMutation(rpcClient.deployment.revert);
  const composioSetupQuery = useResultQuery(rpcClient.mcp.composio.setup.get, {});
  const composioSetupValue = useRetainedQueryValue(composioSetupQuery, 'composio-setup');
  const putComposioSetup = useResultMutation(rpcClient.mcp.composio.setup.put);
  const deleteComposioSetup = useResultMutation(rpcClient.mcp.composio.setup.delete);
  const [browserRelayValue, setBrowserRelayValue] = useState<RuntimeAccountBrowserRelayStatus | null>(null);
  const [browserRelayError, setBrowserRelayError] = useState<string | null>(null);
  const refreshBrowserRelay = async () => {
    try { const value = await accountBrowserStatus(); setBrowserRelayValue(value); setBrowserRelayError(null); return value; }
    catch (error) { setBrowserRelayError(rpcErrorMessage(error, 'Account browser')); throw error; }
  };
  useEffect(() => { let active = true; void accountBrowserStatus().then(value => { if (active) setBrowserRelayValue(value); }, error => { if (active) setBrowserRelayError(rpcErrorMessage(error, 'Account browser')); }); return () => { active = false; }; }, []);
  const saveComposioSetup = async (apiKey: string): Promise<void> => {
    const result = await putComposioSetup.mutateAsync({ apiKey });
    if (result.status === 'error') throw result.error;
    await composioSetupQuery.refetch();
  };
  const removeComposioSetup = async (): Promise<void> => {
    const result = await deleteComposioSetup.mutateAsync({});
    if (result.status === 'error') throw result.error;
    await composioSetupQuery.refetch();
  };
  const runBrowserRelay = async (operation: 'setup' | 'start' | 'test'): Promise<void> => {
    if (operation === 'setup') await downloadAccountBrowserExtension();
    const value = await refreshBrowserRelay();
    if (operation === 'test' && !value.pairings.some(browser => browser.state === 'confirmed' && browser.connected)) throw new Error('Connect and confirm a Chrome, then approve it in project settings');
  };
  const revokeDeviceAndRefresh = async (deviceId: string): Promise<void> => {
    const result = await revokeDevice.mutateAsync({ deviceId });
    if (result.status === 'error') throw result.error;
    await devicesQuery.refetch();
  };
  const mintApiClient = async (draft: ApiClientDraft): Promise<string> => {
    const device = await currentDevice();
    if (!device) throw new Error('This browser is not enrolled');
    const pageUrl = new URL(window.location.href);
    const key = await createApiClient(device, draft, accountHandleFromUrl(pageUrl) ? pageUrl.origin : undefined);
    await devicesQuery.refetch();
    return key;
  };
  const signOutThisBrowser = async (): Promise<void> => {
    const device = await currentDevice();
    if (!device) return;
    const result = await revokeDevice.mutateAsync({ deviceId: device.deviceId });
    if (result.status === 'error') throw result.error;
    deviceRejected('SIGNED_OUT');
  };
  const providersEnabled = runtimeMetadataEnabled && !!activeProfile;
  const providersQuery = useResultQuery(rpcClient.providers.list, { profileId }, { enabled: providersEnabled });
  const modelsQuery = useResultQuery(rpcClient.providers.models, { profileId }, { enabled: providersEnabled });
  const providersKey = JSON.stringify(queryRuntime.cache.key(rpcClient.providers.list, { profileId }));
  const modelsKey = JSON.stringify(queryRuntime.cache.key(rpcClient.providers.models, { profileId }));
  const providersValue = useRetainedQueryValue(providersQuery, providersEnabled ? providersKey : null, { key: providersKey, updatedAt: providersQuery.updatedAt });
  const modelsValue = useRetainedQueryValue(modelsQuery, providersEnabled ? modelsKey : null, { key: modelsKey, updatedAt: modelsQuery.updatedAt });
  // Usage is optional account metadata, fetched only when the Providers view is shown.
  const [usageProfile, setUsageProfile] = useState<string | null>(null);
  const usageVisible = usageProfile === profileId;
  const [usageRefresh, setUsageRefresh] = useState(false);
  const usageQuery = useResultQuery(rpcClient.providers.usage, { profileId, providerId: null, refresh: usageRefresh }, { enabled: providersEnabled && usageVisible });
  const usageKey = JSON.stringify(queryRuntime.cache.key(rpcClient.providers.usage, { profileId, providerId: null, refresh: usageRefresh }));
  const usageValue = useRetainedQueryValue(usageQuery, providersEnabled ? usageKey : null, { key: usageKey, updatedAt: usageQuery.updatedAt });
  useEffect(() => { setUsageRefresh(false); }, [profileId]);
  useEffect(() => {
    if (!providersEnabled) return;
    void providersQuery.refetch();
    void modelsQuery.refetch();
    if (runtimeAvailable) void gitIdentityQuery.refetch();
    if (usageVisible) void usageQuery.refetch();
  }, [providersEnabled, profileId, activeProfile?.revision]);
  const startProviderLogin = useResultMutation(rpcClient.providers.login.start);
  const respondProviderLogin = useResultMutation(rpcClient.providers.login.respond);
  const cancelProviderLogin = useResultMutation(rpcClient.providers.login.cancel);
  const logoutProvider = useResultMutation(rpcClient.providers.logout);
  const setProviderApiKey = useResultMutation(rpcClient.providers.apiKey.set);
  const [loginFlow, setLoginFlow] = useState<(ProviderLoginFlow & { done: boolean }) | null>(null);
  const loginStream = useRef<AbortController | null>(null);
  useEffect(() => () => loginStream.current?.abort(), []);
  useEffect(() => {
    if (settingsQuery.state !== 'success') return;
    setDraft((current) => current?.revision === settingsQuery.value.revision ? current : { ...settingsQuery.value });
  }, [settingsQuery.state, settingsQuery.state === 'success' ? settingsQuery.value.revision : null]);
  const navigateProduct = (next: ProductRoute, mode: 'push' | 'replace' = 'push', section: 'source' | null = null): void => {
    const url = setProductRoute(new URL(window.location.href), next);
    if (section) url.searchParams.set('section', section);
    else url.searchParams.delete('section');
    navigateProductUrl(url, mode);
  };
  const saveSettings = async (next: UserSettings): Promise<void> => {
    if (settingsQuery.state !== 'success') throw new Error('Cloud settings are unavailable');
    setSettingsError(null);
    try {
      let current = settingsQuery.value;
      const requestedHandle = next.profile.handle?.trim() || current.profile.handle;
      if (requestedHandle && requestedHandle !== current.profile.handle) {
        const reserved = await reserveHandle.mutateAsync({ expectedRevision: current.revision, handle: requestedHandle });
        if (reserved.status === 'error') throw reserved.error;
        current = reserved.value;
      }
      const updated = await updateSettings.mutateAsync({
        expectedRevision: current.revision,
        onboardingComplete: next.onboardingComplete,
        profile: { displayName: next.profile.displayName, handle: current.profile.handle },
        git: next.git,
        defaults: next.defaults,
      });
      if (updated.status === 'error') throw updated.error;
      setDraft({ ...updated.value });
      await settingsQuery.refetch();
    } catch (error) {
      setSettingsError(rpcErrorMessage(error, 'Save account settings'));
      throw error;
    }
  };
  const updateRuntime = async (path: string, value: RuntimeSettingValue): Promise<void> => {
    setSettingsError(null);
    try {
      const updated = await setRuntimeSetting.mutateAsync({ expectedGeneration: settingsRuntimeValue.document.generation, path, valueJson: JSON.stringify(value) });
      if (updated.status === 'error') throw updated.error;
      await runtimeQuery.refetch();
    } catch (error) {
      setSettingsError(rpcErrorMessage(error, 'settings.runtime.set'));
      throw error;
    }
  };
  const saveMachineNotes = async (machineId: string, notes: string): Promise<void> => {
    setSettingsError(null);
    const result = await updateMachineNotes.mutateAsync({ machineId, notes });
    if (result.status === 'error') {
      setSettingsError(rpcErrorMessage(result.error, 'machine.updateNotes'));
      throw result.error;
    }
    await machinesQuery.refetch();
  };
  const createSandbox = async (image?: CloudImageSelection): Promise<void> => {
    setSettingsError(null);
    const result = await createSandboxMachine.mutateAsync({ image });
    if (result.status === 'error') {
      setSettingsError(rpcErrorMessage(result.error, 'Create sandbox machine'));
      throw result.error;
    }
    await machinesQuery.refetch();
  };
  const changeCloudImage = async (machineId: string, selection: CloudImageSelection, previousOperationId?: string, discardUncheckpointedCandidate?: boolean): Promise<void> => {
    setSettingsError(null);
    const result = previousOperationId
      ? await recoverWithCloudImage.mutateAsync({ machineId, selection, operationId: previousOperationId, recoveryOperationId: crypto.randomUUID(), discardUncheckpointedCandidate })
      : await setCloudImage.mutateAsync({ machineId, selection, operationId: crypto.randomUUID() });
    if (result.status === 'error') { setSettingsError(rpcErrorMessage(result.error, 'Change machine image')); throw result.error; }
  };
  const recoverCloudImage = async (machineId: string, operationId: string, cancel: boolean): Promise<void> => {
    setSettingsError(null);
    const result = await (cancel ? cancelCloudImage : retryCloudImage).mutateAsync({ machineId, operationId });
    if (result.status === 'error') { setSettingsError(rpcErrorMessage(result.error, cancel ? 'Cancel machine image operation' : 'Retry machine image operation')); throw result.error; }
  };
  const saveCloudImageDefault = async (selection: CloudImageSelection): Promise<void> => {
    setSettingsError(null);
    const result = await setCloudImageDefault.mutateAsync({ selection });
    if (result.status === 'error') { setSettingsError(rpcErrorMessage(result.error, 'machine.image.defaults.set')); throw result.error; }
    await imageDefaultQuery.refetch();
  };
  const controlMachine = async (action: 'sleep' | 'resume', machineId: string): Promise<void> => {
    setSettingsError(null);
    const mutation = action === 'sleep' ? sleepMachine : resumeMachine;
    const result = await mutation.mutateAsync({ machineId });
    if (result.status === 'error') {
      setSettingsError(rpcErrorMessage(result.error, action === 'sleep' ? 'Sleep machine' : 'Resume machine'));
      throw result.error;
    }
    await machinesQuery.refetch();
  };
  const removeMachine = async (machineId: string): Promise<void> => {
    setSettingsError(null);
    const result = await destroyMachine.mutateAsync({ machineId });
    if (result.status === 'error') {
      setSettingsError(rpcErrorMessage(result.error, 'Destroy machine'));
      throw result.error;
    }
    await machinesQuery.refetch();
  };
  const revertToChannel = async (): Promise<void> => {
    setSettingsError(null);
    const result = await revertDeployment.mutateAsync({});
    if (result.status === 'error') {
      setSettingsError(rpcErrorMessage(result.error, 'Revert release'));
      throw result.error;
    }
    await settingsDeploymentQuery.refetch();
  };
  const completeOnboarding = async (next: UserSettings): Promise<void> => {
    setSettingsError(null);
    try {
      const ensured = await ensureStarterProject.mutateAsync({
        sourceBranch: import.meta.env.VITE_GITSPACE_SOURCE_BRANCH || undefined,
        sourceCommit: import.meta.env.VITE_GITSPACE_SOURCE_COMMIT || undefined,
      });
      if (ensured.status === 'error') throw ensured.error;
      await productProjectsQuery.refetch();
      await saveSettings({ ...next, onboardingComplete: true });
      const url = setProductRoute(new URL(window.location.href), 'projects');
      url.searchParams.delete('project');
      url.searchParams.delete('workspace');
      navigateProductUrl(url, 'replace');
    } catch (error) {
      setSettingsError(rpcErrorMessage(error, 'Complete account setup'));
      throw error;
    }
  };
  const refreshProviders = async (): Promise<void> => {
    await providersQuery.refetch();
    await modelsQuery.refetch();
    if (usageVisible) await usageQuery.refetch();
  };
  const connectProviderLogin = (flow: RecoverableProviderLogin): void => {
    loginStream.current?.abort();
    const controller = new AbortController();
    loginStream.current = controller;
    setLoginFlow({ ...flow, events: [], done: false });
    void (async () => {
      try {
        for await (const event of rpcClient.providers.login.events({ profileId: flow.profileId, flowId: flow.flowId }, { signal: controller.signal })) {
          if (controller.signal.aborted) return;
          if (event.status === 'error') throw event.error;
          setLoginFlow((current) => current?.flowId === flow.flowId ? { ...current, events: [...current.events, event.value], done: event.value.type === 'done' } : current);
          if (event.value.type === 'done') {
            forgetProviderLogin(flow.profileId);
            if (event.value.ok && providerScope.current === flow.profileId) await refreshProviders();
            return;
          }
        }
        if (!controller.signal.aborted) throw new Error('Sign-in updates disconnected. The cloud flow has not been canceled.');
      } catch (cause) {
        if (!controller.signal.aborted) setLoginFlow((current) => current?.flowId === flow.flowId ? { ...current, connectionError: rpcErrorMessage(cause, 'Read cloud sign-in') } : current);
      }
    })();
  };
  useEffect(() => {
    setLoginFlow(null);
    if (!activeProfile) return;
    try {
      const saved = readProviderLogin(activeProfile.id);
      if (saved) connectProviderLogin(saved);
    } catch (cause) { setSettingsError(rpcErrorMessage(cause, 'Resume cloud sign-in')); }
    return () => { loginStream.current?.abort(); };
  }, [activeProfile?.id]);
  const signInProvider = async (providerId: string): Promise<void> => {
    if (!activeProfile) throw new Error('An active inference profile is required to connect providers.');
    if (loginFlow?.profileId === profileId && !loginFlow.done) {
      const cancelled = await cancelProviderLogin.mutateAsync({ profileId: loginFlow.profileId, flowId: loginFlow.flowId });
      if (cancelled.status === 'error') throw cancelled.error;
      forgetProviderLogin(loginFlow.profileId);
    }
    loginStream.current?.abort();
    setSettingsError(null);
    const started = await startProviderLogin.mutateAsync({ profileId, providerId });
    if (started.status === 'error') {
      setSettingsError(rpcErrorMessage(started.error, 'Start provider sign-in'));
      throw started.error;
    }
    const flow = { flowId: started.value.flowId, profileId, providerId };
    if (providerScope.current === flow.profileId) connectProviderLogin(flow);
    try { saveProviderLogin(flow); }
    catch (cause) { setSettingsError(`Sign-in started, but this browser could not save its recovery identity. Keep this page open or cancel and retry with browser storage enabled. ${rpcErrorMessage(cause, 'Save sign-in recovery')}`); }
  };
  const respondLogin = async (promptId: string, value: string): Promise<void> => {
    if (!loginFlow) throw new Error('No sign-in in progress');
    const result = await respondProviderLogin.mutateAsync({ profileId: loginFlow.profileId, flowId: loginFlow.flowId, promptId, value });
    if (result.status === 'error') throw result.error;
  };
  const dismissLogin = async (): Promise<void> => {
    const flow = loginFlow;
    if (!flow) return;
    // Only an explicit Cancel cancels the cloud flow. Unload merely stops this observer.
    if (!flow.done) {
      const result = await cancelProviderLogin.mutateAsync({ profileId: flow.profileId, flowId: flow.flowId });
      if (result.status === 'error') throw result.error;
    }
    forgetProviderLogin(flow.profileId);
    loginStream.current?.abort();
    loginStream.current = null;
    setLoginFlow(null);
  };
  const signOutProvider = async (providerId: string, credentialId: string | null): Promise<void> => {
    const result = await logoutProvider.mutateAsync({ profileId, providerId, credentialId });
    if (result.status === 'error') throw result.error;
    await refreshProviders();
  };
  const saveProviderApiKey = async (providerId: string, key: string): Promise<void> => {
    const result = await setProviderApiKey.mutateAsync({ profileId, providerId, key });
    if (result.status === 'error') throw result.error;
    await refreshProviders();
  };
  const refreshUsage = async (): Promise<void> => {
    await providersQuery.refetch();
    if (usageRefresh) await usageQuery.refetch();
    else setUsageRefresh(true);
  };
  const providerViews = providersValue?.providers ?? [];
  const providersSection: ProvidersSectionProps = {
    providers: providerViews,
    loading: providersValue === undefined,
    ...(providersQuery.state === 'failure' ? { error: rpcErrorMessage(providersQuery.error, 'providers.list') } : {}),
    usage: usageValue ?? null,
    usageStatus: !usageVisible ? 'idle' : usageQuery.state === 'failure' ? 'error' : usageQuery.state === 'pending' || usageQuery.fetch === 'fetching' ? 'loading' : 'ready',
    ...(usageQuery.state === 'failure' ? { usageError: rpcErrorMessage(usageQuery.error, 'providers.usage') } : {}),
    onShow: () => setUsageProfile(profileId),
    onRefreshUsage: refreshUsage,
    onSignIn: signInProvider,
    onSignOut: signOutProvider,
    onSetApiKey: saveProviderApiKey,
    login: { flow: loginFlow?.profileId === profileId ? loginFlow : null, respond: respondLogin, cancel: dismissLogin, reconnect: () => { if (loginFlow) connectProviderLogin(loginFlow); } },
  };
  const inferencePage = (onboarding = false) => <InferencePage
    inference={inference} selectedProfileId={profileId} onSelectProfile={(id) => {
      const url = setProductRoute(new URL(window.location.href), 'inference');
      url.searchParams.set('profile', id);
      navigateProductUrl(url);
    }}
    projects={productProjectsValue ?? []}
    schema={inferenceSettingMetadata.map(({ value, description, options, ...item }) => ({ ...item, valueJson: JSON.stringify(value), description: description ?? null, options: options ?? [] }))} schemaLoading={false}
    schemaError={null}
    onRefreshSchema={() => { void modelsQuery.refetch(); }}
    models={modelsValue?.models ?? []} modelsReady={modelsValue !== undefined} modelsLoading={modelsQuery.state === 'pending'}
    modelsError={modelsQuery.state === 'failure' ? rpcErrorMessage(modelsQuery.error, 'providers.models') : null}
    providers={providersSection} onboarding={onboarding}
    initialTab={onboarding || location.searchParams.get('section') === 'providers' ? 'Providers' : undefined}
  />;
  if (route === 'inference') return inferencePage();
  // Account/machine metadata refreshes are not navigation away from an open workspace.
  if (settingsValue && draft?.onboardingComplete && !forceOnboarding && route !== 'settings') return <>
    <LiveWorkspace onOpenSettings={(section) => navigateProduct('settings', 'push', section ?? null)} />
    {settingsQuery.state === 'failure' ? <div role="alert" className="fixed inset-x-0 top-[var(--app-notice-top)] z-50 mx-auto w-fit max-w-full rounded-lg bg-surface-3 px-3 py-2 text-caption text-foreground shadow-surface-3">Account settings: {rpcErrorMessage(settingsQuery.error, 'settings.get')}<Button variant="ghost" size="compact" onClick={() => void settingsQuery.refetch()}>Retry</Button></div> : null}
  </>;
  if (!settingsValue && settingsQuery.state === 'failure') {
    return <PageCanvas><EmptyState title="GitSpace setup is unavailable" description={rpcErrorMessage(settingsQuery.error, 'settings.get')} action={<Button variant="ghost" onClick={() => void settingsQuery.refetch()}>Retry</Button>} /></PageCanvas>;
  }
  if (!settingsValue || !draft) {
    return <PageCanvas><EmptyState icon={<ThinkingIndicator />} title="Opening your GitSpace account…" description="Loading cloud settings." /></PageCanvas>;
  }
  const reads = [
    ['Account settings', settingsQuery], ['Runtime settings', runtimeQuery], ['Git identity', gitIdentityQuery], ['Machines', machinesQuery],
    ['Devices', devicesQuery], ['Source', settingsDeploymentQuery], ['Composio setup', composioSetupQuery],
    ['Projects', productProjectsQuery], ['Models', modelsQuery],
    ['Cloud images', cloudImagesQuery], ['Cloud image default', imageDefaultQuery],
  ] as const;
  const page = (mode: 'settings' | 'onboarding') => <>
    {browserRelayError ? <p role="alert" className="px-8 py-1 text-caption text-destructive">{browserRelayError}<Button variant="ghost" size="compact" onClick={() => void refreshBrowserRelay().catch(() => {})}>Retry browser status</Button></p> : null}
    {reads.map(([label, query]) => query.state === 'failure' ? <p key={label} role="alert" className="px-8 py-1 text-caption text-destructive">{label}: {rpcErrorMessage(query.error, label)}<Button variant="ghost" size="compact" onClick={() => void query.refetch()}>Retry</Button></p> : null)}
    <SettingsPage
    mode={mode}
    settings={draft}
    machines={machinesValue ?? []}
    runtimeSettings={settingsRuntimeValue.schema}
    inferenceSetup={inferencePage(true)}
    runtimeGeneration={settingsRuntimeValue.document.generation}
    runtimeSync={settingsRuntimeValue.sync}
    gitIdentity={settingsGitIdentityValue}
    onChange={(next) => {
      setDraft(next);
      // Appearance is a toggle, not a form field: previewing without saving
      // would snap back on reload, so it persists as soon as it changes.
      if (draft && next.defaults.appearance !== draft.defaults.appearance) void saveSettings(next).catch(() => undefined);
    }}
    onSave={saveSettings}
    onSetRuntimeSetting={updateRuntime}
    onUpdateMachine={saveMachineNotes}
    onCreateSandbox={createSandbox}
    cloudImages={cloudImagesValue ?? []}
    cloudImageDefault={imageDefaultValue ?? null}
    cloudImageError={cloudImagesQuery.state === 'failure' ? rpcErrorMessage(cloudImagesQuery.error, 'machine.image.list') : imageDefaultQuery.state === 'failure' ? rpcErrorMessage(imageDefaultQuery.error, 'machine.image.defaults.get') : null}
    onChangeCloudImage={changeCloudImage}
    onRecoverCloudImage={recoverCloudImage}
    onSetCloudImageDefault={saveCloudImageDefault}
    onControlMachine={controlMachine}
    onDestroyMachine={removeMachine}
    deployment={settingsDeploymentValue ?? null}
    onRevertDeployment={revertToChannel}
    devices={devicesValue ?? null}
    onRevokeDevice={revokeDeviceAndRefresh}
    onSignOut={signOutThisBrowser}
    onCreateApiClient={mintApiClient}
    canManageMcp={canManageMcp}
    canEnableMcp={canManageMcp && Boolean(browserDevice?.canDelegate)}
    onMcpStatus={() => requestMcpAccess('status')}
    onMcpEnable={(revision, permissions) => requestMcpAccess('enable', revision, permissions)}
    onMcpRotate={(revision) => requestMcpAccess('rotate', revision)}
    onMcpDisable={(revision) => requestMcpAccess('disable', revision)}
    canConnectBrowser={canConnectBrowser(browserDevice, currentBrowserView)}
    onCreateBrowserInvitation={() => createBrowserInvitation(new URL(window.location.origin), currentBrowserView)}
    onBrowserInvitationStatus={browserInvitationStatus}
    onCancelBrowserInvitation={cancelBrowserInvitation}
    onBrowserConnected={async () => { await devicesQuery.refetch(); }}
    composioSetup={composioSetupValue ?? null}
    onPutComposioSetup={saveComposioSetup}
    onDeleteComposioSetup={removeComposioSetup}
    browserRelay={browserRelayValue ?? null}
    onSetupBrowserRelay={() => runBrowserRelay('setup')}
    onStartBrowserRelay={() => runBrowserRelay('start')}
    onUnpairBrowserRelay={async pairingId => { setBrowserRelayValue(await unpairAccountBrowser(pairingId)); }}
    onTestBrowserRelay={() => runBrowserRelay('test')}
    projects={(productProjectsValue ?? []).map((project) => ({ id: project.id, name: project.name }))}
    onBack={() => navigateProduct(optionalQueryParameter('project') ? 'agent' : 'projects', 'replace')}
    onComplete={completeOnboarding}
    saving={ensureStarterProject.state === 'pending' || updateSettings.state === 'pending' || reserveHandle.state === 'pending' || setRuntimeSetting.state === 'pending' || updateMachineNotes.state === 'pending' || createSandboxMachine.state === 'pending' || sleepMachine.state === 'pending' || resumeMachine.state === 'pending' || destroyMachine.state === 'pending' || revertDeployment.state === 'pending'}
    error={settingsError}
  /></>;
  if (!draft.onboardingComplete || forceOnboarding) return page('onboarding');
  return page('settings');
}

type DeviceGateState =
  | { status: 'loading' }
  | { status: 'enrolling' }
  | { status: 'enrolled' }
  | { status: 'unenrolled'; error: string | null };

/**
 * Nothing renders until this browser holds an enrolled device: `#enroll=`
 * redeems an invite, a stored device passes straight through, and a
 * revoked or expired device drops back to this screen.
 */
function DeviceGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<DeviceGateState>({ status: 'loading' });
  const initialized = useRef(false);
  const enrolling = useRef(false);
  const redeem = async (token: string): Promise<void> => {
    if (enrolling.current) return;
    enrolling.current = true;
    const url = new URL(window.location.href);
    const fragment = new URLSearchParams(url.hash.slice(1));
    if (fragment.has('enroll')) {
      fragment.delete('enroll');
      url.hash = fragment.toString();
    }
    url.searchParams.delete('enroll');
    window.history.replaceState(null, '', url);
    setState({ status: 'enrolling' });
    try {
      const pageUrl = new URL(window.location.href);
      const checkedToken = enrollmentTokenForLocation(token, pageUrl);
      setCurrentDevice(await enrollDevice(checkedToken, accountHandleFromUrl(pageUrl) ? pageUrl.origin : undefined));
      setState({ status: 'enrolled' });
    } catch (error) {
      setState({ status: 'unenrolled', error: error instanceof Error ? error.message : 'Enrollment failed' });
    } finally {
      enrolling.current = false;
    }
  };
  const recover = async (handle: string, key: string): Promise<void> => {
    if (enrolling.current) return;
    enrolling.current = true;
    setState({ status: 'enrolling' });
    try {
      const recovery = recoverAccountBrowser(handle, key, new URL(window.location.href));
      key = '';
      setCurrentDevice(await recovery);
      setState({ status: 'enrolled' });
    } catch (error) {
      setState({ status: 'unenrolled', error: error instanceof Error ? error.message : 'Account recovery failed' });
    } finally {
      key = '';
      enrolling.current = false;
    }
  };
  useEffect(() => {
    if (!initialized.current) {
      initialized.current = true;
      const url = new URL(window.location.href);
      const token = new URLSearchParams(url.hash.slice(1)).get('enroll') ?? url.searchParams.get('enroll');
      if (token) void redeem(token);
      else void currentDevice().then((device) => setState(device ? { status: 'enrolled' } : { status: 'unenrolled', error: null }));
    }
    const onRejected = (event: Event): void => {
      const code = event instanceof CustomEvent ? String(event.detail?.code ?? '') : '';
      setState({ status: 'unenrolled', error: code === 'SIGNED_OUT' ? 'You signed out of this browser.' : 'This browser’s access ended. Use your recovery key or a new enrollment link to reconnect.' });
    };
    window.addEventListener(DEVICE_REJECTED_EVENT, onRejected);
    return () => window.removeEventListener(DEVICE_REJECTED_EVENT, onRejected);
  }, []);
  if (state.status === 'enrolled') return <>{children}</>;
  if (state.status === 'loading' || state.status === 'enrolling') {
    return <main className="flex h-dvh items-center justify-center bg-background"><EmptyState icon={<ThinkingIndicator />} title={state.status === 'enrolling' ? 'Connecting this browser…' : 'Checking this browser…'} description="This browser gets its own revocable key. No local machine is required." /></main>;
  }
  return <AccountConnectPage error={state.error} onRecover={(handle, key) => { void recover(handle, key); }} onEnroll={value => { void redeem(value); }} />;
}

type ConfigurationView = 'skills' | 'plugins' | 'secrets' | 'crons';
type ConfigurationProject = { id: string; name: string; lifecycle: string };

function isConfigurationView(view: ProductRoute): view is ConfigurationView {
  return view === 'skills' || view === 'plugins' || view === 'secrets' || view === 'crons';
}

async function configurationResult<T>(request: Promise<{ status: 'ok'; value: T } | { status: 'error'; error: Error }>): Promise<T> {
  const result = await request;
  if (result.status === 'error') throw result.error;
  return result.value;
}

const accountSecretsApi: Omit<ProjectSecretsProps, 'projects'> = {
  listAccount: () => configurationResult(rpcClient.secrets.account.list({})),
  putAccount: (name, value) => configurationResult(rpcClient.secrets.account.put({ name, value })),
  deleteAccount: async (name) => { await configurationResult(rpcClient.secrets.account.delete({ name })); },
  grant: (name, projectId, projectSpaceEnabled, workspacesEnabled) => configurationResult(rpcClient.secrets.account.grant({ name, projectId, projectSpaceEnabled, workspacesEnabled })),
  revoke: (name, projectId) => configurationResult(rpcClient.secrets.account.revoke({ name, projectId })),
  list: (projectId) => configurationResult(rpcClient.secrets.list({ projectId })),
  put: (projectId, name, value) => configurationResult(rpcClient.secrets.put({ projectId, name, value })),
  delete: async (projectId, name) => { await configurationResult(rpcClient.secrets.delete({ projectId, name })); },
  listValues: (projectId) => configurationResult(rpcClient.configuration.values.get(projectId ? { projectId } : {})),
  putValue: async (target, name, value) => { await configurationResult(rpcClient.configuration.values.put({ ...target, name, value })); },
  deleteValue: async (target, name) => { await configurationResult(rpcClient.configuration.values.delete({ ...target, name })); },
};

function useAccountWorkActions(account: NonNullable<ContextType<typeof AccountDirectoryContext>>, confirmLfs: ConfirmLfsTransition): AccountWorkActions {
  const openingSpaces = useRef(new Map<string, Promise<void>>());
  const uncertainOpenings = useRef(new Set<string>());

  const inspectTarget = async (spaceId: string): Promise<InspectorView> => {
    const project = account.projects.find((candidate) => candidate.id === spaceId || account.directory[candidate.id]?.workspaces.some((workspace) => workspace.id === spaceId));
    if (!project) throw new Error('This workspace is no longer in the account directory. Refresh before retrying.');
    return configurationResult(rpcClient.inspector.view({ projectId: project.id, workspaceId: spaceId === project.id ? null : spaceId }));
  };
  const confirmLeaving = async (canonical: InspectorView): Promise<boolean> => {
    const identity = RuntimeIdentitySchema.parse({ projectId: canonical.workspace.projectId, workspaceId: canonical.workspace.id });
    const snapshot = await configurationResult(rpcClient.runtime.snapshot(identity));
    return confirmLfs(runtimeLfsHeldBack(snapshot), () => selectInspection(identity.projectId, canonical.workspace.id === canonical.workspace.projectId ? null : identity.workspaceId));
  };
  const mutate = async <T,>(request: Promise<{ status: 'ok'; value: T } | { status: 'error'; error: Error }>): Promise<T> => {
    try { return await configurationResult(request); }
    finally { account.refresh(); }
  };
  const claimSpace = (spaceId: string, destinationMachineId: string | null): Promise<void> => {
    const existing = openingSpaces.current.get(spaceId);
    if (existing) return existing;
    const operation = (async () => {
      const canonical = await inspectTarget(spaceId);
      if (canonical.placement?.state === 'opening' || canonical.placement?.state === 'closing') {
        throw new Error(`This workspace is ${canonical.placement.state}. Refresh its state before retrying.`);
      }
      if (uncertainOpenings.current.has(spaceId) && canonical.placement?.state === 'open') {
        throw new Error('The previous open request succeeded. No duplicate request was sent; open the workspace to inspect it.');
      }
      const [machines, settings] = await Promise.all([
        configurationResult(rpcClient.machines({})),
        configurationResult(rpcClient.settings.get({})),
      ]);
      const available = machines.filter((machine) => machine.state === 'online' && machine.desiredState === 'online' && machine.rpcEndpoint);
      const destination = destinationMachineId
        ? available.find((machine) => machine.id === destinationMachineId)
        : available.find((machine) => machine.id === settings.defaults.machineId) ?? available[0];
      if (!destination?.rpcEndpoint) throw new Error('No selected online machine is available. Choose an online machine in Account settings.');
      const client = createGitSpaceBrowserClient({ url: destination.rpcEndpoint });
      const input = { spaceId, expectedGeneration: canonical.placement?.generation ?? 0 };
      try {
        await configurationResult(canonical.workspace.archivedAt ? client.workspace.restore(input) : client.space.reopen(input));
        uncertainOpenings.current.delete(spaceId);
      } catch (cause) {
        uncertainOpenings.current.add(spaceId);
        await Promise.allSettled([inspectTarget(spaceId)]);
        throw new Error(spaceOpeningError(cause));
      }
    })().finally(() => { openingSpaces.current.delete(spaceId); account.refresh(); });
    openingSpaces.current.set(spaceId, operation);
    return operation;
  };
  const actions = {
    onCreateProject: async (input) => {
      const result = await mutate(rpcClient.project.create(input));
      selectInspection(result.project.id, null);
    },
    onCreateWorkspace: async (input) => {
      const result = await mutate(rpcClient.workspace.create({ ...input, dependsOn: [...input.dependsOn] }));
      selectInspection(input.projectId, result.workspace.id);
    },
    onCloseSpace: async (spaceId) => {
      const canonical = await inspectTarget(spaceId);
      if (!canonical.placement || canonical.placement.state !== 'open') {
        account.refresh();
        throw new Error('This workspace is no longer open. Its account state has been refreshed.');
      }
      if (!await confirmLeaving(canonical)) return;
      await mutate(rpcClient.space.close({ spaceId, expectedGeneration: canonical.placement.generation }));
    },
    onReopenSpace: (spaceId) => claimSpace(spaceId, null),
    onClaimWorkspace: claimSpace,
    onArchiveWorkspace: async (spaceId) => {
      const canonical = await inspectTarget(spaceId);
      if (canonical.placement?.state === 'open' && !await confirmLeaving(canonical)) return;
      await mutate(rpcClient.workspace.archive({
        projectId: canonical.workspace.projectId, spaceId,
        expectedRevision: canonical.workspace.revision, expectedGeneration: canonical.placement?.generation ?? null,
      }));
    },
    onArchiveProject: async (projectId, expectedRevision) => { await mutate(rpcClient.project.archive({ projectId, expectedRevision })); },
    onRestoreProject: async (projectId, expectedRevision) => { await mutate(rpcClient.project.restore({ projectId, expectedRevision })); },
    onSetProjectBaseBranch: async (projectId, expectedRevision, baseBranch) => { await mutate(rpcClient.project.setBaseBranch({ projectId, expectedRevision, baseBranch })); },
    onDeleteProject: async (projectId, expectedRevision) => { await mutate(rpcClient.project.delete({ projectId, expectedRevision })); },
    onDeleteWorkspace: async (workspaceId) => {
      const canonical = await inspectTarget(workspaceId);
      if (!await confirmLeaving(canonical)) return;
      await mutate(rpcClient.workspace.delete({ workspaceId }));
    },
    onSetWorkspaceRelations: async (workspaceId, relations) => {
      await mutate(rpcClient.workspace.setRelations({ workspaceId, dependsOn: [...relations.dependsOn], relatedTo: [...relations.relatedTo], stackedOn: relations.stackedOn }));
    },
  } satisfies ComponentProps<typeof AccountWorkPages>['actions'];
  return actions;
}

function AccountWork({ view }: { view: 'kanban' | 'projects' | 'inbox' }) {
  const account = useContext(AccountDirectoryContext);
  const actions = useContext(AccountWorkActionsContext);
  const projectSettings = useContext(ProjectSettingsContext);
  if (!account || !actions || !projectSettings) throw new Error('Account work pages require the account directory, actions, and project settings');
  return <AccountWorkPages view={view} projects={account.projects} directory={account.directory} loading={account.loading} onRefresh={account.refresh} onOpenWorkspace={selectInspection} onOpenProject={(projectId) => selectInspection(projectId, null)} actions={actions} settingsProjectId={projectSettings.projectId} onSettingsProjectChange={projectSettings.onChange} />;
}

function AccountConfiguration({ view }: { view: ConfigurationView }) {
  const projects = useAccountProjects();
  const read = useRetainedRead(projects, 'projects');
  const values = read.value ?? [];
  return <>
    {read.initialLoading ? <p role="status" className="px-8 pt-4 text-caption text-muted-foreground">Loading projects for assignments…</p> : null}
    {read.error ? <p role="alert" className="px-8 pt-4 text-caption text-destructive">Project assignments: {rpcErrorMessage(read.error, 'project.list')}<Button variant="ghost" onClick={() => void projects.refetch()}>Retry projects</Button></p> : null}
    {view === 'skills' ? <AccountSkills projects={values} />
      : view === 'plugins' ? <AccountPlugins projects={values} />
        : view === 'secrets' ? <ProjectSecretsPage {...accountSecretsApi} projects={values} />
          : <AccountCrons projects={values} projectsLoading={read.initialLoading} />}
  </>;
}

function AccountSkills({ projects }: { projects: readonly ConfigurationProject[] }) {
  const skills = useResultQuery(rpcClient.skills.list, {});
  const read = useRetainedRead(skills, 'skills');
  return <><div className="flex justify-end px-8 pt-4"><Button variant="ghost" onClick={() => void skills.refetch()} disabled={read.initialLoading || read.refreshing}>Refresh skills</Button></div><SkillsPage projects={projects} skills={read.value ?? []} loading={read.initialLoading} error={read.error ? rpcErrorMessage(read.error, 'skills.list') : null} update={(skill, changes) => configurationResult(rpcClient.skills.update({ update: { id: skill.id, expectedRevision: skill.revision, ...changes } }))} /></>;
}

function AccountPlugins({ projects }: { projects: readonly ConfigurationProject[] }) {
  const connections = useResultQuery(rpcClient.mcp.connections.list, {});
  const catalog = useResultQuery(rpcClient.mcp.composio.catalog, {});
  const machines = useAccountMachines();
  const connectionRead = useRetainedRead(connections, 'connections');
  const catalogRead = useRetainedRead(catalog, 'composio-catalog');
  const machineValues = useRetainedQueryValue(machines, 'machines');
  const [grants, setGrants] = useState<ProjectMcpGrantRpcView[]>([]);
  const [grantError, setGrantError] = useState<string | null>(null);
  const [grantsLoading, setGrantsLoading] = useState(true);
  const [refreshToken, setRefreshToken] = useState(0);
  const projectKey = projects.map((project) => project.id).join('|');
  useEffect(() => {
    let cancelled = false;
    setGrantError(null);
    setGrantsLoading(true);
    void Promise.all(projects.map(async (project) => configurationResult(rpcClient.mcp.grants.list({ projectId: project.id })))).then((result) => {
      if (!cancelled) setGrants(result.flat());
    }).catch((error: unknown) => { if (!cancelled) { if (invalidatesRead(error)) setGrants([]); setGrantError(rpcErrorMessage(error, 'mcp.grants.list')); } }).finally(() => { if (!cancelled) setGrantsLoading(false); });
    return () => { cancelled = true; };
  }, [projectKey, refreshToken]);
  const refresh = async (): Promise<void> => {
    await Promise.all([connections.refetch(), catalog.refetch()]);
    setRefreshToken((current) => current + 1);
  };
  const errors = [connections.state === 'failure' ? rpcErrorMessage(connections.error, 'mcp.connections.list') : null, catalog.state === 'failure' ? rpcErrorMessage(catalog.error, 'mcp.composio.catalog') : null, grantError, machines.state === 'failure' ? `Machine directory: ${rpcErrorMessage(machines.error, 'machine.list')}` : null].filter(Boolean).join(' · ');
  return <PluginsPage
    projects={projects}
    connections={connectionRead.value ?? []}
    grants={grants.filter((grant) => projects.some((project) => project.id === grant.projectId))}
    machines={(machineValues ?? []).map((machine) => ({ id: machine.id, label: machine.label, state: machine.desiredState === 'online' && machine.rpcEndpoint ? machine.state : 'offline' }))}
    composioCatalog={catalogRead.value ?? { configured: false, toolkits: [] }}
    loading={connectionRead.initialLoading}
    catalogLoading={catalogRead.initialLoading}
    catalogError={catalog.state === 'failure' ? rpcErrorMessage(catalog.error, 'mcp.composio.catalog') : undefined}
    assignmentsLoading={grantsLoading || grantError !== null}
    error={errors || undefined}
    onCreate={async (connection) => { await configurationResult(rpcClient.mcp.connections.create({ connection })); await refresh(); }}
    onUpdate={async (connectionId, expectedRevision, connection) => { await configurationResult(rpcClient.mcp.connections.update({ connectionId, expectedRevision, connection })); await refresh(); }}
    onDelete={async (connectionId, expectedRevision) => { await configurationResult(rpcClient.mcp.connections.delete({ connectionId, expectedRevision })); await refresh(); }}
    onSetGrant={async (projectId, connectionId, projectSpaceEnabled, workspacesEnabled, expectedRevision) => {
      const updated = await configurationResult(rpcClient.mcp.grants.put({ projectId, connectionId, projectSpaceEnabled, workspacesEnabled, enabled: projectSpaceEnabled || workspacesEnabled, expectedRevision }));
      setGrants((current) => [...current.filter((grant) => grant.projectId !== projectId || grant.connectionId !== connectionId), updated]);
    }}
    onRevokeGrant={async (projectId, connectionId, expectedRevision) => {
      await configurationResult(rpcClient.mcp.grants.delete({ projectId, connectionId, expectedRevision }));
      setGrants((current) => current.filter((grant) => grant.projectId !== projectId || grant.connectionId !== connectionId));
    }}
    onAuthorizeComposio={async (toolkit, label) => {
      const result = await configurationResult(rpcClient.mcp.composio.authorize({ toolkit, label }));
      await connections.refetch();
      return result.redirectUrl;
    }}
    onRefreshComposio={async (connectionId) => { await configurationResult(rpcClient.mcp.composio.refresh({ connectionId })); await refresh(); }}
    onLoadComposioTools={(connectionId) => configurationResult(rpcClient.mcp.composio.tools({ connectionId }))}
    onUpdateComposioTools={async (connectionId, expectedRevision, toolPolicy) => { await configurationResult(rpcClient.mcp.composio.updateTools({ connectionId, expectedRevision, toolPolicy })); await refresh(); }}
    onDisconnectComposio={async (connectionId, expectedRevision) => { await configurationResult(rpcClient.mcp.composio.disconnect({ connectionId, expectedRevision })); await refresh(); }}
    onRefresh={refresh}
    onDiscover={(projectId) => configurationResult(rpcClient.mcp.discover({ projectId, requestId: crypto.randomUUID() }))}
  />;
}

function AccountCrons({ projects, projectsLoading }: { projects: readonly ConfigurationProject[]; projectsLoading: boolean }) {
  const [crons, setCrons] = useState<ProjectCronView[]>([]);
  const [targets, setTargets] = useState<ProjectCronTargetOption[]>([]);
  const [holders, setHolders] = useState<Record<string, string>>({});
  const savedCrons = useRef(new Map<string, readonly ProjectCronView[]>());
  const savedContexts = useRef(new Map<string, InspectorView>());
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const projectKey = projects.map((project) => `${project.id}:${project.lifecycle}`).join('|');
  useEffect(() => {
    if (projectsLoading) return;
    let cancelled = false;
    setLoading(true);
    for (const id of savedCrons.current.keys()) if (!projects.some((project) => project.id === id)) savedCrons.current.delete(id);
    for (const id of savedContexts.current.keys()) if (!projects.some((project) => project.id === id && project.lifecycle !== 'cloud-only')) savedContexts.current.delete(id);
    const load = async (): Promise<void> => {
      const failures: string[] = [];
      const lists = await Promise.all(projects.map(async (project) => {
        try {
          const value = await configurationResult(rpcClient.crons.list({ projectId: project.id }));
          if (!cancelled) savedCrons.current.set(project.id, value);
          return value;
        } catch (cause) {
          failures.push(rpcErrorMessage(cause, `${project.name} schedules`));
          if (!cancelled && invalidatesRead(cause)) savedCrons.current.delete(project.id);
          return savedCrons.current.get(project.id) ?? [];
        }
      }));
      if (cancelled) return;
      setCrons(lists.flat());
      setLoaded(true);
      setLoading(false);
      setError(failures.join(' · ') || null);
      const contexts = await Promise.all(projects.filter((project) => project.lifecycle !== 'cloud-only').map(async (project) => {
        try {
          const value = await configurationResult(rpcClient.inspector.view({ projectId: project.id, workspaceId: null }));
          if (!cancelled) savedContexts.current.set(project.id, value);
          return value;
        } catch (cause) {
          failures.push(rpcErrorMessage(cause, `${project.name} workspace targets`));
          if (!cancelled && invalidatesRead(cause)) savedContexts.current.delete(project.id);
          return savedContexts.current.get(project.id) ?? null;
        }
      }));
      if (cancelled) return;
      setTargets(contexts.flatMap((context) => context ? context.workspaces.filter((workspace) => workspace.kind !== 'base' && !workspace.archivedAt).map((workspace) => ({ target: { scope: 'workspace' as const, projectId: workspace.projectId, spaceId: workspace.id }, label: `Workspace agent · ${workspace.name}`, description: workspace.branch })) : []));
      setHolders(Object.fromEntries(contexts.flatMap((context) => context?.placement?.machineId ? [[context.identity.spaceId, context.placement.machineId]] : [])));
      setError(failures.join(' · ') || null);
    };
    void load();
    return () => { cancelled = true; };
  }, [projectKey, projectsLoading, refreshToken]);
  return <><div className="flex justify-end px-8 pt-4"><Button variant="ghost" onClick={() => setRefreshToken((current) => current + 1)} disabled={loading}>Refresh schedules</Button></div><ProjectCronsPage
    projects={projects}
    crons={crons.filter((cron) => projects.some((project) => project.id === cron.projectId))}
    targetOptions={targets.filter((option) => projects.some((project) => project.id === option.target.projectId))}
    holders={holders}
    loading={projectsLoading || (loading && !loaded)}
    loadError={error}
    onCreateCron={(draft) => configurationResult(rpcClient.crons.create({ projectId: draft.target.projectId, draft }))}
    onUpdateCron={(projectId, cronId, expectedRevision, draft) => configurationResult(rpcClient.crons.update({ projectId, cronId, expectedRevision, draft }))}
    onDeleteCron={async (projectId, cronId, expectedRevision) => { await configurationResult(rpcClient.crons.delete({ projectId, cronId, expectedRevision })); }}
    onRunNow={(projectId, cronId) => configurationResult(rpcClient.crons.runNow({ projectId, cronId }))}
    onListRuns={(projectId, cronId) => configurationResult(rpcClient.crons.history({ projectId, cronId }))}
    onCancelRun={(projectId, runId, confirmStopWorkspaceAgent) => configurationResult(rpcClient.crons.cancelRun({ projectId, runId, confirmStopWorkspaceAgent }))}
  /></>;
}

function AccountProductRoute() {
  const location = useProductLocation();
  const route = productRouteFromLocation(location);
  useEffect(() => {
    if (isGlobalView(route) && (location.searchParams.has('project') || location.searchParams.has('workspace'))) {
      navigateProductUrl(setProductRoute(new URL(location), route), 'replace');
    }
  }, [location.href, route]);
  if (isConfigurationView(route)) return <AccountConfiguration view={route} />;
  if (route === 'kanban' || route === 'projects' || route === 'inbox') return <AccountWork view={route} />;
  return <GitSpaceProduct />;
}


export function LiveApp() {
  if (window.location.pathname === '/service-access') return <DeviceGate><ServiceAccessApproval /></DeviceGate>;
  return <DeviceGate><ResultRpcProvider client={rpcClient}><SynchronizationProvider><InferenceProvider><AccountFrame><AccountProductRoute /></AccountFrame></InferenceProvider></SynchronizationProvider></ResultRpcProvider></DeviceGate>;
}
