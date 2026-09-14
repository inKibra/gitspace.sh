import { executionAgentId, transcriptRowsToTurns, type ExecutionBlock, type SideAgentBlock, type TransportBlock, type TurnBlock } from '@gitspace/blocks';
import type { DeploymentStatusView, InspectorBootstrapView, LaunchProgressView, OmpSettingValue, ProviderLoginEvent, ReleaseTarget, RepositoryDiffView, RepositoryFileView, RepositoryMode, UserSettings } from '@gitspace/protocol';
import { executionHash, projectEnvironmentState, lifecycleSummary, lifecycleExecutionOutcome, isLifecycleRunActive, latestLifecycleRun, latestExecutionRun, type EnvironmentBundle as ProtocolEnvironmentBundle } from '@gitspace/protocol-environment';
import { currentAgentFailure } from '@gitspace/protocol-agent';
import type { ProjectMcpGrantRpcView } from '@gitspace/protocol/mcp-contract';
import type { ProjectCronView } from '@gitspace/protocol/cron-contract';
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, InputField, InputGroup, ScrollArea, Select, SelectContent, SelectItem, SelectTrigger, SidebarInset, SidebarInsetTopbar, SidebarProvider, ThinkingIndicator, Tooltip, useShape } from '@gitspace/ui';
import { LayoutRight, Terminal } from '@untitledui/icons';
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ComponentProps, type ContextType, type ReactNode } from 'react';
import { isTaggedError } from 'result-rpc';
import { ResultRpcProvider, useResultMutation, useResultQuery, useResultRuntime } from 'result-rpc/react';
import { CreateWorkspaceDialog, EmptyState, GitSpaceShell, PageCanvas, PageHeader, TranscriptHistoryNotice, type GitSpaceShellProps, type ProviderAuthView, type SpaceHolderView } from './GitSpaceShell.js';
import { AccountWorkPages } from './AccountWorkPages.js';
import { LaunchSheet, LaunchedBanner, LAUNCHED_STORAGE_KEY, readLaunchedMark, type LaunchedMark } from './LaunchSheet.js';
import { createGitSpaceBrowserClient, homeRpcUrl, routedTransport, rpcClient } from './rpc-client.js';
import { currentDevice, DEVICE_REJECTED_EVENT, deviceRejected, setCurrentDevice } from './device-session.js';
import { createApiClient, enrollDevice, type ApiClientDraft, type BrowserDevice } from './device.js';
import { applyAppearance } from './appearance.js';
import type { ProviderLoginFlow, ProvidersSectionProps } from './ProvidersSection.js';
import { SettingsPage } from './SettingsPage.js';
import { EnvironmentView } from './environment/EnvironmentView.js';
import { LifecycleLogDialog } from './environment/LifecycleLogDialog.js';
import type { EnvironmentViewModel, LifecyclePhase, LifecycleRun, TrustState } from './environment/types.js';
import { Inspector } from './inspector/index.js';
import { appendLaunchProgress, launchTrackFrom, RELEASE_TARGETS, shortSha, type LaunchTrack } from './release.js';
import { ACCOUNT_DIRECTORY_CHANGED, PRODUCT_ROUTE_LABELS, isGlobalView, navigateProductUrl, productRouteFromLocation, setProductRoute, type AppView, type ProductRoute } from './routes.js';
import { AccountSidebarContext, AppSidebar, type AppSidebarProps, type SidebarProject } from './AppSidebar.js';
import { VirtualTranscript } from './VirtualTranscript.js';
import { accountHandleFromUrl, browserInvitationStatus, canConnectBrowser, cancelBrowserInvitation, createBrowserInvitation, enrollmentTokenForLocation, recoverAccountBrowser } from './browser-enrollment.js';
import { AccountConnectPage } from './AccountConnectPage.js';
import { SkillsPage } from './SkillsPage.js';
import { PluginsPage } from './PluginsPage.js';
import { ProjectSecretsPage, type ProjectSecretsProps } from './ProjectSecretsPage.js';
import { ProjectCronsPage, type ProjectCronTargetOption } from './ProjectCronsPage.js';
import { useTranscriptHistory, type TranscriptHistorySource } from './useTranscriptHistory.js';
import { AccountDirectoryContext, useAccountDirectory } from './useAccountDirectory.js';
import { invalidatesRead, useRetainedRead, useRetainedQueryValue } from './useRetainedRead.js';
import { useLiveSessionControls } from './useLiveSessionControls.js';
import { ResourceNavigation, type ResourceRequest } from './ResourceNavigation.js';
import { loadInspectorResource } from './resource-content.js';
import { SynchronizationProvider, useAccountSettings, useAccountGitIdentity, useAccountOmpConfiguration, useAccountMachines, useAccountProjects, useEnvironmentSynchronization, useEventRefresh, useProjectSynchronization, useRuntimeSynchronization, useSpaceSynchronization, useSynchronizationOwner, useSynchronizedEvents } from './SynchronizationProvider.js';
import type { SynchronizationOwner } from './synchronization.js';
import { recordActionIncident } from './incident-outbox.js';

const INSPECTOR_EVENT_ENTITIES: Readonly<Record<string, true>> = {
  goal: true,
  workflow: true,
  rubric: true,
  journal: true,
  'change-guide': true,
  'review-thread': true,
};

interface MachineHealth { generation: string | null; machineRelease: string | null; ompRelease: string | null }

/** `GET /health` beside `/rpc`: unauthenticated, so it answers even while the device session is mid-swap. */
async function fetchMachineHealth(): Promise<MachineHealth | null> {
  try {
    const healthUrl = new URL(homeRpcUrl, window.location.origin);
    healthUrl.pathname = healthUrl.pathname.replace(/\/rpc$/u, '/health');
    const response = await fetch(healthUrl, { cache: 'no-store' });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    if (body === null || typeof body !== 'object') return null;
    return {
      generation: 'generation' in body && typeof body.generation === 'string' ? body.generation : null,
      machineRelease: 'machineRelease' in body && typeof body.machineRelease === 'string' ? body.machineRelease : null,
      ompRelease: 'ompRelease' in body && typeof body.ompRelease === 'string' ? body.ompRelease : null,
    };
  } catch {
    return null;
  }
}

const HEALTH_GATE_TIMEOUT_MS = 90_000;
/**
 * `code-version` means the frontend generation is already swapped; machine
 * and OMP targets may still be converging through the stable host.
 */
async function awaitMachineSwap(owner: SynchronizationOwner, projectId: string, target: 'machine' | 'omp' | null, sha: string | null): Promise<boolean> {
  const result = Promise.withResolvers<boolean>();
  const channel = owner.channel(`runtime:${projectId}`, (after, signal) => rpcClient.events({ projectId, after }, { signal }));
  let stopped = false;
  let open = false;
  let unsubscribe: (() => void) | undefined;
  const finish = (served: boolean) => { if (stopped) return; stopped = true; clearTimeout(deadline); unsubscribe?.(); result.resolve(served); };
  const deadline = setTimeout(() => finish(false), HEALTH_GATE_TIMEOUT_MS);
  const inspect = () => {
    const connected = channel.snapshot().connection === 'open';
    if (!connected) { open = false; return; }
    if (open || stopped) return;
    open = true;
    // One health read per actual stream reconnection, not a state polling loop.
    void fetchMachineHealth().then((health) => {
      const running = target === 'omp' ? health?.ompRelease : health?.machineRelease;
      if (health && (target === null || sha === null || running === sha)) finish(true);
    });
  };
  unsubscribe = channel.subscribe(inspect);
  inspect();
  return result.promise;
}

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
    return `The selected machine did not return a usable response. The workspace may still be opening, so its remote outcome is unknown. Check cloud state before another attempt. Details: ${error.message}`;
  }
  return error.message;
}

function isReleaseTarget(value: unknown): value is ReleaseTarget {
  return typeof value === 'string' && RELEASE_TARGETS.includes(value as ReleaseTarget);
}

function isLaunchStatus(value: unknown): value is LaunchProgressView['status'] {
  return value === 'running' || value === 'succeeded' || value === 'failed';
}

function optionalQueryParameter(name: string): string | null {
  if (typeof window === 'undefined') return null;
  return new URL(window.location.href).searchParams.get(name);
}

const CONFIGURE_ENVIRONMENT_PROMPT = 'Use the workspace-lifecycle skill to help me configure this repository. Inspect the repository and our shared environment ledger, then discuss the local preparation and cloud resources this project needs. Propose the five lifecycle phases and profiles. Do not edit files or run lifecycle scripts until I review the plan; approval to edit is not approval to execute.';

function LiveEnvironmentStatus({ spaceId, onInspect, onConfigure }: { spaceId: string; onInspect(): void; onConfigure?: () => Promise<void> }) {
  const query = useResultQuery(rpcClient.environment.get, { spaceId });
  const retained = useRetainedRead(query, spaceId);
  const synchronized = useEnvironmentSynchronization(spaceId);
  const read = { ...retained, value: retained.value && synchronized.value ? { ...retained.value, ...projectEnvironmentState(synchronized.value) } : retained.value };
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  if (!read.value) return read.error ? <span role="alert" className="text-caption text-destructive">Environment: {read.error.message}</span> : null;
  const state = read.value.lifecycle;
  const configured = state.bundleJson !== null || read.value.executions.length > 0;
  const summary = lifecycleSummary(state);
  return <span className="flex min-w-0 items-center gap-1">
    <Button variant="ghost" size="compact" className={`min-h-10 max-w-48 truncate ${summary.attention ? 'text-destructive' : 'text-muted-foreground'}`} onClick={onInspect}>{summary.label}</Button>
    {!configured && onConfigure ? <Button variant="ghost" size="compact" className="min-h-10" loading={pending} onClick={() => { setPending(true); setError(null); void onConfigure().catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause))).finally(() => setPending(false)); }}>Configure with agent</Button> : null}
    {read.error ? <span role="alert" className="max-w-64 truncate text-caption text-destructive" title={read.error.message}>Environment refresh: {read.error.message}</span> : null}
    {error ? <span role="alert" className="max-w-64 truncate text-caption text-destructive" title={error}>{error}</span> : null}
  </span>;
}

function LiveEnvironment({ projectName, workspaceName, spaceId, workspace, generation, machineId, runtimeAvailable, onAskAgent }: { projectName: string; workspaceName: string; spaceId: string; workspace: boolean; generation: number; machineId?: string; runtimeAvailable: boolean; onAskAgent?: (text: string) => Promise<void> }) {
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
  if (!read.value) return read.error ? <div className="flex flex-col gap-2 p-4"><p role="alert" className="text-caption text-destructive">{read.error.message}</p><Button variant="ghost" size="compact" onClick={() => void query.refetch()}>Retry environment</Button></div> : <p className="p-4 text-caption text-muted-foreground" role="status">Loading environment…</p>;
  const runners = (machineValues ?? []).filter((candidate) => candidate.state === 'online' && candidate.desiredState === 'online' && candidate.rpcEndpoint);
  const runner = runners.find((candidate) => candidate.id === runnerId) ?? runners[0];
  const remote = read.value;
  const bundle = JSON.parse(remote.bundleJson) as ProtocolEnvironmentBundle;
  const mutate = (operation: () => Promise<unknown>): void => {
    if (busy) return;
    setActionError(null); setBusy(true);
    void operation().then(() => query.refetch()).catch((error: unknown) => setActionError(error instanceof Error ? error.message : String(error))).finally(() => setBusy(false));
  };
  const saveBundle = (next: ProtocolEnvironmentBundle): void => mutate(async () => {
    const result = await rpcClient.environment.putBundle({ spaceId, bundleJson: JSON.stringify(next) });
    if (result.status === 'error') throw result.error;
  });
  const loadEvidence = (operation: () => Promise<void>): void => {
    if (readingEvidence) return;
    setReadingEvidence(true); setActionError(null);
    void operation().catch((error: unknown) => setActionError(error instanceof Error ? error.message : String(error))).finally(() => setReadingEvidence(false));
  };
  const openExecution = (targetId: string, approve: boolean): void => loadEvidence(async () => {
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
    {read.error ? <p role="alert" className="px-4 py-2 text-caption text-destructive">Environment refresh failed; showing the last accepted state. {read.error.message}<Button variant="ghost" size="compact" onClick={() => void query.refetch()}>Retry environment</Button></p> : null}
    {machines.state === 'failure' ? <p role="alert" className="px-4 py-2 text-caption text-destructive">Machine directory: {machines.error.message}</p> : null}
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
      onRevoke={(targetId) => { const execution = remote.executions.find((item) => item.id === targetId); if (execution?.approval) mutate(async () => { const result = await rpcClient.environment.revokeApproval({ spaceId, scope: execution.approval!, executionHash: execution.hash }); if (result.status === 'error') throw result.error; }); }}
      onGrantSecret={openSecrets}
      onInputChange={(name, value) => mutate(async () => { const result = await rpcClient.environment.putValue({ spaceId, scope: workspace ? 'workspace' : 'project', name, value }); if (result.status === 'error') throw result.error; })}
      onFixCheck={onAskAgent ? (checkId) => mutate(() => onAskAgent(`Inspect the failing environment check ${checkId} using space.environment.get and its durable run logs. Explain the cause and propose a fix; do not grant yourself execution approval.`)) : undefined}
      onUpdateCheck={(checkId, patch) => saveBundle({ ...bundle, checks: { ...bundle.checks, [checkId]: bundle.checks[checkId]?.kind === 'command' ? { kind: 'command', label: patch.label ?? bundle.checks[checkId].label, command: patch.probe ?? bundle.checks[checkId].command } : { ...bundle.checks[checkId]!, label: patch.label, requirement: patch.requirement } } })}
      onDeleteCheck={(checkId) => saveBundle({ ...bundle, checks: Object.fromEntries(Object.entries(bundle.checks).filter(([id]) => id !== checkId)), profiles: Object.fromEntries(Object.entries(bundle.profiles).map(([name, profile]) => [name, { ...profile, checks: profile.checks.filter((id) => id !== checkId) }])) })}
      onAddCheck={(check) => saveBundle({ ...updateProfile((profile) => ({ ...profile, checks: [...new Set([...profile.checks, check.id])] })), checks: { ...bundle.checks, [check.id]: check.source === 'catalog' ? { kind: 'built-in', check: check.id, label: check.label, requirement: check.requirement } : { kind: 'command', command: check.probe ?? '', label: check.label } } })}
      onAddValue={(name, defaultValue) => saveBundle({ ...updateProfile((profile) => ({ ...profile, values: [...new Set([...profile.values, name])] })), values: { ...bundle.values, [name]: defaultValue ? { default: defaultValue } : {} } })}
      onOpenSecrets={openSecrets}
      onOpenLifecycleFile={(scriptId) => openExecution(scriptId, false)}
      onRunChecks={() => mutate(async () => { const result = await rpcClient.environment.runChecks({ spaceId, runId: crypto.randomUUID() }); if (result.status === 'error') throw result.error; })}
      onOpenLifecycleOutput={(scriptId) => { const execution = remote.executions.find((item) => item.id === scriptId); const run = execution && latestExecutionRun(remote.lifecycle, execution.hash, { profile: remote.selectedProfile, machineId }); if (run && execution) openRunLog(run.id, { id: execution.id, label: execution.label }); }}
      onRunLifecycle={(phase: LifecyclePhase, options) => mutate(async () => {
        if (phase === 'cloud/destroy' && !options?.retire) throw new Error('Explicit human retirement confirmation is required.');
        const client = runtimeAvailable ? rpcClient : runner?.rpcEndpoint ? createGitSpaceBrowserClient({ url: runner.rpcEndpoint }) : null;
        if (!client) throw new Error('Choose an online cloud lifecycle runner.');
        if (!runtimeAvailable && phase !== 'cloud/destroy') throw new Error('Open the workspace before requesting setup or local preparation.');
        const result = await client.environment.runPhase({ spaceId, runId: crypto.randomUUID(), phase, rerun: options?.rerun ?? null });
        if (result.status === 'error') throw result.error;
      })}
    />
    {selectedLogRun && logSelection ? <LifecycleLogDialog key={`${spaceId}:${selectedLogRun.id}:${logSelection.script.id}`} run={selectedLogRun} script={logSelection.script} revision={remote.lifecycle.revision} loadPage={async (runId, offset, signal) => { const result = await rpcClient.environment.runLog({ spaceId, runId, offset }, { signal }); if (result.status === 'error') throw result.error; return result.value; }} onClose={() => setLogSelection(null)} /> : null}
    <Dialog open={evidence !== null} onOpenChange={(open) => { if (!open) setEvidence(null); }}>
      <DialogContent size="sm"><DialogHeader><DialogTitle>{evidence?.approvalHash ? 'Review exact execution content' : evidence?.title}</DialogTitle><DialogDescription>{evidence?.approvalHash ? 'Approves only this content hash. Editing a script requires a new approval; this does not run it or authorize retirement.' : 'Saved lifecycle evidence. Logs remain available after a checkout is removed.'}</DialogDescription></DialogHeader>
        {evidence?.approvalHash ? <code className="break-all font-mono text-caption text-muted-foreground">{evidence.approvalHash}</code> : null}
        <pre className="max-h-[55vh] overflow-auto whitespace-pre-wrap break-words font-mono text-caption">{evidence?.output || 'No output recorded.'}</pre>
        {actionError ? <p role="alert" className="text-caption text-destructive">{actionError}</p> : null}
        <DialogFooter><Button variant="secondary" onClick={() => setEvidence(null)}>Close</Button>{evidence?.approvalHash ? <Button variant="primary" disabled={busy} onClick={() => mutate(async () => { const result = await rpcClient.environment.approve({ spaceId, scope: workspace ? 'workspace' : 'project', executionHash: evidence.approvalHash! }); if (result.status === 'error') throw result.error; setEvidence(null); })}>Approve this content</Button> : null}</DialogFooter>
      </DialogContent>
    </Dialog>
  </div>;
}

function LiveInspector({
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
}) {
  const request = { spaceId, expectedGeneration: generation };
  const queryRuntime = useResultRuntime();
  const overview = useResultQuery(rpcClient.inspector.overview, request);
  const artifactCatalog = useResultQuery(rpcClient.inspector.artifacts.list, request);
  const [secondaryQueries, setSecondaryQueries] = useState({ repository: false, journal: false, threads: false, services: false });
  const repository = useResultQuery(rpcClient.inspector.repository.tree, { ...request, mode: 'current', path: null }, { enabled: runtimeAvailable && secondaryQueries.repository });
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
  const agents = useResultQuery(rpcClient.session.agents, { sessionId: sessionId ?? '' }, { enabled: runtimeAvailable && controlsAvailable && agentsRequested && sessionId !== null });
  const stackedOn = scope?.kind === 'workspace' ? scope.relations.stackedOn : null;
  const stackStatus = useResultQuery(rpcClient.workspace.stackStatus, { workspaceId: spaceId }, { enabled: runtimeAvailable && stackedOn !== null && scope?.kind === 'workspace' && !scope.closedAt });
  const readKey = JSON.stringify([projectId, spaceId, generation, scope?.possessedBy]);
  const overviewRead = useRetainedRead(overview, readKey);
  const artifactValue = useRetainedQueryValue(artifactCatalog, readKey);
  const repositoryValue = useRetainedQueryValue(repository, readKey);
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
    if (!runtimeAvailable || !controlsAvailable || !usageRequested || sessionId === null || usageInFlight.current) return;
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
      ? <div className="flex h-full flex-col items-center justify-center gap-2 p-6" aria-label="Workspace Inspector"><EmptyState title="Inspector could not load" description={overviewRead.error.message} action={<Button variant="ghost" type="button" onClick={() => void overview.refetch()}>Retry Inspector</Button>} /></div>
      : <div className="flex h-full flex-col items-center justify-center gap-2 p-6" aria-label="Workspace Inspector"><ThinkingIndicator /><span className="text-body text-muted-foreground">Loading Inspector authority state…</span></div>;
  }
  const overviewValue = overviewRead.value;

  const requestRepositoryFile = (path: string, mode: RepositoryMode): void => {
    setActionError(null);
    void rpcClient.inspector.repository.file({ ...request, path, mode }).then((result) => {
      if (result.status === 'error') throw result.error;
      setRepositoryFile(result.value);
      setRepositoryDiff(null);
    }).catch((error: unknown) => setActionError(error instanceof Error ? error.message : String(error)));
  };
  const requestRepositoryDiff = (path: string | null, mode: Exclude<RepositoryMode, 'current'>, baseRef?: string): void => {
    setActionError(null);
    void rpcClient.inspector.repository.diff({ ...request, path, mode, baseRef: baseRef ?? null }).then((result) => {
      if (result.status === 'error') throw result.error;
      setRepositoryDiff(result.value);
      setRepositoryFile(null);
    }).catch((error: unknown) => setActionError(error instanceof Error ? error.message : String(error)));
  };
  const refreshOverviewAndThreads = async (): Promise<void> => {
    await Promise.all([overview.refetch(), threads.refetch()]);
  };
  const queryError = overviewRead.error?.message
    ?? (journal.state === 'failure' ? journal.error.message : null)
    ?? (threads.state === 'failure' ? threads.error.message : null)
    ?? (services.state === 'failure' ? services.error.message : null)
    ?? (repository.state === 'failure' ? repository.error.message : null);
  const artifactReferences = artifactValue ? artifactValue.artifacts.map((artifact) => ({
    kind: 'artifact' as const, url: artifact.url, hash: artifact.hash, label: artifact.path,
    mediaType: artifact.mediaType,
    generation: artifactValue.scopes.find((scope) => scope.workspaceId === (artifact.workspaceId ?? projectId))?.generation ?? 0,
  })) : [];

  return <><div className="shrink-0">
    {overviewRead.refreshing ? <p role="status" className="sr-only">Refreshing Inspector…</p> : null}
    {actionError ? <p role="alert" className="px-3 py-1 text-caption text-destructive">{actionError}</p> : null}
  </div><Inspector
    overview={overviewValue}
    runtimeAvailable={runtimeAvailable}
    initialView={initialView}
    resourceRequest={resourceRequest}
    onRequestResource={(uri) => loadInspectorResource({
      readArtifact: (input) => rpcClient.inspector.artifacts.read(input),
      readResource: (input) => rpcClient.inspector.resources.read(input),
    }, { spaceId, projectId, generation, sessionId, runtimeAvailable }, uri)}
    scope={scope}
    workspaces={workspaces}
    environment={<LiveEnvironment projectName={scope?.projectName ?? projectId} workspaceName={scope?.name ?? spaceId} spaceId={spaceId} workspace={spaceId !== projectId} generation={generation} machineId={scope?.holder.kind === 'held' ? scope.holder.machineId : undefined} runtimeAvailable={runtimeAvailable} onAskAgent={onAskAgent} />}
    onSelectWorkspace={onSelectWorkspace}
    onSetRelations={onSetRelations}
    stackStatus={stackValue ?? null}
    repositoryEntries={repositoryValue ?? []}
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
    onLoadRepositoryDiff={async (path, mode, baseRef) => {
      const result = await rpcClient.inspector.repository.diff({ ...request, path, mode, baseRef: baseRef ?? null });
      if (result.status === 'error') throw result.error;
      return result.value;
    }}
    threads={threadsValue ?? []}
    services={servicesValue ?? []}
    subagents={subagents}
    usage={{
      sessionId,
      report: usageRead.value ?? null,
      status: !controlsAvailable || !usageRequested || sessionId === null ? 'idle' : usage.fetch === 'fetching' || usage.state === 'pending' ? 'loading' : usageRead.error ? 'error' : 'ready',
      ...(usageRead.error ? { error: usageRead.error.message } : {}),
      load: () => setUsageRequested(true),
      refresh: () => { if (!runtimeAvailable || !controlsAvailable || sessionId === null) return; setUsageRequested(true); setUsageRevision((current) => current + 1); },
    }}
    agentSetup={{
      sessionId,
      report: agentsRead.value ?? null,
      status: !controlsAvailable || !agentsRequested || sessionId === null ? 'idle' : agents.fetch === 'fetching' || agents.state === 'pending' ? 'loading' : agentsRead.error ? 'error' : 'ready',
      ...(agentsRead.error ? { error: agentsRead.error.message } : {}),
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
    onRequestArtifact={async (reference) => {
      const result = await rpcClient.inspector.artifacts.read({ spaceId, expectedGeneration: generation, url: reference.url, hash: reference.hash });
      if (result.status === 'error') throw result.error;
      const mediaType = reference.mediaType ?? result.value.mediaType ?? 'application/octet-stream';
      return {
        url: reference.url,
        source: result.value.text,
        previewUrl: `data:${mediaType};base64,${result.value.base64}`,
        mediaType,
      };
    }}
    reviewerId={reviewerId}
    error={queryError ?? (artifactCatalog.state === 'failure' ? artifactCatalog.error.message : null)}
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
  routedTransport.invalidate();
  window.dispatchEvent(new Event(ACCOUNT_DIRECTORY_CHANGED));
}

type AccountWorkActions = Required<ComponentProps<typeof AccountWorkPages>['actions']>;
const AccountWorkActionsContext = createContext<AccountWorkActions | null>(null);

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
  const projectId = location.searchParams.get('project');
  const workspaceId = location.searchParams.get('workspace');
  const retainedProjects = useRetainedQueryValue(projects, 'account-projects');
  const projectValues = useMemo(() => retainedProjects ?? [], [retainedProjects]);
  const directory = useAccountDirectory(projectValues);
  const live = route === 'agent' && runtimeSidebar?.selected?.projectId === projectId && runtimeSidebar.selected.workspaceId === workspaceId ? runtimeSidebar : null;
  const sidebarProjects: SidebarProject[] = projectValues.map((project) => {
    const runtime = live?.projects.find((candidate) => candidate.id === project.id);
    const saved = directory[project.id];
    const matchesRuntimeLease = (summary: SidebarProject['baseSummary'], candidate: GitSpaceShellProps['workspace'] | undefined): boolean => !!candidate && !!summary && summary.generation === candidate.generation && summary.holder.kind === 'held' && summary.holder.machineId === candidate.possessedBy;
    const workspaces = (saved?.workspaces ?? []).map((workspace) => {
      const candidate = runtime?.workspaces.find((item) => item.id === workspace.id)?.runtime;
      return matchesRuntimeLease(workspace.summary, candidate) ? { ...workspace, runtime: candidate } : workspace;
    });
    return { id: project.id, name: project.name, lifecycle: project.lifecycle, base: matchesRuntimeLease(saved?.baseSummary, runtime?.base) ? runtime?.base : undefined, baseSummary: saved?.baseSummary, workspaces, error: saved?.error };
  });
  const frameView = route === 'agent' && !projectId ? 'projects' : route;
  const globalSidebar = frameView !== 'agent' && runtimeSidebar?.view === frameView && runtimeSidebar.selected === null ? runtimeSidebar : null;
  const accountDirectory = useMemo(() => ({
    projects: projectValues,
    directory,
    loading: projects.state === 'pending' && projectValues.length === 0,
    refresh: refreshInspection,
  }), [projectValues, directory, projects.state]);
  const actions = useAccountWorkActions(accountDirectory);
  const runSidebarAction = async (operation: () => void | Promise<void>): Promise<void> => {
    setSidebarActionError(null);
    try { await operation(); }
    catch (cause) { setSidebarActionError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const navigate = (view: ProductRoute, section?: 'source'): void => {
    const url = setProductRoute(new URL(window.location.href), view);
    if (section) url.searchParams.set('section', section);
    else url.searchParams.delete('section');
    navigateProductUrl(url);
  };
  return <AccountWorkActionsContext.Provider value={actions}><AccountSidebarContext.Provider value={setRuntimeSidebar}><AccountDirectoryContext.Provider value={accountDirectory}>
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
      />
      <SidebarInset className="min-w-0 overflow-hidden">
        {!live ? <SidebarInsetTopbar><nav aria-label="Location" className="min-w-0"><span aria-current="page" className="truncate text-body font-medium">{frameView === 'agent' ? projectValues.find((project) => project.id === projectId)?.name ?? 'Your account' : PRODUCT_ROUTE_LABELS[frameView]}</span></nav></SidebarInsetTopbar> : null}
        {projects.state === 'failure' ? <div role="alert" className="flex items-center gap-2 px-4 py-2 text-caption text-destructive"><span>Project directory: {projects.error.message}</span><Button variant="ghost" size="compact" onClick={() => void projects.refetch()}>Retry</Button></div> : null}
        {sidebarActionError ? <div role="alert" className="flex items-center gap-2 px-4 py-2 text-caption text-destructive"><span>Workspace action: {sidebarActionError}</span><Button variant="ghost" size="compact" onClick={() => setSidebarActionError(null)}>Dismiss</Button></div> : null}
        {children}
      </SidebarInset>
      <CreateWorkspaceDialog key={newWorkspaceProject ?? 'closed'} projectId={newWorkspaceProject} workspaces={sidebarProjects.flatMap((project) => project.workspaces.map((workspace) => ({ ...workspace, phase: workspace.definition?.phase ?? workspace.runtime?.phase ?? null })))} pending={createPending} error={createError} onOpenChange={(open) => { if (!open && !createPendingRef.current) { setNewWorkspaceProject(null); setCreateError(null); } }} onSubmit={async (input) => {
        if (createPendingRef.current) return;
        createPendingRef.current = true; setCreatePending(true); setCreateError(null);
        try { await actions.onCreateWorkspace(input); setNewWorkspaceProject(null); }
        catch (cause) { setCreateError(cause instanceof Error ? cause.message : String(cause)); }
        finally { createPendingRef.current = false; setCreatePending(false); }
      }} />
    </SidebarProvider>
  </AccountDirectoryContext.Provider></AccountSidebarContext.Provider></AccountWorkActionsContext.Provider>;
}

type LiveWorkspaceProps = { onOpenSettings: (section?: 'source') => void; defaultMachineId: string | null; onNavigateView: (view: AppView) => void; user: { name: string; handle: string | null }; providers: readonly ProviderAuthView[] };

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
  const availability = useResultQuery(rpcClient.inspector.availability, { projectId, workspaceId }, { enabled: projectId.length > 0 });
  const selectionKey = JSON.stringify([projectId, workspaceId]);
  const projectValues = useRetainedQueryValue(projects, 'projects');
  const available = useRetainedQueryValue(availability, selectionKey);
  useEffect(() => {
    const changed = () => { void projects.refetch(); if (projectId) void availability.refetch(); };
    window.addEventListener(ACCOUNT_DIRECTORY_CHANGED, changed);
    return () => window.removeEventListener(ACCOUNT_DIRECTORY_CHANGED, changed);
  }, [projectId, workspaceId]);
  if (projectId && available?.runtimeAvailable) return <>
    <RunningWorkspace key={selectionKey} {...props} projectId={projectId} workspaceId={workspaceId} />
    {availability.state === 'failure' ? <div role="alert" className="fixed inset-x-0 top-[var(--app-notice-top)] z-50 mx-auto w-fit max-w-full rounded-lg bg-surface-3 px-3 py-2 text-caption text-foreground shadow-surface-3">Workspace availability: {availability.error.message}<Button variant="ghost" size="compact" onClick={() => void availability.refetch()}>Retry</Button></div> : null}
  </>;
  if (!projectValues && projects.state === 'failure') return <PageCanvas><EmptyState title="Project directory unavailable" description={projects.error.message} action={<Button variant="ghost" onClick={() => void projects.refetch()}>Retry</Button>} /></PageCanvas>;
  if (!projectValues) return <PageCanvas><EmptyState icon={<ThinkingIndicator />} title="Loading projects…" description="Reading your account without starting a machine." /></PageCanvas>;
  if (!projectId) return <AccountWork view="projects" />;
  const selectedProject = projectValues.find((project) => project.id === projectId);
  if (!selectedProject) return <PageCanvas><EmptyState title="Project not found" description="Choose another project from your account sidebar." /></PageCanvas>;
  if (selectedProject.lifecycle === 'cloud-only') return <CloudOnlyProject key={projectId} project={selectedProject} defaultMachineId={props.defaultMachineId} onOpenSettings={props.onOpenSettings} />;
  if (!available && availability.state === 'failure') return <PageCanvas><EmptyState title="Workspace availability unavailable" description={availability.error.message} action={<Button variant="ghost" onClick={() => void availability.refetch()}>Retry</Button>} /></PageCanvas>;
  if (!available) return <PageCanvas><EmptyState icon={<ThinkingIndicator />} title="Loading workspace…" description="Checking cloud workspace availability without starting a machine." /></PageCanvas>;
  return <OfflineWorkspace key={`${projectId}:${workspaceId ?? ''}`} projectId={projectId} workspaceId={workspaceId} defaultMachineId={props.defaultMachineId} onOpenSettings={props.onOpenSettings} />;
}

function CloudOnlyProject({ project, defaultMachineId, onOpenSettings }: {
  project: { id: string; name: string; source: { release: string | null; branch: string | null; commit: string | null } | null };
  defaultMachineId: string | null;
  onOpenSettings: LiveWorkspaceProps['onOpenSettings'];
}) {
  const machines = useAccountMachines();
  const machineValues = useRetainedQueryValue(machines, 'machines');
  const [chosen, setChosen] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const openingRef = useRef(false);
  const [opened, setOpened] = useState(false);
  const [needsStateRefresh, setNeedsStateRefresh] = useState(false);
  const [checkingState, setCheckingState] = useState(false);
  const refreshOpenState = async (): Promise<void> => {
    setCheckingState(true);
    try {
      const directory = await rpcClient.project.list({ lifecycle: 'all' });
      if (directory.status === 'error') throw directory.error;
      const current = directory.value.find((candidate) => candidate.id === project.id);
      if (!current) throw new Error('Project is no longer in your account.');
      // Cloud-only remains true while activation is cloning; it does not prove the first open settled.
      if (current.lifecycle === 'cloud-only') setNeedsStateRefresh(true);
      else {
        const canonical = await rpcClient.inspector.bootstrap({ projectId: project.id, workspaceId: null });
        if (canonical.status === 'error') throw canonical.error;
        setNeedsStateRefresh(canonical.value.placement !== null && canonical.value.placement.state !== 'closed');
      }
      refreshInspection();
    } catch (cause) {
      setNeedsStateRefresh(true);
      setError((current) => `${current ?? 'The open outcome is unknown.'} Cloud state could not be refreshed: ${cause instanceof Error ? cause.message : String(cause)}`);
    } finally { setCheckingState(false); }
  };
  const projectSynchronization = useProjectSynchronization(project.id);
  useEventRefresh(projectSynchronization.cursor, () => { refreshInspection(); if (pending || needsStateRefresh) return refreshOpenState(); });
  const online = (machineValues ?? []).filter((machine) => machine.state === 'online' && machine.desiredState === 'online' && machine.rpcEndpoint);
  const machine = chosen !== null ? online.find((machine) => machine.id === chosen) : online.find((machine) => machine.id === defaultMachineId) ?? online[0];
  const open = async (): Promise<void> => {
    if (!machine?.rpcEndpoint || openingRef.current || needsStateRefresh || checkingState) return;
    openingRef.current = true;
    setChosen(machine.id);
    setPending(true); setOpened(false); setError(null);
    const operationId = crypto.randomUUID();
    try {
      const result = await createGitSpaceBrowserClient({ url: machine.rpcEndpoint }).project.open({ projectId: project.id });
      if (result.status === 'error') throw result.error;
      setOpened(true);
      refreshInspection();
    } catch (cause) {
      setError(spaceOpeningError(cause));
      await recordActionIncident({ projectId: project.id, spaceId: project.id, sessionId: null, operation: 'open space', operationId, error: cause })
        .catch((error: unknown) => setError((current) => `${current} Incident could not be saved locally: ${error instanceof Error ? error.message : String(error)}`));
      setNeedsStateRefresh(true);
      await refreshOpenState();
      openingRef.current = false;
      setPending(false);
    }
  };
  return <main className="flex min-h-0 flex-1 flex-col bg-background">
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center gap-4 px-6">
      <h1 className="text-title font-semibold">{project.name}</h1>
      <p className="text-body text-muted-foreground">Your built-in GitSpace project is saved in the cloud. Opening it creates a checkout and project workspace on the machine you choose. Nothing runs until you open it.</p>
      <p className="break-all font-mono text-caption text-muted-foreground">Release {project.source?.release ?? 'not pinned'} · {project.source?.branch ?? 'HEAD'}{project.source?.commit ? ` · ${project.source.commit}` : ''}</p>
      {online.length || chosen ? <Select value={chosen ?? machine?.id ?? ''} onValueChange={setChosen} disabled={pending}><SelectTrigger aria-label="Open GitSpace on machine" /><SelectContent>{chosen && !machine ? <SelectItem value={chosen} index={online.length} disabled>{chosen} · unavailable</SelectItem> : null}{online.map((candidate, index) => <SelectItem value={candidate.id} index={index} key={candidate.id}>{candidate.label}</SelectItem>)}</SelectContent></Select> : <p className="text-body text-muted-foreground">Connect or start a machine in Account settings when you are ready. This project remains available without one.</p>}
      <div><Button variant="primary" disabled={!machine || pending || needsStateRefresh || checkingState} loading={pending} onClick={() => void open()}>{pending ? opened ? 'Connecting to project…' : 'Opening GitSpace project…' : 'Open GitSpace project'}</Button></div>
      {pending ? <p role="status" className="text-caption text-muted-foreground">{opened ? 'The open request succeeded. Waiting for the workspace to become available.' : `Opening on ${machine?.label}. Preparing the checkout and restoring saved state may take a moment.`}</p> : null}
      <div><Button variant="ghost" onClick={() => onOpenSettings()}>Account settings</Button></div>
      {error || machines.state === 'failure' ? <p role="alert" className="text-caption text-destructive">{error ?? (machines.state === 'failure' ? machines.error.message : null)}</p> : null}
      {error ? <div className="flex flex-col gap-2"><p className="text-caption text-muted-foreground">{needsStateRefresh ? 'Opening remains disabled until cloud state confirms it is safe to retry.' : 'Cloud state has been refreshed. You can retry the open request explicitly.'}</p><Button variant="secondary" disabled={checkingState || pending} loading={checkingState} onClick={() => void refreshOpenState()}>Refresh project state</Button></div> : null}
    </div>
  </main>;
}

function OfflineWorkspace({ projectId, workspaceId, defaultMachineId, onOpenSettings }: {
  projectId: string;
  workspaceId: string | null;
  defaultMachineId: string | null;
  onOpenSettings: LiveWorkspaceProps['onOpenSettings'];
}) {
  const shape = useShape();
  const context = useResultQuery(rpcClient.inspector.bootstrap, { projectId, workspaceId });
  const saved = useRetainedQueryValue(context, JSON.stringify([projectId, workspaceId]));
  const historySource = useRef<TranscriptHistorySource | null>(null);
  if (saved) {
    historySource.current = saved.savedTranscript.status === 'none' ? null : {
      key: JSON.stringify(['saved', projectId, workspaceId, saved.checkpoint?.sessionId, saved.checkpoint?.generation, saved.checkpoint?.createdAt]),
      revision: saved,
      page: async (request, signal) => {
        const result = await rpcClient.inspector.transcriptPage({ projectId, workspaceId, ...request }, { signal });
        if (result.status === 'error') throw result.error;
        return result.value;
      },
      content: async (request, signal) => {
        const result = await rpcClient.inspector.transcriptContent({ projectId, workspaceId, ...request }, { signal });
        if (result.status === 'error') throw result.error;
        return result.value;
      },
    };
  }
  if (!saved) historySource.current = null;
  const history = useTranscriptHistory(historySource.current);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [resourceRequest, setResourceRequest] = useState<{ spaceId: string; request: ResourceRequest } | null>(null);
  const [chosenMachineId, setChosenMachineId] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const openingRef = useRef(false);
  const [opened, setOpened] = useState(false);
  const [needsStateRefresh, setNeedsStateRefresh] = useState(false);
  const [checkingState, setCheckingState] = useState(false);
  const refreshOpenState = async (): Promise<void> => {
    setCheckingState(true);
    try {
      const canonical = await rpcClient.inspector.bootstrap({ projectId, workspaceId });
      if (canonical.status === 'error') throw canonical.error;
      await context.refetch();
      setNeedsStateRefresh(canonical.value.placement !== null && canonical.value.placement.state !== 'closed');
      refreshInspection();
    } catch (cause) {
      setNeedsStateRefresh(true);
      setOpenError((current) => `${current ?? 'The open outcome is unknown.'} Cloud state could not be refreshed: ${cause instanceof Error ? cause.message : String(cause)}`);
    } finally { setCheckingState(false); }
  };
  const remoteTransition = saved?.placement?.state === 'opening' || saved?.placement?.state === 'closing';
  const projectSynchronization = useProjectSynchronization(projectId);
  const placementSynchronization = useSpaceSynchronization(workspaceId ?? projectId);
  useEventRefresh(projectSynchronization.cursor, () => context.refetch());
  useEventRefresh(placementSynchronization.cursor, () => { refreshInspection(); return context.refetch(); });
  const [reviewerId, setReviewerId] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void currentDevice().then((device) => { if (!cancelled) setReviewerId(device?.deviceId ?? null); });
    return () => { cancelled = true; };
  }, []);
  const machines = saved?.machines ?? [];
  const onlineMachines = machines.filter((machine) => machine.state === 'online' && machine.desiredState === 'online' && machine.rpcEndpoint !== null);
  const machineId = chosenMachineId !== null
    ? onlineMachines.some((machine) => machine.id === chosenMachineId) ? chosenMachineId : null
    : [defaultMachineId, saved?.checkpoint?.lastMachineId, onlineMachines[0]?.id].find((id) => id && onlineMachines.some((machine) => machine.id === id)) ?? null;
  const turns = useMemo(() => transcriptRowsToTurns(history.rows), [history.rows]);
  const openWorkspace = async (): Promise<void> => {
    if (context.state !== 'success' || !machineId || openingRef.current || remoteTransition || needsStateRefresh || checkingState) return;
    openingRef.current = true;
    setChosenMachineId(machineId);
    setOpened(false);
    setOpening(true);
    setOpenError(null);
    const operationId = crypto.randomUUID();
    try {
      const machine = onlineMachines.find((candidate) => candidate.id === machineId)!;
      const client = createGitSpaceBrowserClient({ url: machine.rpcEndpoint! });
      const input = { spaceId: context.value.identity.spaceId, expectedGeneration: context.value.placement?.generation ?? 0 };
      const result = context.value.workspace.archivedAt ? await client.workspace.restore(input) : await client.space.reopen(input);
      if (result.status === 'error') throw result.error;
      setOpened(true);
      refreshInspection();
    } catch (error) {
      setOpenError(spaceOpeningError(error));
      await recordActionIncident({ projectId, spaceId: context.value.identity.spaceId, sessionId: saved?.checkpoint?.sessionId ?? null, operation: 'open space', operationId, error })
        .catch((cause: unknown) => setOpenError((current) => `${current} Incident could not be saved locally: ${cause instanceof Error ? cause.message : String(cause)}`));
      setNeedsStateRefresh(true);
      await refreshOpenState();
      openingRef.current = false;
      setOpening(false);
    }
  };
  const navigation = <header className="flex min-w-0 shrink-0 flex-wrap items-center gap-2 border-b border-border px-4 py-3">
    {saved ? <span className="min-w-0 flex-1 basis-40 truncate text-body font-medium" title={saved.workspace.name}>{saved.workspace.name}</span> : null}
    <div className="ml-auto flex min-w-0 max-w-full flex-wrap items-center gap-1">
      <Tooltip content="Open this workspace on a machine first"><span><Button variant="ghost" size="icon-compact" aria-label="Open terminals" disabled><Terminal width={16} height={16} strokeWidth={1.5} /></Button></span></Tooltip>
      <Tooltip content="Inspector"><Button variant="ghost" size="icon-compact" aria-label="Open Inspector" aria-pressed={inspectorOpen} onClick={() => setInspectorOpen((open) => !open)}><LayoutRight width={16} height={16} strokeWidth={1.5} /></Button></Tooltip>
      <Button variant="ghost" size="compact" onClick={() => onOpenSettings()}>Account settings</Button>
    </div>
  </header>;
  if (!saved) return <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">{navigation}<div className="flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-auto"><EmptyState icon={context.state === 'pending' ? <ThinkingIndicator /> : undefined} title={context.state === 'pending' ? 'Loading saved workspace…' : 'Cloud Inspector unavailable'} description={context.state === 'failure' ? context.error.message : 'Reading canonical workspace records without opening the workspace.'} action={context.state === 'failure' ? <Button variant="ghost" onClick={() => void context.refetch()}>Retry</Button> : undefined} /></div></main>;
  return <ResourceNavigation.Provider value={(request) => { setResourceRequest({ spaceId: saved.identity.spaceId, request }); setInspectorOpen(true); }}><main className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">{navigation}
    {context.state === 'failure' ? <div role="alert" className="fixed inset-x-0 top-[var(--app-notice-top)] z-50 mx-auto w-fit max-w-full rounded-lg bg-surface-3 px-3 py-2 text-caption text-foreground shadow-surface-3">Cloud Inspector: {context.error.message}<Button variant="ghost" size="compact" onClick={() => void context.refetch()}>Retry</Button></div> : null}
    <div className="flex min-h-0 min-w-0 flex-1 max-md:flex-col">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <TranscriptHistoryNotice loading={history.initialLoading || (history.loading && history.error !== null)} error={history.error} onRetry={history.refresh} />
      <ScrollArea className="min-h-0 min-w-0 flex-1" viewportClassName="h-full">
        <div className="flex min-w-0 flex-col gap-2 px-4 py-4 [overflow-wrap:anywhere] sm:px-6">
          <span className="text-caption text-muted-foreground">{saved.project.name} · {saved.workspace.branch}</span>
          <h1 className="text-title font-semibold">{saved.workspace.name}</h1>
          {saved.checkpoint ? <p className="text-caption text-muted-foreground tabular-nums">Saved checkpoint · generation {saved.checkpoint.generation} · {new Date(saved.checkpoint.createdAt).toLocaleString()}{saved.checkpoint.lastMachineId ? ` · last on ${machines.find((machine) => machine.id === saved.checkpoint!.lastMachineId)?.label ?? saved.checkpoint.lastMachineId}` : ''}</p> : null}
        </div>
        <h2 className="px-4 pb-2 text-caption font-medium text-muted-foreground sm:px-6">Saved transcript</h2>
        {saved.savedTranscript.status === 'available' || history.rows.length > 0 ? <VirtualTranscript history={history} transport={[]} /> : <div className="px-4 py-4 sm:px-6"><EmptyState title={saved.savedTranscript.status === 'none' ? 'No saved transcript' : 'Saved transcript unavailable'} description={saved.savedTranscript.reason ?? 'No transcript has been saved for this workspace.'} action={saved.savedTranscript.status === 'unavailable' && !history.error ? <Button variant="ghost" disabled={history.loading} onClick={() => { history.refresh(); void context.refetch(); }}>Retry transcript</Button> : undefined} /></div>}
      </ScrollArea>
        <div className="flex shrink-0 justify-center px-4 pb-4 pt-2 sm:px-6">
          <div className={`${shape.container} flex w-full min-w-0 max-w-xl flex-col gap-2 bg-surface-3 p-3 shadow-surface-3 [overflow-wrap:anywhere]`}>
            <p role={opening || remoteTransition ? 'status' : undefined} className="text-caption text-muted-foreground">{opening ? opened ? 'The open request succeeded. Connecting to the workspace…' : 'Opening workspace and restoring saved state on the selected machine…' : remoteTransition ? `Workspace ${saved.placement?.state} on ${saved.placement?.machineId ?? 'its machine'}. Waiting for cloud state…` : onlineMachines.length ? 'Open this workspace on a machine to continue.' : 'No online machines. Manage machines in Account settings to open this workspace.'}</p>
            <div className="flex flex-wrap items-center gap-2">
              {onlineMachines.length || chosenMachineId ? <Select size="compact" value={chosenMachineId ?? machineId ?? ''} disabled={opening || remoteTransition} onValueChange={setChosenMachineId}><SelectTrigger aria-label="Open on machine" /><SelectContent>{chosenMachineId && !machineId ? <SelectItem value={chosenMachineId} index={onlineMachines.length} disabled>{machines.find((machine) => machine.id === chosenMachineId)?.label ?? chosenMachineId} · unavailable</SelectItem> : null}{onlineMachines.map((machine, index) => <SelectItem value={machine.id} index={index} key={machine.id}>{machine.label}</SelectItem>)}</SelectContent></Select> : null}
              <Tooltip content={machineId ? 'Open workspace on the selected machine' : 'Choose an online machine in Account settings'}><span><Button variant="secondary" size="compact" disabled={!machineId || opening || remoteTransition || needsStateRefresh || checkingState} loading={opening || remoteTransition} onClick={() => void openWorkspace()}>{opening || remoteTransition ? 'Opening workspace…' : 'Open workspace'}</Button></span></Tooltip>
              <Button variant="ghost" size="compact" onClick={() => setInspectorOpen(true)}>Inspect workspace</Button>
            </div>
            {openError ? <p role="alert" className="text-caption text-destructive">{openError}</p> : null}
            {openError ? <><p className="text-caption text-muted-foreground">{needsStateRefresh ? 'Opening remains disabled until cloud state confirms it is safe to retry.' : 'Cloud state has been refreshed. Your selected machine is preserved; retry only when you are ready.'}</p><Button variant="ghost" disabled={checkingState || opening} loading={checkingState} onClick={() => void refreshOpenState()}>Refresh workspace state</Button></> : null}
          </div>
        </div>
      </div>
      {inspectorOpen ? <aside className="flex min-h-0 w-[min(55vw,900px)] min-w-0 flex-col border-l border-border max-md:h-1/2 max-md:w-full" aria-label="Inspector">{reviewerId ? <LiveInspector key={`${saved.identity.spaceId}:${saved.placement?.generation ?? 0}:${saved.placement?.machineId ?? ''}`} projectId={projectId} spaceId={saved.identity.spaceId} generation={saved.placement?.generation ?? 0} reviewerId={reviewerId} sessionId={saved.checkpoint?.sessionId ?? null} turns={turns} workspaces={[]} onSelectWorkspace={(id) => selectInspection(projectId, id)} refreshToken={0} runtimeAvailable={false} controlsAvailable={false} resourceRequest={resourceRequest?.spaceId === saved.identity.spaceId ? resourceRequest.request : undefined} onClose={() => { setInspectorOpen(false); setResourceRequest(null); }} /> : <EmptyState title="Inspector identity unavailable" description="This browser must be enrolled to inspect workspace records." />}</aside> : null}
    </div>
  </main></ResourceNavigation.Provider>;
}

function RunningWorkspace({ projectId, workspaceId, onOpenSettings, defaultMachineId, onNavigateView, user, providers }: LiveWorkspaceProps & { projectId: string; workspaceId: string | null }) {
  const synchronizationOwner = useSynchronizationOwner();
  const placementsQuery = useResultQuery(rpcClient.placements, {});
  const placementsValue = useRetainedQueryValue(placementsQuery, 'placements');
  const homeMachineId = placementsValue?.machineId ?? null;
  const projectsQuery = useAccountProjects();
  const projectsValue = useRetainedQueryValue(projectsQuery, 'projects');
  const bootstrap = useResultQuery(rpcClient.bootstrap, { projectId, workspaceId }, { enabled: projectId.length > 0 });
  const bootstrapValue = useRetainedQueryValue(bootstrap, JSON.stringify([projectId, workspaceId]));
  const machinesQuery = useAccountMachines();
  const machinesValue = useRetainedQueryValue(machinesQuery, 'machines');
  const [eventConnection, setEventConnection] = useState<'connecting' | 'open' | 'reconnecting' | 'closed'>('connecting');
  const skillsQuery = useResultQuery(rpcClient.skills.list, {});
  const skillsValue = useRetainedQueryValue(skillsQuery, 'skills');
  const liveSession = bootstrapValue?.mainAgent ?? null;
  const liveSessionId = liveSession?.id ?? '';
  const selectedSpace = bootstrapValue?.workspaces.find((candidate) => candidate.id === workspaceId) ?? bootstrapValue?.baseSpace;
  const selectedPlacement = placementsValue?.spaces.find((candidate) => candidate.spaceId === selectedSpace?.id);
  const runtimeAvailable = !!selectedSpace && !selectedSpace.closedAt && selectedSpace.possessedBy !== null
    && !(placementsQuery.state === 'failure' && invalidatesRead(placementsQuery.error))
    && (placementsValue === undefined || (selectedPlacement?.state === 'open' && selectedPlacement.holderId === selectedSpace.possessedBy && selectedPlacement.generation === selectedSpace.spaceGeneration));
  const controlsAvailable = runtimeAvailable && liveSession?.controlsAvailable === true;
  const runtimeKey = JSON.stringify([projectId, workspaceId, selectedSpace?.spaceGeneration, selectedSpace?.possessedBy, liveSessionId]);
  const activeRuntime = useRef<string | null>(null);
  activeRuntime.current = controlsAvailable ? runtimeKey : null;
  const requireRuntime = (): void => {
    if (activeRuntime.current !== runtimeKey) throw new Error('This agent is no longer active. Refresh the workspace or retry its agent.');
  };
  const historySource = useRef<TranscriptHistorySource | null>(null);
  if (bootstrapValue) {
    const value = bootstrapValue;
    const space = value.workspaces.find((candidate) => candidate.id === workspaceId) ?? value.baseSpace;
    historySource.current = {
      key: JSON.stringify(['running', projectId, workspaceId, space.spaceGeneration, space.possessedBy, value.mainAgent?.id, value.checkpoint?.sessionId, value.checkpoint?.generation]),
      revision: value,
      page: async (request, signal) => {
        const result = await rpcClient.transcriptPage({ projectId, workspaceId, ...request }, { signal });
        if (result.status === 'error') throw result.error;
        return result.value;
      },
      content: async (request, signal) => {
        const result = await rpcClient.transcriptContent({ projectId, workspaceId, ...request }, { signal });
        if (result.status === 'error') throw result.error;
        return result.value;
      },
    };
  }
  if (!bootstrapValue) historySource.current = null;
  const history = useTranscriptHistory(historySource.current);
  const turns = useMemo(() => transcriptRowsToTurns(history.rows), [history.rows]);
  const controlRead = useLiveSessionControls(liveSessionId, liveSession?.ompSessionId ?? '', controlsAvailable ? runtimeKey : null, bootstrapValue);
  const sessionControlValue = controlRead.value;
  const canSend = controlsAvailable && !(controlRead.error && invalidatesRead(controlRead.error));
  if (!canSend) activeRuntime.current = null;
  const reconciledControlFailure = useRef<string | null>(null);
  useEffect(() => {
    if (!controlsAvailable) { reconciledControlFailure.current = null; return; }
    if (!controlRead.error) {
      if (controlRead.value) reconciledControlFailure.current = null;
      return;
    }
    if (reconciledControlFailure.current === runtimeKey) return;
    reconciledControlFailure.current = runtimeKey;
    void Promise.all([bootstrap.refetch(), placementsQuery.refetch()]);
  }, [controlRead.error, controlsAvailable, runtimeKey, controlRead.value]);
  const retryableBootstrapFailure = bootstrap.state === 'failure' && isRetryableConnectionError(bootstrap.error);
  const [transport, setTransport] = useState<TransportBlock[]>([]);
  const [inspectorRefreshToken, setInspectorRefreshToken] = useState(0);
  // Deployment progress comes from the same durable runtime stream as agent state.
  const deploymentQuery = useResultQuery(rpcClient.deployment.status, {});
  const deploymentValue = useRetainedQueryValue(deploymentQuery, 'deployment');
  const launchDeployment = useResultMutation(rpcClient.deployment.launch);
  const revertDeployment = useResultMutation(rpcClient.deployment.revert);
  const [launch, setLaunch] = useState<LaunchTrack | null>(null);
  const [launchSheetOpen, setLaunchSheetOpen] = useState(false);
  const [launchedMark, setLaunchedMark] = useState<LaunchedMark | null>(() => readLaunchedMark(window.localStorage, Date.now()));
  // The event stream effect outlives renders; refs hand it the newest launch and status.
  const launchRef = useRef<LaunchTrack | null>(null);
  const deploymentRef = useRef<DeploymentStatusView | null>(null);
  useEffect(() => { launchRef.current = launch; }, [launch]);
  useEffect(() => { deploymentRef.current = deploymentValue ?? null; }, [deploymentValue]);
  // The status snapshot seeds launches begun elsewhere; typed events refresh it.
  const statusLaunch = deploymentValue?.launch ?? null;
  useEffect(() => {
    if (!statusLaunch) return;
    if (launchRef.current?.launchId !== statusLaunch.launchId && statusLaunch.status === 'running') setLaunchSheetOpen(true);
    setLaunch((current) => {
      if (current?.launchId !== statusLaunch.launchId) return launchTrackFrom(statusLaunch);
      if (current.status !== 'running' && statusLaunch.status === 'running') return current;
      return appendLaunchProgress(current, { phase: statusLaunch.phase, message: statusLaunch.message, at: statusLaunch.updatedAt }, { sha: statusLaunch.sha, status: statusLaunch.status, error: statusLaunch.error });
    });
  }, [statusLaunch]);
  // Launching the release this machine already runs (a dev checkout relaunching itself): no generation swap will come, so the browser phases complete in place.
  const alreadyServed = launch?.status === 'succeeded' && launch.sha !== null && deploymentQuery.state === 'success'
    && (!launch.targets.includes('machine') || deploymentQuery.value.thisMachine.sha === launch.sha)
    && (!launch.targets.includes('omp') || deploymentQuery.value.thisMachine.ompSha === launch.sha);
  useEffect(() => {
    if (!alreadyServed) return;
    setLaunch((current) => {
      if (!current || current.log.some((line) => line.phase === 'reload')) return current;
      const at = new Date().toISOString();
      return appendLaunchProgress(appendLaunchProgress(current, { phase: 'restart', message: 'This machine already serves the release', at }), { phase: 'reload', message: 'Nothing to reload', at });
    });
  }, [alreadyServed]);
  // The post-reload strip lives ten seconds, then the mark is gone for good.
  const dismissLaunched = (): void => {
    window.localStorage.removeItem(LAUNCHED_STORAGE_KEY);
    setLaunchedMark(null);
  };
  useEffect(() => {
    if (!launchedMark) return;
    const timer = setTimeout(dismissLaunched, 10_000);
    return () => clearTimeout(timer);
  }, [launchedMark]);
  const launchInto = async (targetWorkspaceId: string, targets: readonly ReleaseTarget[] = RELEASE_TARGETS): Promise<void> => {
    const result = await launchDeployment.mutateAsync({ workspaceId: targetWorkspaceId, targets: [...targets] }).then(
      (outcome) => outcome.status === 'ok' ? outcome : { status: 'error' as const, error: outcome.error },
      (error: unknown) => ({ status: 'error' as const, error: error instanceof Error ? error : new Error(String(error)) }),
    );
    setLaunchSheetOpen(true);
    if (result.status === 'error') {
      // The machine refused before any work started (capability, busy, unknown workspace): a failed track with nothing to retry into but the same input.
      const at = new Date().toISOString();
      setLaunch({ launchId: `rejected:${at}`, workspaceId: targetWorkspaceId, targets, sha: null, status: 'failed', error: result.error.message, log: [{ phase: 'failed', message: result.error.message, at }] });
      return;
    }
    setLaunch(launchTrackFrom(result.value));
    await deploymentQuery.refetch();
  };
  const revertToStable = async (): Promise<void> => {
    const result = await revertDeployment.mutateAsync({});
    if (result.status === 'error') {
      setLaunch({ launchId: `rejected:${Date.now()}`, workspaceId: '', targets: [], sha: null, status: 'failed', error: result.error.message, log: [{ phase: 'failed', message: `Back to stable refused: ${result.error.message}`, at: new Date().toISOString() }] });
      setLaunchSheetOpen(true);
      return;
    }
    await deploymentQuery.refetch();
  };
  /** A `deployment` fact event: one progress line of the launch it names. */
  const applyLaunchEvent = (entityId: string, createdAt: Date, payload: Record<string, unknown>): void => {
    const { launchId, phase, message, status, workspaceId: launchWorkspaceId, targets } = payload;
    if (typeof launchId !== 'string' || typeof phase !== 'string' || typeof message !== 'string' || !isLaunchStatus(status)) return;
    const sha = entityId === 'pending' ? null : entityId;
    const entry = { phase, message, at: createdAt.toISOString() };
    const error = status === 'failed' ? message : null;
    if (launchRef.current?.launchId !== launchId) setLaunchSheetOpen(true);
    setLaunch((current) => current?.launchId === launchId
      ? appendLaunchProgress(current, entry, { sha: sha ?? current.sha, status, error: error ?? current.error })
      : { launchId, workspaceId: typeof launchWorkspaceId === 'string' ? launchWorkspaceId : '', targets: Array.isArray(targets) ? targets.filter(isReleaseTarget) : [], sha, status, error, log: [entry] });
  };
  /**
   * The frontend generation swapped. A launch that is not failed and names a
   * release is the one being reloaded into (its machine daemon may still be
   * replacing); a plain dev rebuild has none and gets the same health gate
   * without the banner.
   */
  const reloadAfterSwap = async (): Promise<void> => {
    const track = launchRef.current;
    const launched = track && track.status !== 'failed' && track.sha !== null && !track.log.some((line) => line.phase === 'reload') ? track : null;
    const stamp = (phase: 'restart' | 'reload', message: string): void => setLaunch((current) => current ? appendLaunchProgress(current, { phase, message, at: new Date().toISOString() }) : current);
    if (launched) stamp('restart', 'Waiting for this machine to serve the release');
    const swapTarget = launched?.targets.includes('omp') ? 'omp' : launched?.targets.includes('machine') ? 'machine' : null;
    const served = await awaitMachineSwap(synchronizationOwner, projectId, swapTarget, swapTarget ? launched?.sha ?? null : null);
    // A swap the launch did not produce (a dev rebuild while it runs, or a gate timeout) reloads without the launched mark; the launch stays tracked through `status.launch`.
    if (launched?.sha && served) {
      stamp('reload', 'Reloading this page');
      const label = deploymentRef.current?.releases.find((release) => release.sha === launched.sha)?.label ?? shortSha(launched.sha);
      window.localStorage.setItem(LAUNCHED_STORAGE_KEY, JSON.stringify({ sha: launched.sha, label, at: Date.now() }));
    }
    window.location.reload();
  };

  useEffect(() => {
    if (bootstrap.state === 'success') document.title = `${bootstrap.value.project.name} · GitSpace`;
  }, [bootstrap.state, bootstrap.state === 'success' ? bootstrap.value.project.name : null]);

  const runtimeSynchronization = useRuntimeSynchronization(projectId);
  const projectSynchronization = useProjectSynchronization(projectId);
  const placementSynchronization = useSpaceSynchronization(workspaceId ?? projectId);
  useEffect(() => {
    setEventConnection(runtimeSynchronization.connection === 'open' ? 'open' : runtimeSynchronization.connection === 'connecting' ? 'connecting' : 'reconnecting');
  }, [runtimeSynchronization.connection]);
  useEventRefresh(projectSynchronization.cursor, () => bootstrap.refetch());
  useEventRefresh(placementSynchronization.cursor, async () => {
    routedTransport.invalidate();
    await Promise.all([placementsQuery.refetch(), bootstrap.refetch()]);
  });
  const runtimeInvalidations = useRef(new Set<string>());
  useSynchronizedEvents(`runtime:${projectId}`, (after, signal) => rpcClient.events({ projectId, after }, { signal }), (frame) => {
    if (frame.type === 'resync') return;
    const event = frame.value;
    if (event?.operation === 'code-version') { void reloadAfterSwap(); return; }
    if (event?.entity === 'deployment') applyLaunchEvent(event.entityId, event.createdAt, event.payload);
    runtimeInvalidations.current.add(event?.entity ?? 'snapshot');
    setInspectorRefreshToken((current) => current + 1);
  });
  useEventRefresh(inspectorRefreshToken, async () => {
    const entities = new Set(runtimeInvalidations.current);
    runtimeInvalidations.current.clear();
    const refreshes: Promise<unknown>[] = [];
    if (entities.has('skill')) refreshes.push(skillsQuery.refetch());
    if (entities.has('deployment') || entities.has('snapshot')) refreshes.push(deploymentQuery.refetch());
    if ([...entities].some((entity) => !INSPECTOR_EVENT_ENTITIES[entity] && entity !== 'deployment' && entity !== 'skill')) refreshes.push(bootstrap.refetch());
    await Promise.all(refreshes);
  });

  const prompt = useResultMutation(rpcClient.session.prompt);
  useEffect(() => { prompt.reset(); }, [runtimeKey, controlsAvailable]);
  const archiveWorkspace = useResultMutation(rpcClient.workspace.archive);
  const closeSpace = useResultMutation(rpcClient.space.close);
  const createProject = useResultMutation(rpcClient.project.create);
  const createWorkspace = useResultMutation(rpcClient.workspace.create);
  const archiveProject = useResultMutation(rpcClient.project.archive);
  const restoreProject = useResultMutation(rpcClient.project.restore);
  const deleteProject = useResultMutation(rpcClient.project.delete);
  const deleteWorkspace = useResultMutation(rpcClient.workspace.delete);
  const moveSpace = async (targetSpaceId: string, destinationMachineId: string): Promise<void> => {
    if (bootstrap.state !== 'success' || machinesQuery.state !== 'success') throw new Error('Fleet directory is unavailable');
    const target = targetSpaceId === bootstrap.value.baseSpace.id
      ? bootstrap.value.baseSpace
      : bootstrap.value.workspaces.find((candidate) => candidate.id === targetSpaceId);
    const destination = machinesQuery.value.find((machine) => machine.id === destinationMachineId);
    if (!target || !destination?.rpcEndpoint) throw new Error('Move destination is unavailable');
    const source = target.possessedBy ?? 'its machine';
    setTransport([{ id: 'move-close', type: 'transport', title: `Closing on ${source}`, detail: 'Publishing Git and agent checkpoint', status: 'reconnecting' }]);
    const closed = await closeSpace.mutateAsync({ spaceId: targetSpaceId, expectedGeneration: target.spaceGeneration });
    if (closed.status === 'error') throw closed.error;
    setTransport([
      { id: 'move-close', type: 'transport', title: `Closed on ${source}`, detail: 'Local files retained', status: 'replaced' },
      { id: 'move-open', type: 'transport', title: `Reopening on ${destination.label}`, detail: 'Claiming the canonical space', status: 'reconnecting' },
    ]);
    const destinationUrl = destination.id === homeMachineId ? homeRpcUrl : destination.rpcEndpoint;
    const opened = await createGitSpaceBrowserClient({ url: destinationUrl }).space.reopen({ spaceId: targetSpaceId, expectedGeneration: closed.value.generation });
    if (opened.status === 'error') throw opened.error;
    setTransport([
      { id: 'move-close', type: 'transport', title: `Closed on ${source}`, detail: 'Local files retained', status: 'replaced' },
      { id: 'move-open', type: 'transport', title: `Reopened on ${destination.label}`, detail: 'Canonical space claimed', status: 'restored' },
    ]);
    routedTransport.invalidate();
    await Promise.all([placementsQuery.refetch(), bootstrap.refetch()]);
  };
  const openingSpaces = useRef(new Map<string, Promise<void>>());
  const uncertainOpenings = useRef(new Set<string>());
  const claimSpace = (targetSpaceId: string, destinationMachineId: string | null): Promise<void> => {
    const existing = openingSpaces.current.get(targetSpaceId);
    if (existing) return existing;
    const operation = (async (): Promise<void> => {
      if (bootstrap.state !== 'success') throw new Error('Workspace is unavailable');
      const target = targetSpaceId === bootstrap.value.baseSpace.id ? bootstrap.value.baseSpace : bootstrap.value.workspaces.find((candidate) => candidate.id === targetSpaceId);
      if (!target) throw new Error(`Space ${targetSpaceId} is unavailable`);
      const destinationUrl = destinationMachineId === null || destinationMachineId === homeMachineId
        ? homeRpcUrl
        : (machinesQuery.state === 'success' ? machinesQuery.value : []).find((machine) => machine.id === destinationMachineId)?.rpcEndpoint ?? null;
      if (!destinationUrl) throw new Error('That machine is not reachable right now');
      const inspection = { projectId: target.projectId, workspaceId: targetSpaceId === bootstrap.value.baseSpace.id ? null : targetSpaceId };
      const canonical = await rpcClient.inspector.bootstrap(inspection);
      if (canonical.status === 'error') throw new Error(`Cloud placement could not be refreshed. No open request was sent: ${canonical.error.message}`);
      if (uncertainOpenings.current.has(targetSpaceId) && canonical.value.placement && canonical.value.placement.state !== 'closed') {
        refreshInspection();
        await bootstrap.refetch();
        throw new Error(`The previous open outcome has been checked: this workspace is ${canonical.value.placement.state} on ${canonical.value.placement.machineId ?? 'its machine'}. No duplicate open request was sent.`);
      }
      const input = { spaceId: targetSpaceId, expectedGeneration: canonical.value.placement?.generation ?? 0 };
      const destinationClient = createGitSpaceBrowserClient({ url: destinationUrl });
      try {
        const opened = canonical.value.workspace.archivedAt ? await destinationClient.workspace.restore(input) : await destinationClient.space.reopen(input);
        if (opened.status === 'error') throw opened.error;
        uncertainOpenings.current.delete(targetSpaceId);
        routedTransport.invalidate();
        refreshInspection();
        await Promise.all([placementsQuery.refetch(), bootstrap.refetch(), projectsQuery.refetch()]);
      } catch (cause) {
        uncertainOpenings.current.add(targetSpaceId);
        await recordActionIncident({ projectId, spaceId: targetSpaceId, sessionId: null, operation: 'open space', operationId: crypto.randomUUID(), error: cause });
        await Promise.allSettled([rpcClient.inspector.bootstrap(inspection), placementsQuery.refetch(), bootstrap.refetch()]);
        refreshInspection();
        throw new Error(spaceOpeningError(cause));
      }
    })().finally(() => { openingSpaces.current.delete(targetSpaceId); });
    openingSpaces.current.set(targetSpaceId, operation);
    return operation;
  };
  const retryAgent = async (): Promise<void> => {
    if (!selectedSpace || !runtimeAvailable || controlsAvailable) throw new Error('Refresh this workspace before retrying its agent.');
    const canonical = await rpcClient.inspector.bootstrap({ projectId, workspaceId });
    if (canonical.status === 'error') throw new Error(`Agent retry could not check ownership: ${canonical.error.message}`);
    const placement = canonical.value.placement;
    if (placement?.state !== 'open' || placement.machineId !== selectedSpace.possessedBy || placement.generation !== selectedSpace.spaceGeneration) {
      refreshInspection();
      throw new Error('This workspace changed ownership. Refresh it before retrying its agent.');
    }
    try {
      const result = await rpcClient.space.reopen({ spaceId: selectedSpace.id, expectedGeneration: placement.generation });
      if (result.status === 'error') throw result.error;
    } catch (cause) {
      await recordActionIncident({ projectId, spaceId: selectedSpace.id, sessionId: liveSession?.id ?? null, operation: 'recover', operationId: crypto.randomUUID(), error: cause });
      throw new Error(`Agent retry failed: ${cause instanceof Error ? cause.message : String(cause)}. Refresh agent state before trying again; no reset was requested.`);
    } finally {
      await Promise.allSettled([bootstrap.refetch(), placementsQuery.refetch()]);
      refreshInspection();
    }
  };
  const shell = useMemo<GitSpaceShellProps | null>(() => {
    if (!bootstrapValue) return null;
    const value = bootstrapValue;
    const selectedWorkspace = workspaceId === null
      ? null
      : value.workspaces.find((candidate) => candidate.id === workspaceId) ?? null;
    const selectedSpaceId = selectedWorkspace?.id ?? value.baseSpace.id;
    const mainAgent = value.mainAgent;
    const agentAction = async <T,>(operation: string, invoke: () => Promise<{ status: 'ok'; value: T } | { status: 'error'; error: Error }>): Promise<T> => {
      const operationId = crypto.randomUUID();
      try {
        requireRuntime();
        const result = await invoke();
        if (result.status === 'error') throw result.error;
        return result.value;
      } catch (error) {
        await recordActionIncident({ projectId, spaceId: selectedSpaceId, sessionId: mainAgent?.id ?? null, operation, operationId, error });
        throw error;
      }
    };
    const artifacts = value.artifacts.map((artifact) => ({
      url: artifact.url,
      name: artifact.path.split('/').at(-1) ?? artifact.path,
      path: artifact.path,
      scope: artifact.scope,
      size: artifact.size,
      ...(artifact.mediaType ? { mediaType: artifact.mediaType } : {}),
    }));
    const terminalApi: NonNullable<GitSpaceShellProps['terminals']> = {
      spaceId: selectedSpaceId,
      events: (name, after, signal) => rpcClient.terminals.events({ spaceId: selectedSpaceId, name, after }, { signal }),
      create: async () => {
        const result = await rpcClient.terminals.create({ spaceId: selectedSpaceId });
        if (result.status === 'error') throw result.error;
        return result.value;
      },
      send: async (name, data) => {
        const result = await rpcClient.terminals.send({ spaceId: selectedSpaceId, name, data });
        if (result.status === 'error') throw result.error;
      },
      stop: async (name) => {
        const result = await rpcClient.terminals.stop({ spaceId: selectedSpaceId, name });
        if (result.status === 'error') throw result.error;
      },
    };
    // Placement table → per-space holder: who runs it, or `released` when it is closed in the cloud.
    const machineLabels: Record<string, string> = Object.fromEntries((machinesValue ?? []).map((machine) => [machine.id, machine.label]));
    const placements: Record<string, { holderId: string; state: string }> = Object.fromEntries((placementsValue?.spaces ?? []).map((space) => [space.spaceId, { holderId: space.holderId, state: space.state }]));
    const holderOf = (spaceId: string): SpaceHolderView => {
      const placement = placements[spaceId];
      if (!placement) return { kind: 'unknown' };
      if (placement.state === 'closed' || placement.holderId === 'unassigned') return { kind: 'released' };
      return { kind: 'held', machineId: placement.holderId, label: machineLabels[placement.holderId] ?? placement.holderId };
    };
    const baseSpace: GitSpaceShellProps['baseSpace'] = {
      kind: 'project',
      id: value.baseSpace.id,
      projectId: value.baseSpace.projectId,
      projectName: value.project.name,
      name: value.baseSpace.name,
      branch: value.baseSpace.branch,
      phase: null,
      possessedBy: value.baseSpace.possessedBy ?? 'Unpossessed',
      holder: holderOf(value.baseSpace.id),
      status: value.baseSpace.status,
      generation: value.baseSpace.spaceGeneration,
      closedAt: value.baseSpace.closedAt,
    };
    const workspaces: GitSpaceShellProps['workspaces'] = value.workspaces.map((candidate) => ({
      kind: 'workspace' as const,
      id: candidate.id,
      projectId: candidate.projectId,
      projectName: candidate.projectName,
      name: candidate.name,
      branch: candidate.branch,
      phase: candidate.phase,
      possessedBy: candidate.possessedBy ?? 'Unpossessed',
      holder: holderOf(candidate.id),
      status: candidate.status,
      generation: candidate.spaceGeneration,
      closedAt: candidate.closedAt,
      relations: candidate.relations,
      stack: candidate.stack,
    }));
    const scope: GitSpaceShellProps['workspace'] = workspaces.find((candidate) => candidate.id === selectedWorkspace?.id) ?? baseSpace;
    const selectWorkspace = (nextWorkspaceId: string): void => selectInspection(value.workspaces.find((candidate) => candidate.id === nextWorkspaceId)?.projectId ?? projectId, nextWorkspaceId);
    const setWorkspaceRelations: NonNullable<GitSpaceShellProps['onSetWorkspaceRelations']> = async (targetWorkspaceId, relations) => {
      const result = await rpcClient.workspace.setRelations({ workspaceId: targetWorkspaceId, dependsOn: [...relations.dependsOn], relatedTo: [...relations.relatedTo], stackedOn: relations.stackedOn });
      if (result.status === 'error') throw result.error;
      await bootstrap.refetch();
    };
    const repository = value.project.repositoryPath.split('/').filter(Boolean).at(-1) ?? value.project.repositoryPath;
    // Managed checkouts end in "base"; the account's source role identifies GitSpace.
    const isGitSpaceProject = projectsValue?.find((project) => project.id === value.project.id)?.role === 'gitspace-source';
    const sidebarDeployment: GitSpaceShellProps['deployment'] = deploymentValue ? {
      status: deploymentValue,
      launch,
      isGitSpaceProject,
      onLaunch: (targetWorkspaceId) => launchInto(targetWorkspaceId),
      onRevert: revertToStable,
    } : null;
    return {
      project: {
        id: value.project.id,
        name: value.project.name,
        repository,
        connected: eventConnection === 'open',
      },
      projects: projectsValue ?? [],
      workspace: scope,
      baseSpace,
      workspaces,
      mainAgent: mainAgent ? {
        id: mainAgent.id,
        title: `${mainAgent.scope === 'project' ? 'Project' : 'Workspace'} agent ${mainAgent.ompSessionId.slice(0, 8)}`,
        state: mainAgent.renderState,
        model: 'OMP',
        recovering: mainAgent.resumePending,
        controlsAvailable,
        errorMessage: currentAgentFailure(mainAgent.health)?.message ?? null,
        failed: mainAgent.state === 'failed',
      } : null,
      onRetryAgent: runtimeAvailable && !controlsAvailable && !liveSession?.resumePending ? retryAgent : undefined,
      controlsError: controlsAvailable && controlRead.error ? `Agent controls could not refresh: ${controlRead.error.message}` : undefined,
      sessionControls: mainAgent && canSend && sessionControlValue ? {
        value: sessionControlValue,
        onReadHistory: async (request, signal) => {
          requireRuntime();
          const result = await rpcClient.session.history({ sessionId: mainAgent.id, ...request }, { signal });
          if (result.status === 'error') throw result.error;
          requireRuntime();
          return result.value;
        },
        onCycleRole: async (direction) => {
          await agentAction('cycle-role', () => rpcClient.session.cycleRole({ sessionId: mainAgent.id, direction }));
          await controlRead.refetch();
        },
        onSetModel: async (provider, model) => {
          await agentAction('set-model', () => rpcClient.session.setModel({ sessionId: mainAgent.id, provider, model }));
          await controlRead.refetch();
        },
        onSetThinking: async (thinking) => {
          await agentAction('set-thinking', () => rpcClient.session.setThinking({ sessionId: mainAgent.id, thinking }));
          await controlRead.refetch();
        },
        onSetFast: async (enabled) => {
          await agentAction('set-fast', () => rpcClient.session.setFast({ sessionId: mainAgent.id, enabled }));
          await controlRead.refetch();
        },
        onSetApproval: async (approvalMode) => {
          await agentAction('set-approval', () => rpcClient.session.setApproval({ sessionId: mainAgent.id, approvalMode }));
          await controlRead.refetch();
        },
        onSetGoal: async (enabled) => {
          await agentAction('set-goal', () => rpcClient.session.setGoal({ sessionId: mainAgent.id, enabled, objective: null }));
          await controlRead.refetch();
        },
        onCompact: async (instructions) => {
          await agentAction('compact', () => rpcClient.session.compact({ sessionId: mainAgent.id, instructions: instructions ?? null }));
          await controlRead.refetch();
        },
        onClearQueue: async () => {
          await agentAction('clear-queue', () => rpcClient.session.clearQueue({ sessionId: mainAgent.id }));
          await controlRead.refetch();
        },
        onRemoveQueuedMessage: async (kind, index) => {
          await agentAction('remove-queued-message', () => rpcClient.session.removeQueuedMessage({ sessionId: mainAgent.id, kind, index }));
          await controlRead.refetch();
        },
        onPromoteQueuedMessage: async (index) => {
          await agentAction('promote-queued-message', () => rpcClient.session.promoteQueuedMessage({ sessionId: mainAgent.id, index }));
          await controlRead.refetch();
        },
        onAnswerAsk: async (id, answers) => {
          await agentAction('answer-ask', () => rpcClient.session.answerAsk({ sessionId: mainAgent.id, id, answers }));
          await controlRead.refetch();
        },
        onStop: async () => {
          await agentAction('stop', () => rpcClient.session.stop({ sessionId: mainAgent.id }));
          await bootstrap.refetch();
        },
        onNavigateTree: async (entryId) => {
          await agentAction('navigate-tree', () => rpcClient.session.navigateTree({ sessionId: mainAgent.id, entryId }));
          await bootstrap.refetch();
        },
      } : undefined,
      onSetWorkspacePhase: async (targetWorkspaceId, phase) => {
        const result = await rpcClient.workspace.setPhase({ workspaceId: targetWorkspaceId, phase });
        if (result.status === 'error') throw result.error;
        await bootstrap.refetch();
      },
      onSetWorkspaceRelations: setWorkspaceRelations,
      turns,
      transcript: history,
      history: { loading: history.initialLoading || (history.loading && history.error !== null), error: history.error, onRetry: history.refresh },
      transport,
      artifacts,
      // Move destinations: every online machine except the one currently holding the selected space.
      machines: (machinesValue ?? []).filter((machine) => machine.state === 'online' && machine.rpcEndpoint !== null && machine.id !== scope.possessedBy).map(({ id, label }) => ({ id, label })),
      terminals: runtimeAvailable ? terminalApi : undefined,
      skills: skillsValue ?? [],
      renderEnvironmentStatus: (onInspect) => <LiveEnvironmentStatus key={`${selectedSpaceId}:${scope.generation}`} spaceId={selectedSpaceId} onInspect={onInspect} onConfigure={mainAgent && canSend ? async () => { await agentAction('prompt', () => prompt.mutateAsync({ sessionId: mainAgent.id, text: CONFIGURE_ENVIRONMENT_PROMPT, streamingBehavior: 'followUp', images: [] })); } : undefined} />,
      renderInspector: (onClose, initialView, resourceRequest) => <LiveInspector
        key={`${selectedSpaceId}:${scope.generation}:${scope.possessedBy}`}
        resourceRequest={resourceRequest}
        initialView={initialView}
        runtimeAvailable={runtimeAvailable}
        controlsAvailable={controlsAvailable}
        onAskAgent={mainAgent && canSend ? async (text) => { await agentAction('prompt', () => prompt.mutateAsync({ sessionId: mainAgent.id, text, streamingBehavior: 'followUp', images: [] })); } : undefined}
        projectId={projectId}
        spaceId={selectedSpaceId}
        generation={selectedWorkspace?.spaceGeneration ?? value.baseSpace.spaceGeneration}
        reviewerId={homeMachineId ?? 'browser'}
        sessionId={mainAgent?.id ?? value.checkpoint?.sessionId ?? null}
        turns={turns}
        scope={scope}
        workspaces={workspaces}
        onSelectWorkspace={selectWorkspace}
        onSetRelations={setWorkspaceRelations}
        refreshToken={inspectorRefreshToken}
        onClose={onClose}
        onGenerateChangeGuide={mainAgent && canSend ? async () => {
          await agentAction('prompt', () => prompt.mutateAsync({
            sessionId: mainAgent.id,
            text: 'Use the review-guide-narrator skill. Delegate a focused narrator subagent to analyze the current diff and typed Journal, submit every stale Change Guide cluster through the GitSpace Change Guide API, fix validation errors, and confirm the saved guide.',
            streamingBehavior: 'followUp',
            images: [],
          }));
        } : undefined}
      />,
      ...(mainAgent && canSend ? {
        onSend: async (text: string, behavior?: 'steer' | 'followUp', images?: Array<{ data: string; mimeType: string }>) => {
          await agentAction('prompt', () => prompt.mutateAsync({ sessionId: mainAgent.id, text, streamingBehavior: behavior ?? 'followUp', images: images ?? [] }));
          await controlRead.refetch();
        },
      } : {}),
      sendPending: prompt.state === 'pending',
      ...(prompt.state === 'failure' ? { sendError: prompt.error.message } : {}),
      onSelectWorkspace: selectWorkspace,
      onSelectProject: (nextProjectId: string) => selectInspection(nextProjectId, null),
      onCloseSpace: async (targetSpaceId: string) => {
        const target = targetSpaceId === value.baseSpace.id ? value.baseSpace : value.workspaces.find((candidate) => candidate.id === targetSpaceId);
        if (!target) throw new Error(`Space ${targetSpaceId} is unavailable`);
        const result = await closeSpace.mutateAsync({ spaceId: targetSpaceId, expectedGeneration: target.spaceGeneration });
        if (result.status === 'error') throw result.error;
        refreshInspection();
        if (targetSpaceId === selectedSpaceId) return;
        await Promise.all([placementsQuery.refetch(), bootstrap.refetch()]);
      },
      onReopenSpace: (targetSpaceId: string) => claimSpace(targetSpaceId, null),
      onArchiveWorkspace: async (targetSpaceId: string) => {
        const canonical = await rpcClient.inspector.bootstrap({ projectId: value.project.id, workspaceId: targetSpaceId });
        if (canonical.status === 'error') throw canonical.error;
        const result = await archiveWorkspace.mutateAsync({
          projectId: canonical.value.workspace.projectId, spaceId: targetSpaceId,
          expectedRevision: canonical.value.workspace.revision, expectedGeneration: canonical.value.placement?.generation ?? null,
        });
        if (result.status === 'error') throw result.error;
        refreshInspection();
        if (targetSpaceId === selectedSpaceId) return;
        await Promise.all([bootstrap.refetch(), projectsQuery.refetch()]);
      },
      onClaimWorkspace: claimSpace,
      // Claim targets: every reachable online machine; the space is held by nobody, so none is excluded.
      claimMachines: (machinesValue ?? []).filter((machine) => machine.state === 'online' && machine.rpcEndpoint !== null).map(({ id, label }) => ({ id, label })),
      homeMachineId,
      defaultMachineId,
      checkpoint: value.checkpoint,
      onMoveWorkspace: moveSpace,
      onCreateProject: async (input) => {
        const result = await createProject.mutateAsync(input);
        if (result.status === 'error') throw result.error;
        await projectsQuery.refetch();
        refreshInspection();
        selectInspection(result.value.project.id, null);
      },
      onCreateWorkspace: async (input) => {
        const result = await createWorkspace.mutateAsync({ ...input, dependsOn: [...input.dependsOn] });
        if (result.status === 'error') throw result.error;
        await projectsQuery.refetch();
        if (input.projectId === projectId) await bootstrap.refetch();
        refreshInspection();
        selectInspection(input.projectId, result.value.workspace.id);
      },
      onArchiveProject: async (targetProjectId, expectedRevision) => {
        const result = await archiveProject.mutateAsync({ projectId: targetProjectId, expectedRevision });
        if (result.status === 'error') throw result.error;
        await projectsQuery.refetch();
        refreshInspection();
      },
      onRestoreProject: async (targetProjectId, expectedRevision) => {
        const result = await restoreProject.mutateAsync({ projectId: targetProjectId, expectedRevision });
        if (result.status === 'error') throw result.error;
        await projectsQuery.refetch();
        refreshInspection();
      },
      onDeleteProject: async (targetProjectId, expectedRevision) => {
        const result = await deleteProject.mutateAsync({ projectId: targetProjectId, expectedRevision });
        if (result.status === 'error') throw result.error;
        const candidates = projectsQuery.state === 'success'
          ? projectsQuery.value.filter((candidate) => candidate.id !== targetProjectId && candidate.lifecycle === 'active')
          : [];
        await projectsQuery.refetch();
        if (targetProjectId !== projectId) return;
        const url = new URL(window.location.href);
        if (candidates[0]) url.searchParams.set('project', candidates[0].id);
        else url.searchParams.delete('project');
        url.searchParams.delete('workspace');
        refreshInspection();
        navigateProductUrl(setProductRoute(url, candidates[0] ? 'agent' : 'projects'));
      },
      onDeleteWorkspace: async (targetWorkspaceId) => {
        const result = await deleteWorkspace.mutateAsync({ workspaceId: targetWorkspaceId });
        if (result.status === 'error') throw result.error;
        await projectsQuery.refetch();
        refreshInspection();
        if (workspaceId === targetWorkspaceId) {
          selectInspection(projectId, null);
        } else {
          await bootstrap.refetch();
        }
      },
      onOpenSettings,
      user,
      onNavigateView,
      deployment: sidebarDeployment,
      launchBanner: launchedMark ? <LaunchedBanner mark={launchedMark} onRevert={revertToStable} onDismiss={dismissLaunched} /> : null,
    };
  }, [bootstrapValue, projectsValue, machinesValue, placementsValue, skillsValue, deploymentValue, controlsAvailable, runtimeAvailable, runtimeKey, sessionControlValue, controlRead.error, controlRead.refetch, launchDeployment.state, launch, launchedMark, eventConnection, inspectorRefreshToken, prompt.state, prompt.state === 'failure' ? prompt.error : null, archiveWorkspace.state, createProject.state, createWorkspace.state, archiveProject.state, restoreProject.state, deleteProject.state, deleteWorkspace.state, workspaceId, homeMachineId, defaultMachineId, transport, onOpenSettings, onNavigateView, user.name, user.handle, turns, history]);
  const recoveryScheduled = retryableBootstrapFailure && runtimeSynchronization.connection !== 'open';
  if (!shell && projectsQuery.state === 'pending') return <PageCanvas><EmptyState icon={<ThinkingIndicator />} title="Opening projects…" description="Loading cloud project authority." /></PageCanvas>;
  if (!shell && projectsQuery.state === 'failure') return <PageCanvas><EmptyState title="Projects are unavailable" description={projectsQuery.error.message} action={<Button variant="ghost" onClick={() => void projectsQuery.refetch()}>Retry</Button>} /></PageCanvas>;

  if (!shell && (bootstrap.state === 'pending' || recoveryScheduled)) return <PageCanvas><EmptyState icon={<ThinkingIndicator />} title="Opening GitSpace…" description={recoveryScheduled ? 'Reconnecting to the selected machine.' : 'Loading the selected agent.'} /></PageCanvas>;
  if (!shell && bootstrap.state === 'failure') return <PageCanvas><EmptyState title="GitSpace is unavailable" description={bootstrap.error.message} action={<Button variant="ghost" onClick={() => { refreshInspection(); void bootstrap.refetch(); }}>Retry</Button>} /></PageCanvas>;
  if (!shell) return <PageCanvas><EmptyState title="Project unavailable" description="The selected project is not available on this machine." /></PageCanvas>;
  return <>
    <div className="shrink-0">{([['Placements', placementsQuery], ['Machines', machinesQuery], ['Skills', skillsQuery], ['Source', deploymentQuery]] as const).map(([label, query]) => query.state === 'failure' ? <p key={label} role="alert" className="px-4 py-1 text-caption text-destructive">{label}: {query.error.message}<Button variant="ghost" size="compact" onClick={() => void query.refetch()}>Retry</Button></p> : null)}</div>
    <GitSpaceShell {...shell} providers={providers} />
    {bootstrap.state === 'failure' ? <div role={recoveryScheduled ? 'status' : 'alert'} className="fixed inset-x-0 top-[var(--app-notice-top)] z-50 flex justify-center px-4">
      <div className="flex items-center gap-2 rounded-lg bg-surface-3 px-3 py-2 text-caption text-foreground shadow-surface-3">
        {recoveryScheduled ? <ThinkingIndicator size="compact" /> : null}
        <span>{recoveryScheduled ? 'Reconnecting to this machine…' : bootstrap.error.message}</span>
        {!recoveryScheduled ? <Button variant="ghost" size="compact" onClick={() => { refreshInspection(); void bootstrap.refetch(); }}>Retry</Button> : null}
      </div>
    </div> : null}
    {launch ? <LaunchSheet launch={launch} open={launchSheetOpen} onOpenChange={setLaunchSheetOpen} onRetry={() => launchInto(launch.workspaceId, launch.targets).catch((cause: unknown) => {
      const message = cause instanceof Error ? cause.message : String(cause);
      setLaunch((current) => current ? { ...current, status: 'failed', error: message } : current);
    })} /> : null}
  </>;
}

function GitSpaceProduct() {
  const location = useProductLocation();
  const route = productRouteFromLocation(location);
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
  const workspaceAvailability = useResultQuery(rpcClient.inspector.availability, { projectId: selectedProjectId, workspaceId: optionalQueryParameter('workspace') }, { enabled: selectedProjectId.length > 0 });
  const workspaceAvailabilityValue = useRetainedQueryValue(workspaceAvailability, JSON.stringify([selectedProjectId, optionalQueryParameter('workspace')]));
  const runtimeMetadataEnabled = route === 'settings' || forceOnboarding || (settingsValue !== undefined && !settingsValue.onboardingComplete) || workspaceAvailabilityValue?.runtimeAvailable === true;
  const machinesQuery = useAccountMachines();
  const machinesValue = useRetainedQueryValue(machinesQuery, 'machines');
  const onlineMachineIds = (machinesValue ?? []).filter((machine) => machine.state === 'online' && machine.desiredState === 'online' && machine.rpcEndpoint).map((machine) => machine.id).sort().join(',');
  const runtimeAvailable = runtimeMetadataEnabled && onlineMachineIds.length > 0;
  const ompQuery = useResultQuery(rpcClient.settings.omp.get, {}, { enabled: runtimeMetadataEnabled });
  const gitIdentityQuery = useAccountGitIdentity();
  const ompRead = useRetainedQueryValue(ompQuery, 'omp-settings');
  const ompConfiguration = useAccountOmpConfiguration();
  const ompDocument = useRetainedQueryValue(ompConfiguration, 'omp-document');
  const ompValue = ompRead && ompDocument ? { ...ompRead, document: ompDocument } : ompRead;
  const gitIdentityValue = useRetainedQueryValue(gitIdentityQuery, 'git-identity');
  const settingsOmpValue = ompValue ?? { schema: [], document: ompDocument ?? { generation: 0, content: '', checksum: '', updatedAt: new Date(0).toISOString(), updatedBy: 'unavailable' }, sync: { status: 'error' as const, message: ompQuery.state === 'failure' ? ompQuery.error.message : 'OMP settings are unavailable' } };
  const settingsGitIdentityValue = gitIdentityValue ?? null;
  const updateSettings = useResultMutation(rpcClient.settings.update);
  const reserveHandle = useResultMutation(rpcClient.settings.reserveHandle);
  const setOmpSetting = useResultMutation(rpcClient.settings.omp.set);
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
  // Settings → Source reads the same status entry LiveWorkspace polls; revert is only offered there.
  const settingsDeploymentQuery = useResultQuery(rpcClient.deployment.status, {}, { enabled: runtimeMetadataEnabled });
  const settingsDeploymentValue = useRetainedQueryValue(settingsDeploymentQuery, 'deployment');
  const revertDeployment = useResultMutation(rpcClient.deployment.revert);
  const composioSetupQuery = useResultQuery(rpcClient.mcp.composio.setup.get, {});
  const composioSetupValue = useRetainedQueryValue(composioSetupQuery, 'composio-setup');
  const putComposioSetup = useResultMutation(rpcClient.mcp.composio.setup.put);
  const deleteComposioSetup = useResultMutation(rpcClient.mcp.composio.setup.delete);
  const browserRelayQuery = useResultQuery(rpcClient.browserRelay.status, {}, { enabled: runtimeMetadataEnabled });
  const browserRelayValue = useRetainedQueryValue(browserRelayQuery, 'browser-relay');
  const setupBrowserRelay = useResultMutation(rpcClient.browserRelay.setup);
  const startBrowserRelay = useResultMutation(rpcClient.browserRelay.start);
  const stopBrowserRelay = useResultMutation(rpcClient.browserRelay.stop);
  const testBrowserRelay = useResultMutation(rpcClient.browserRelay.test);
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
  const runBrowserRelay = async (operation: 'setup' | 'start' | 'stop' | 'test'): Promise<void> => {
    const procedure = operation === 'setup' ? setupBrowserRelay
      : operation === 'start' ? startBrowserRelay
        : operation === 'stop' ? stopBrowserRelay
          : testBrowserRelay;
    const result = await procedure.mutateAsync({});
    await browserRelayQuery.refetch();
    if (result.status === 'error') throw result.error;
  };
  const revokeDeviceAndRefresh = async (deviceId: string): Promise<void> => {
    const result = await revokeDevice.mutateAsync({ deviceId });
    if (result.status === 'error') throw result.error;
    await devicesQuery.refetch();
  };
  const mintApiClient = async (draft: ApiClientDraft): Promise<string> => {
    const device = await currentDevice();
    if (!device) throw new Error('This browser is not enrolled');
    const key = await createApiClient(device, draft);
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
  const providersQuery = useResultQuery(rpcClient.providers.list, {}, { enabled: runtimeMetadataEnabled });
  const modelsQuery = useResultQuery(rpcClient.providers.models, {}, { enabled: runtimeAvailable });
  const providersValue = useRetainedQueryValue(providersQuery, 'providers');
  const modelsValue = useRetainedQueryValue(modelsQuery, 'models');
  // Usage is fetched only once the Providers tab/step is shown; the first
  // load reads the machine's cache, every explicit refresh bypasses it.
  const [usageVisible, setUsageVisible] = useState(false);
  const [usageRefresh, setUsageRefresh] = useState(false);
  const usageQuery = useResultQuery(rpcClient.providers.usage, { providerId: null, refresh: usageRefresh }, { enabled: runtimeAvailable && usageVisible });
  const usageValue = useRetainedQueryValue(usageQuery, 'provider-usage');
  useEffect(() => {
    if (!runtimeMetadataEnabled) return;
    // The cloud's offline provider view cannot sign in. Replace it when the
    // reachable runtime changes, including first-machine startup during onboarding.
    void providersQuery.refetch();
    if (runtimeAvailable) {
      void modelsQuery.refetch();
      void gitIdentityQuery.refetch();
      if (usageVisible) void usageQuery.refetch();
    }
  }, [runtimeMetadataEnabled, onlineMachineIds]);
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
      setSettingsError(error instanceof Error ? error.message : String(error));
      throw error;
    }
  };
  const updateOmp = async (path: string, value: OmpSettingValue): Promise<void> => {
    setSettingsError(null);
    try {
      const updated = await setOmpSetting.mutateAsync({ path, valueJson: JSON.stringify(value) });
      if (updated.status === 'error') throw updated.error;
      await ompQuery.refetch();
    } catch (error) {
      setSettingsError(error instanceof Error ? error.message : String(error));
      throw error;
    }
  };
  const saveMachineNotes = async (machineId: string, notes: string): Promise<void> => {
    setSettingsError(null);
    const result = await updateMachineNotes.mutateAsync({ machineId, notes });
    if (result.status === 'error') {
      setSettingsError(result.error.message);
      throw result.error;
    }
    await machinesQuery.refetch();
  };
  const createSandbox = async (): Promise<void> => {
    setSettingsError(null);
    const result = await createSandboxMachine.mutateAsync({});
    if (result.status === 'error') {
      setSettingsError(result.error.message);
      throw result.error;
    }
    await machinesQuery.refetch();
  };
  const controlMachine = async (action: 'sleep' | 'resume', machineId: string): Promise<void> => {
    setSettingsError(null);
    const mutation = action === 'sleep' ? sleepMachine : resumeMachine;
    const result = await mutation.mutateAsync({ machineId });
    if (result.status === 'error') {
      setSettingsError(result.error.message);
      throw result.error;
    }
    await machinesQuery.refetch();
  };
  const removeMachine = async (machineId: string): Promise<void> => {
    setSettingsError(null);
    const result = await destroyMachine.mutateAsync({ machineId });
    if (result.status === 'error') {
      setSettingsError(result.error.message);
      throw result.error;
    }
    await machinesQuery.refetch();
  };
  const revertToChannel = async (): Promise<void> => {
    setSettingsError(null);
    const result = await revertDeployment.mutateAsync({});
    if (result.status === 'error') {
      setSettingsError(result.error.message);
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
      setSettingsError(error instanceof Error ? error.message : String(error));
      throw error;
    }
  };
  const refreshProviders = async (): Promise<void> => {
    await providersQuery.refetch();
    if (runtimeAvailable) {
      await modelsQuery.refetch();
      if (usageVisible) await usageQuery.refetch();
    }
  };
  const appendLoginEvent = (flowId: string, event: ProviderLoginEvent): void => {
    setLoginFlow((current) => current?.flowId === flowId ? { ...current, events: [...current.events, event], done: event.type === 'done' } : current);
  };
  const signInProvider = async (providerId: string): Promise<void> => {
    loginStream.current?.abort();
    setSettingsError(null);
    const started = await startProviderLogin.mutateAsync({ providerId });
    if (started.status === 'error') {
      setSettingsError(started.error.message);
      throw started.error;
    }
    const { flowId } = started.value;
    const controller = new AbortController();
    loginStream.current = controller;
    setLoginFlow({ flowId, providerId, events: [], done: false });
    void (async () => {
      let finished = false;
      try {
        for await (const event of rpcClient.providers.login.events({ flowId }, { signal: controller.signal })) {
          if (controller.signal.aborted) return;
          if (event.status === 'error') {
            appendLoginEvent(flowId, { type: 'done', ok: false, error: event.error.message });
            finished = true;
            break;
          }
          appendLoginEvent(flowId, event.value);
          if (event.value.type === 'done') {
            finished = true;
            if (event.value.ok) await refreshProviders();
            break;
          }
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        appendLoginEvent(flowId, { type: 'done', ok: false, error: error instanceof Error ? error.message : String(error) });
        finished = true;
      }
      if (!finished && !controller.signal.aborted) appendLoginEvent(flowId, { type: 'done', ok: false, error: 'The sign-in stream ended before the provider finished.' });
    })();
  };
  const respondLogin = async (promptId: string, value: string): Promise<void> => {
    if (!loginFlow) throw new Error('No sign-in in progress');
    const result = await respondProviderLogin.mutateAsync({ flowId: loginFlow.flowId, promptId, value });
    if (result.status === 'error') throw result.error;
  };
  const dismissLogin = async (): Promise<void> => {
    const flow = loginFlow;
    if (!flow) return;
    loginStream.current?.abort();
    loginStream.current = null;
    setLoginFlow(null);
    // A finished flow is already gone on the machine; only a live one needs cancelling.
    if (!flow.done) await cancelProviderLogin.mutateAsync({ flowId: flow.flowId });
  };
  const signOutProvider = async (providerId: string, credentialId: string | null): Promise<void> => {
    const result = await logoutProvider.mutateAsync({ providerId, credentialId });
    if (result.status === 'error') throw result.error;
    await refreshProviders();
  };
  const saveProviderApiKey = async (providerId: string, key: string): Promise<void> => {
    const result = await setProviderApiKey.mutateAsync({ providerId, key });
    if (result.status === 'error') throw result.error;
    await refreshProviders();
  };
  const refreshUsage = async (): Promise<void> => {
    await providersQuery.refetch();
    if (!runtimeAvailable) return;
    if (usageRefresh) await usageQuery.refetch();
    else setUsageRefresh(true);
  };
  const providerViews = providersValue?.providers ?? [];
  const providersSection: ProvidersSectionProps = {
    providers: providerViews,
    ...(providersQuery.state === 'failure' ? { error: providersQuery.error.message } : {}),
    usage: usageValue ?? null,
    usageStatus: !runtimeAvailable || !usageVisible ? 'idle' : usageQuery.state === 'failure' ? 'error' : usageQuery.state === 'pending' || usageQuery.fetch === 'fetching' ? 'loading' : 'ready',
    ...(runtimeAvailable && usageQuery.state === 'failure' ? { usageError: usageQuery.error.message } : {}),
    onShow: () => setUsageVisible(true),
    onRefreshUsage: refreshUsage,
    onSignIn: signInProvider,
    onSignOut: signOutProvider,
    onSetApiKey: saveProviderApiKey,
    login: { flow: loginFlow, respond: respondLogin, cancel: dismissLogin },
  };
  // Account/machine metadata refreshes are not navigation away from an open workspace.
  if (settingsValue && draft?.onboardingComplete && !forceOnboarding && route !== 'settings') return <>
    <LiveWorkspace onOpenSettings={(section) => navigateProduct('settings', 'push', section ?? null)} defaultMachineId={draft.defaults.machineId} onNavigateView={(next) => navigateProduct(next)} user={{ name: draft.profile.displayName, handle: draft.profile.handle }} providers={providerViews} />
    {settingsQuery.state === 'failure' ? <div role="alert" className="fixed inset-x-0 top-[var(--app-notice-top)] z-50 mx-auto w-fit max-w-full rounded-lg bg-surface-3 px-3 py-2 text-caption text-foreground shadow-surface-3">Account settings: {settingsQuery.error.message}<Button variant="ghost" size="compact" onClick={() => void settingsQuery.refetch()}>Retry</Button></div> : null}
  </>;
  if (!settingsValue && settingsQuery.state === 'failure') {
    return <PageCanvas><EmptyState title="GitSpace setup is unavailable" description={settingsQuery.error.message} action={<Button variant="ghost" onClick={() => void settingsQuery.refetch()}>Retry</Button>} /></PageCanvas>;
  }
  if (!settingsValue || !draft) {
    return <PageCanvas><EmptyState icon={<ThinkingIndicator />} title="Opening your GitSpace account…" description="Loading cloud settings." /></PageCanvas>;
  }
  const reads = [
    ['Account settings', settingsQuery], ['OMP settings', ompQuery], ['Git identity', gitIdentityQuery], ['Machines', machinesQuery],
    ['Devices', devicesQuery], ['Source', settingsDeploymentQuery], ['Composio setup', composioSetupQuery], ['Browser relay', browserRelayQuery],
    ['Projects', productProjectsQuery], ['Models', modelsQuery],
  ] as const;
  const page = (mode: 'settings' | 'onboarding') => <>
    {reads.map(([label, query]) => query.state === 'failure' ? <p key={label} role="alert" className="px-8 py-1 text-caption text-destructive">{label}: {query.error.message}<Button variant="ghost" size="compact" onClick={() => void query.refetch()}>Retry</Button></p> : null)}
    <SettingsPage
    mode={mode}
    settings={draft}
    machines={machinesValue ?? []}
    ompSettings={settingsOmpValue.schema}
    models={modelsValue?.models ?? []}
    ompGeneration={settingsOmpValue.document.generation}
    providers={providersSection}
    ompSync={settingsOmpValue.sync}
    gitIdentity={settingsGitIdentityValue}
    onChange={(next) => {
      setDraft(next);
      // Appearance is a toggle, not a form field: previewing without saving
      // would snap back on reload, so it persists as soon as it changes.
      if (draft && next.defaults.appearance !== draft.defaults.appearance) void saveSettings(next).catch(() => undefined);
    }}
    onSave={saveSettings}
    onSetOmpSetting={updateOmp}
    onUpdateMachine={saveMachineNotes}
    onCreateSandbox={createSandbox}
    onControlMachine={controlMachine}
    onDestroyMachine={removeMachine}
    deployment={settingsDeploymentValue ?? null}
    onRevertDeployment={revertToChannel}
    devices={devicesValue ?? null}
    onRevokeDevice={revokeDeviceAndRefresh}
    onSignOut={signOutThisBrowser}
    onCreateApiClient={mintApiClient}
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
    onStopBrowserRelay={() => runBrowserRelay('stop')}
    onTestBrowserRelay={() => runBrowserRelay('test')}
    projects={(productProjectsValue ?? []).map((project) => ({ id: project.id, name: project.name }))}
    onBack={() => navigateProduct(optionalQueryParameter('project') ? 'agent' : 'projects', 'replace')}
    onComplete={completeOnboarding}
    saving={ensureStarterProject.state === 'pending' || updateSettings.state === 'pending' || reserveHandle.state === 'pending' || setOmpSetting.state === 'pending' || updateMachineNotes.state === 'pending' || createSandboxMachine.state === 'pending' || sleepMachine.state === 'pending' || resumeMachine.state === 'pending' || destroyMachine.state === 'pending' || revertDeployment.state === 'pending'}
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

function useAccountWorkActions(account: NonNullable<ContextType<typeof AccountDirectoryContext>>): AccountWorkActions {
  const openingSpaces = useRef(new Map<string, Promise<void>>());
  const uncertainOpenings = useRef(new Set<string>());

  const inspectTarget = async (spaceId: string): Promise<InspectorBootstrapView> => {
    const project = account.projects.find((candidate) => candidate.id === spaceId || account.directory[candidate.id]?.workspaces.some((workspace) => workspace.id === spaceId));
    if (!project) throw new Error('This workspace is no longer in the account directory. Refresh before retrying.');
    return configurationResult(rpcClient.inspector.bootstrap({ projectId: project.id, workspaceId: spaceId === project.id ? null : spaceId }));
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
      await mutate(rpcClient.space.close({ spaceId, expectedGeneration: canonical.placement.generation }));
    },
    onReopenSpace: (spaceId) => claimSpace(spaceId, null),
    onClaimWorkspace: claimSpace,
    onArchiveWorkspace: async (spaceId) => {
      const canonical = await inspectTarget(spaceId);
      await mutate(rpcClient.workspace.archive({
        projectId: canonical.workspace.projectId, spaceId,
        expectedRevision: canonical.workspace.revision, expectedGeneration: canonical.placement?.generation ?? null,
      }));
    },
    onArchiveProject: async (projectId, expectedRevision) => { await mutate(rpcClient.project.archive({ projectId, expectedRevision })); },
    onRestoreProject: async (projectId, expectedRevision) => { await mutate(rpcClient.project.restore({ projectId, expectedRevision })); },
    onDeleteProject: async (projectId, expectedRevision) => { await mutate(rpcClient.project.delete({ projectId, expectedRevision })); },
    onDeleteWorkspace: async (workspaceId) => { await mutate(rpcClient.workspace.delete({ workspaceId })); },
    onSetWorkspaceRelations: async (workspaceId, relations) => {
      await mutate(rpcClient.workspace.setRelations({ workspaceId, dependsOn: [...relations.dependsOn], relatedTo: [...relations.relatedTo], stackedOn: relations.stackedOn }));
    },
  } satisfies ComponentProps<typeof AccountWorkPages>['actions'];
  return actions;
}

function AccountWork({ view }: { view: 'kanban' | 'projects' | 'inbox' }) {
  const account = useContext(AccountDirectoryContext);
  const actions = useContext(AccountWorkActionsContext);
  if (!account || !actions) throw new Error('Account work pages require the account directory and actions');
  return <AccountWorkPages view={view} projects={account.projects} directory={account.directory} loading={account.loading} onRefresh={account.refresh} onOpenWorkspace={selectInspection} onOpenProject={(projectId) => selectInspection(projectId, null)} actions={actions} />;
}

function AccountConfiguration({ view }: { view: ConfigurationView }) {
  const projects = useAccountProjects();
  const read = useRetainedRead(projects, 'projects');
  const values = read.value ?? [];
  return <>
    {read.initialLoading ? <p role="status" className="px-8 pt-4 text-caption text-muted-foreground">Loading projects for assignments…</p> : null}
    {read.error ? <p role="alert" className="px-8 pt-4 text-caption text-destructive">Project assignments: {read.error.message}<Button variant="ghost" onClick={() => void projects.refetch()}>Retry projects</Button></p> : null}
    {view === 'skills' ? <AccountSkills projects={values} />
      : view === 'plugins' ? <AccountPlugins projects={values} />
        : view === 'secrets' ? <ProjectSecretsPage {...accountSecretsApi} projects={values} />
          : <AccountCrons projects={values} projectsLoading={read.initialLoading} />}
  </>;
}

function AccountSkills({ projects }: { projects: readonly ConfigurationProject[] }) {
  const skills = useResultQuery(rpcClient.skills.list, {});
  const read = useRetainedRead(skills, 'skills');
  return <><div className="flex justify-end px-8 pt-4"><Button variant="ghost" onClick={() => void skills.refetch()} disabled={read.initialLoading || read.refreshing}>Refresh skills</Button></div><SkillsPage projects={projects} skills={read.value ?? []} loading={read.initialLoading} error={read.error?.message ?? null} update={(skill, changes) => configurationResult(rpcClient.skills.update({ update: { id: skill.id, expectedRevision: skill.revision, ...changes } }))} /></>;
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
    }).catch((error: unknown) => { if (!cancelled) { if (invalidatesRead(error)) setGrants([]); setGrantError(error instanceof Error ? error.message : String(error)); } }).finally(() => { if (!cancelled) setGrantsLoading(false); });
    return () => { cancelled = true; };
  }, [projectKey, refreshToken]);
  const refresh = async (): Promise<void> => {
    await Promise.all([connections.refetch(), catalog.refetch()]);
    setRefreshToken((current) => current + 1);
  };
  const errors = [connections.state === 'failure' ? connections.error.message : null, catalog.state === 'failure' ? catalog.error.message : null, grantError, machines.state === 'failure' ? `Machine directory: ${machines.error.message}` : null].filter(Boolean).join(' · ');
  return <PluginsPage
    projects={projects}
    connections={connectionRead.value ?? []}
    grants={grants.filter((grant) => projects.some((project) => project.id === grant.projectId))}
    machines={(machineValues ?? []).map((machine) => ({ id: machine.id, label: machine.label, state: machine.desiredState === 'online' && machine.rpcEndpoint ? machine.state : 'offline' }))}
    composioCatalog={catalogRead.value ?? { configured: false, toolkits: [] }}
    loading={connectionRead.initialLoading}
    catalogLoading={catalogRead.initialLoading}
    catalogError={catalog.state === 'failure' ? catalog.error.message : undefined}
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
    onUpdateComposioTools={async (connectionId, expectedRevision, allowedTools) => { await configurationResult(rpcClient.mcp.composio.updateTools({ connectionId, expectedRevision, allowedTools })); await refresh(); }}
    onDisconnectComposio={async (connectionId, expectedRevision) => { await configurationResult(rpcClient.mcp.composio.disconnect({ connectionId, expectedRevision })); await refresh(); }}
    onRefresh={refresh}
    onDiscover={async (projectId, machineId) => {
      const machine = machines.state === 'success' ? machines.value.find((candidate) => candidate.id === machineId) : null;
      if (!machine?.rpcEndpoint || machine.state !== 'online' || machine.desiredState !== 'online') throw new Error('Choose an online machine for runtime diagnostics.');
      return configurationResult(createGitSpaceBrowserClient({ url: machine.rpcEndpoint }).mcp.discover({ projectId }));
    }}
  />;
}

function AccountCrons({ projects, projectsLoading }: { projects: readonly ConfigurationProject[]; projectsLoading: boolean }) {
  const [crons, setCrons] = useState<ProjectCronView[]>([]);
  const [targets, setTargets] = useState<ProjectCronTargetOption[]>([]);
  const [holders, setHolders] = useState<Record<string, string>>({});
  const savedCrons = useRef(new Map<string, readonly ProjectCronView[]>());
  const savedContexts = useRef(new Map<string, InspectorBootstrapView>());
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
          failures.push(`${project.name} schedules: ${cause instanceof Error ? cause.message : String(cause)}`);
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
          const value = await configurationResult(rpcClient.inspector.bootstrap({ projectId: project.id, workspaceId: null }));
          if (!cancelled) savedContexts.current.set(project.id, value);
          return value;
        } catch (cause) {
          failures.push(`${project.name} workspace targets: ${cause instanceof Error ? cause.message : String(cause)}`);
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
  return <DeviceGate><ResultRpcProvider client={rpcClient}><SynchronizationProvider><AccountFrame><AccountProductRoute /></AccountFrame></SynchronizationProvider></ResultRpcProvider></DeviceGate>;
}
