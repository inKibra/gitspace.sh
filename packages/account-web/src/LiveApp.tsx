import { reduceTranscriptToTurns, type TransportBlock, type TurnBlock } from '@gitspace/blocks';
import type { DeploymentStatusView, EnvironmentBundle as ProtocolEnvironmentBundle, LaunchProgressView, OmpSettingValue, ProviderLoginEvent, ReleaseTarget, RepositoryDiffView, RepositoryFileView, RepositoryMode, UserSettings } from '@gitspace/protocol';
import { executionHash } from '@gitspace/protocol';
import type { ProjectMcpGrantRpcView } from '@gitspace/protocol/mcp-contract';
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, InputField, InputGroup, ScrollArea, Select, SelectContent, SelectItem, SelectTrigger, SidebarInset, SidebarInsetTopbar, SidebarProvider, ThinkingIndicator, Tooltip } from '@gitspace/ui';
import { LayoutRight, Terminal } from '@untitledui/icons';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ResultRpcProvider, useResultMutation, useResultQuery } from 'result-rpc/react';
import { EmptyState, GitSpaceShell, PageCanvas, PageHeader, ProjectsView, type GitSpaceShellProps, type ProviderAuthView, type SpaceHolderView } from './GitSpaceShell.js';
import { LaunchSheet, LaunchedBanner, LAUNCHED_STORAGE_KEY, readLaunchedMark, type LaunchedMark } from './LaunchSheet.js';
import { createGitSpaceBrowserClient, homeRpcUrl, routedTransport, rpcClient } from './rpc-client.js';
import { currentDevice, DEVICE_REJECTED_EVENT, deviceRejected, setCurrentDevice } from './device-session.js';
import { createApiClient, enrollDevice, type ApiClientDraft, type BrowserDevice } from './device.js';
import { applyAppearance } from './appearance.js';
import type { ProviderLoginFlow, ProvidersSectionProps } from './ProvidersSection.js';
import { SettingsPage } from './SettingsPage.js';
import { EnvironmentView } from './environment/EnvironmentView.js';
import type { EnvironmentViewModel, LifecyclePhase, LifecycleRun, TrustState } from './environment/types.js';
import { lifecycleSummary } from './environment/lifecycle.js';
import { Inspector } from './inspector/index.js';
import { appendLaunchProgress, converging, launchTrackFrom, RELEASE_TARGETS, shortSha, type LaunchTrack } from './release.js';
import { ACCOUNT_DIRECTORY_CHANGED, navigateProductUrl, productRouteFromLocation, setProductRoute, type AppView, type ProductRoute } from './routes.js';
import { AccountSidebarContext, AppSidebar, type AppSidebarProps, type SidebarProject } from './AppSidebar.js';
import { TurnTranscript } from './TurnTranscript.js';
import { accountHandleFromUrl, browserInvitationStatus, canConnectBrowser, cancelBrowserInvitation, createBrowserInvitation, enrollmentTokenForLocation, recoverAccountBrowser } from './browser-enrollment.js';
import { AccountConnectPage } from './AccountConnectPage.js';

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

const HEALTH_GATE_INTERVAL_MS = 1_000;
const HEALTH_GATE_TIMEOUT_MS = 90_000;
/**
 * `code-version` means the frontend generation is already swapped; machine
 * and OMP targets may still be converging through the stable host.
 */
async function awaitMachineSwap(target: 'machine' | 'omp' | null, sha: string | null): Promise<boolean> {
  const deadline = Date.now() + HEALTH_GATE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const health = await fetchMachineHealth();
    const running = target === 'omp' ? health?.ompRelease : health?.machineRelease;
    if (health && (target === null || sha === null || running === sha)) return true;
    const tick = Promise.withResolvers<void>();
    setTimeout(tick.resolve, HEALTH_GATE_INTERVAL_MS);
    await tick.promise;
  }
  return false;
}
const CONNECTION_RECOVERY_DELAYS_MS = [0, 250, 500, 1_000, 2_000, 4_000, 5_000, 5_000] as const;

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
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void query.refetch(); }, 5_000);
    return () => clearInterval(timer);
  }, [spaceId]);
  if (query.state !== 'success') return null;
  const state = query.value.lifecycle;
  const configured = state.bundleJson !== null || query.value.executions.length > 0;
  const summary = lifecycleSummary(state);
  return <span className="flex min-w-0 items-center gap-1">
    <Button variant="ghost" size="compact" className={`min-h-10 max-w-48 truncate ${summary.attention ? 'text-destructive' : 'text-muted-foreground'}`} onClick={onInspect}>{summary.label}</Button>
    {!configured && onConfigure ? <Button variant="ghost" size="compact" className="min-h-10" loading={pending} onClick={() => { setPending(true); setError(null); void onConfigure().catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause))).finally(() => setPending(false)); }}>Configure with agent</Button> : null}
    {error ? <span role="alert" className="max-w-64 truncate text-caption text-destructive" title={error}>{error}</span> : null}
  </span>;
}

function LiveEnvironment({ projectName, workspaceName, spaceId, workspace, generation, machineId, runtimeAvailable, onAskAgent }: { projectName: string; workspaceName: string; spaceId: string; workspace: boolean; generation: number; machineId?: string; runtimeAvailable: boolean; onAskAgent?: (text: string) => Promise<void> }) {
  const query = useResultQuery(rpcClient.environment.get, { spaceId });
  const machines = useResultQuery(rpcClient.machines, {}, { enabled: !runtimeAvailable });
  const [runnerId, setRunnerId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [readingEvidence, setReadingEvidence] = useState(false);
  const [evidence, setEvidence] = useState<{ title: string; output: string; approvalHash?: string; runId?: string; nextOffset?: number | null } | null>(null);
  useEffect(() => {
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void query.refetch(); }, 3_000);
    return () => clearInterval(timer);
  }, [spaceId]);
  if (query.state === 'pending') return <p className="p-4 text-caption text-muted-foreground" role="status">Loading environment…</p>;
  if (query.state === 'failure') return <div className="flex flex-col gap-2 p-4"><p role="alert" className="text-caption text-destructive">{query.error.message}</p><Button variant="ghost" size="compact" onClick={() => void query.refetch()}>Retry environment</Button></div>;
  const runners = machines.state === 'success' ? machines.value.filter((candidate) => candidate.state === 'online' && candidate.desiredState === 'online' && candidate.rpcEndpoint) : [];
  const runner = runners.find((candidate) => candidate.id === runnerId) ?? runners[0];
  const remote = query.value;
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
  const openRunLog = (runId: string, offset: number | null = null): void => loadEvidence(async () => {
    const result = await rpcClient.environment.runLog({ spaceId, runId, offset });
    if (result.status === 'error') throw result.error;
    setEvidence((current) => ({ title: `Run ${runId}`, runId, output: offset !== null && current?.runId === runId ? current.output + result.value.output : result.value.output, nextOffset: result.value.nextOffset }));
  });
  const openSecrets = (): void => {
    navigateProductUrl(setProductRoute(new URL(window.location.href), 'secrets'));
  };
  const lastRun = (executionHash: string, executionId: string): LifecycleRun => {
    const run = remote.lifecycle.runs.find((candidate) => candidate.executionHashes.includes(executionHash));
    if (!run) return { status: 'never' };
    if (run.status === 'running') return { status: 'running', relativeTime: new Date(run.startedAt).toLocaleString(), output: run.output };
    const startedAt = new Date(run.startedAt).getTime();
    const finishedAt = new Date(run.finishedAt ?? run.startedAt).getTime();
    const output = run.results.find((result) => result.id === executionId)?.output ?? run.output;
    const relativeTime = new Date(run.finishedAt ?? run.startedAt).toLocaleString();
    const duration = `${Math.max(0, finishedAt - startedAt)}ms`;
    return run.status === 'failed' || run.status === 'abandoned'
      ? { status: 'failed', relativeTime, duration, output: output || `Exited ${run.exitCode ?? 1}` }
      : { status: 'succeeded', relativeTime, duration, ...(output ? { output } : {}) };
  };
  const latestChecks = remote.lifecycle.runs.find((run) => run.phase === 'checks' && run.machineId === machineId && run.profile === remote.selectedProfile && run.status !== 'running');
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
        return [item.id, result ? { status: result.exitCode === 0 ? 'pass' as const : 'fail' as const, output: result.output || `Exited ${result.exitCode}` } : { status: 'unprobed' as const }];
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
    ledger: remote.lifecycle,
    configured: remote.lifecycle.bundleJson !== null || remote.executions.length > 0,
    migrationRequired: remote.migrationRequired,
    secrets: remote.effective.secrets.map((name) => ({ name, source: 'project', granted: remote.configuredSecrets.includes(name), requiredBy: [remote.selectedProfile] })),
    inputValues: Object.entries(remote.values.effective).map(([name, value]) => ({ name, value, source: name in remote.values.workspace ? 'workspace' : 'project' })),
  };
  const updateProfile = (transform: (profile: ProtocolEnvironmentBundle['profiles'][string]) => ProtocolEnvironmentBundle['profiles'][string]): ProtocolEnvironmentBundle => ({
    ...bundle,
    profiles: { ...bundle.profiles, [remote.selectedProfile]: transform(bundle.profiles[remote.selectedProfile]!) },
  });
  return <div className="flex min-h-0 flex-1 flex-col">
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
      onRunChecks={() => mutate(async () => { const result = await rpcClient.environment.runChecks({ spaceId }); if (result.status === 'error') throw result.error; })}
      onOpenLifecycleOutput={(scriptId) => { const execution = remote.executions.find((item) => item.id === scriptId); const run = execution && remote.lifecycle.runs.find((item) => item.executionHashes.includes(execution.hash)); if (run) openRunLog(run.id); }}
      onRunLifecycle={(phase: LifecyclePhase, options) => mutate(async () => {
        if (phase === 'cloud/destroy' && !options?.retire) throw new Error('Explicit human retirement confirmation is required.');
        const client = runtimeAvailable ? rpcClient : runner?.rpcEndpoint ? createGitSpaceBrowserClient({ url: runner.rpcEndpoint }) : null;
        if (!client) throw new Error('Choose an online cloud lifecycle runner.');
        if (!runtimeAvailable && phase !== 'cloud/destroy') throw new Error('Open the workspace before requesting setup or local preparation.');
        const result = await client.environment.runPhase({ spaceId, phase, rerun: options?.rerun ?? null });
        if (result.status === 'error') throw result.error;
      })}
    />
    <Dialog open={evidence !== null} onOpenChange={(open) => { if (!open) setEvidence(null); }}>
      <DialogContent size="sm"><DialogHeader><DialogTitle>{evidence?.approvalHash ? 'Review exact execution content' : evidence?.title}</DialogTitle><DialogDescription>{evidence?.approvalHash ? 'Approves only this content hash. Editing a script requires a new approval; this does not run it or authorize retirement.' : 'Saved lifecycle evidence. Logs remain available after a checkout is removed.'}</DialogDescription></DialogHeader>
        {evidence?.approvalHash ? <code className="break-all font-mono text-caption text-muted-foreground">{evidence.approvalHash}</code> : null}
        <pre className="max-h-[55vh] overflow-auto whitespace-pre-wrap break-words font-mono text-caption">{evidence?.output || 'No output recorded.'}</pre>
        {actionError ? <p role="alert" className="text-caption text-destructive">{actionError}</p> : null}
        <DialogFooter><Button variant="secondary" onClick={() => setEvidence(null)}>Close</Button>{evidence?.runId && evidence.nextOffset != null ? <Button variant="ghost" loading={readingEvidence} onClick={() => openRunLog(evidence.runId!, evidence.nextOffset!)}>Load more</Button> : null}{evidence?.approvalHash ? <Button variant="primary" disabled={busy} onClick={() => mutate(async () => { const result = await rpcClient.environment.approve({ spaceId, scope: workspace ? 'workspace' : 'project', executionHash: evidence.approvalHash! }); if (result.status === 'error') throw result.error; setEvidence(null); })}>Approve this content</Button> : null}</DialogFooter>
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
  onAskAgent,
  initialView,
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
  onAskAgent?: (text: string) => Promise<void>;
  initialView?: 'environment';
}) {
  const request = { spaceId, expectedGeneration: generation };
  const overview = useResultQuery(rpcClient.inspector.overview, request);
  const artifactCatalog = useResultQuery(rpcClient.inspector.artifacts.list, request);
  const [secondaryQueries, setSecondaryQueries] = useState({ repository: false, journal: false, threads: false, services: false });
  const repository = useResultQuery(rpcClient.inspector.repository.tree, { ...request, mode: 'current', path: null }, { enabled: runtimeAvailable && secondaryQueries.repository });
  const journal = useResultQuery(rpcClient.inspector.journal.list, request, { enabled: secondaryQueries.journal });
  const threads = useResultQuery(rpcClient.inspector.review.list, request, { enabled: secondaryQueries.threads });
  const services = useResultQuery(rpcClient.inspector.services.list, request, { enabled: runtimeAvailable && secondaryQueries.services });
  const [usageRequested, setUsageRequested] = useState(false);
  const usage = useResultQuery(rpcClient.session.usage, { sessionId: sessionId ?? '' }, { enabled: runtimeAvailable && usageRequested && sessionId !== null });
  const stackedOn = scope?.kind === 'workspace' ? scope.relations.stackedOn : null;
  const stackStatus = useResultQuery(rpcClient.workspace.stackStatus, { workspaceId: spaceId }, { enabled: runtimeAvailable && stackedOn !== null && scope?.kind === 'workspace' && !scope.closedAt });
  const [repositoryFile, setRepositoryFile] = useState<RepositoryFileView | null>(null);
  const [repositoryDiff, setRepositoryDiff] = useState<RepositoryDiffView | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const lastRefreshToken = useRef(refreshToken);
  const subagents = useMemo(() => {
    const byAgent = new Map<string, TurnBlock['sideAgents'][number]>();
    for (const agent of turns.flatMap((turn) => turn.sideAgents)) byAgent.set(agent.agentId, agent);
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
    if (refreshToken === 0 || refreshToken === lastRefreshToken.current) return;
    lastRefreshToken.current = refreshToken;
    void (async () => {
      await overview.refetch();
      await journal.refetch();
      await threads.refetch();
      await artifactCatalog.refetch();
      if (runtimeAvailable) {
        await repository.refetch();
        await services.refetch();
        if (stackedOn !== null) await stackStatus.refetch();
      }
    })().catch((error: unknown) => setActionError(error instanceof Error ? error.message : String(error)));
  }, [refreshToken]);

  useEffect(() => {
    if (runtimeAvailable) return;
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void artifactCatalog.refetch(); }, 5_000);
    return () => clearInterval(timer);
  }, [runtimeAvailable, spaceId]);

  if (overview.state === 'pending') {
    return <div className="flex h-full flex-col items-center justify-center gap-2 p-6" aria-label="Workspace Inspector"><ThinkingIndicator /><span className="text-body text-muted-foreground">Loading Inspector authority state…</span></div>;
  }
  if (overview.state === 'failure') {
    return <div className="flex h-full flex-col items-center justify-center gap-2 p-6" aria-label="Workspace Inspector"><EmptyState title="Inspector could not load" description={overview.error.message} action={<Button variant="ghost" type="button" onClick={onClose}>Close</Button>} /></div>;
  }

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
  const queryError = actionError
    ?? (journal.state === 'failure' ? journal.error.message : null)
    ?? (threads.state === 'failure' ? threads.error.message : null)
    ?? (services.state === 'failure' ? services.error.message : null)
    ?? (repository.state === 'failure' ? repository.error.message : null);
  const artifactReferences = artifactCatalog.state === 'success' ? artifactCatalog.value.artifacts.map((artifact) => ({
    kind: 'artifact' as const, url: artifact.url, hash: artifact.hash, label: artifact.path,
    mediaType: artifact.mediaType,
    generation: artifactCatalog.value.scopes.find((scope) => scope.workspaceId === (artifact.workspaceId ?? projectId))?.generation ?? 0,
  })) : [];

  return <Inspector
    overview={overview.value}
    runtimeAvailable={runtimeAvailable}
    initialView={initialView}
    scope={scope}
    workspaces={workspaces}
    environment={<LiveEnvironment projectName={scope?.projectName ?? projectId} workspaceName={scope?.name ?? spaceId} spaceId={spaceId} workspace={spaceId !== projectId} generation={generation} machineId={scope?.holder.kind === 'held' ? scope.holder.machineId : undefined} runtimeAvailable={runtimeAvailable} onAskAgent={onAskAgent} />}
    onSelectWorkspace={onSelectWorkspace}
    onSetRelations={onSetRelations}
    stackStatus={stackStatus.state === 'success' ? stackStatus.value : null}
    repositoryEntries={repository.state === 'success' ? repository.value : []}
    repositoryFile={repositoryFile}
    repositoryDiff={repositoryDiff}
    journalEntries={journal.state === 'success' ? journal.value : []}
    artifactReferences={artifactReferences}
    artifactActions={artifactCatalog.state === 'success' ? {
      projectFiles: artifactCatalog.value.artifacts.filter((artifact) => artifact.scope === 'base').map(({ path, hash }) => ({ path, hash })),
      copy: async (files) => {
        try {
          const result = await rpcClient.inspector.artifacts.copyToProject({ ...request, files, expectedProjectGeneration: artifactCatalog.value.scopes.find((scope) => scope.workspaceId === projectId)?.generation ?? 0 });
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
    threads={threads.state === 'success' ? threads.value : []}
    services={services.state === 'success' ? services.value : []}
    subagents={subagents}
    usage={{
      sessionId,
      report: usage.state === 'success' ? usage.value : null,
      status: !usageRequested || sessionId === null ? 'idle' : usage.state === 'pending' ? 'loading' : usage.state === 'success' ? 'ready' : 'error',
      ...(usage.state === 'failure' ? { error: usage.error.message } : {}),
      load: () => setUsageRequested(true),
      refresh: () => { if (usageRequested) void usage.refetch(); else setUsageRequested(true); },
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
    onSubmitHumanJudgment={overview.value.rubric ? async (criterionId, verdict, summary) => {
      const result = await rpcClient.inspector.rubric.appendJudgment({
        expectedGeneration: generation,
        input: {
          projectId,
          spaceId,
          expectedRevision: overview.value.rubric!.revision,
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
  />;
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

/** The account frame survives settings, machine availability, and every pane replacement. */
function AccountFrame({ children }: { children: ReactNode }) {
  const location = useProductLocation();
  const route = productRouteFromLocation(location);
  const projects = useResultQuery(rpcClient.project.list, { lifecycle: 'all' });
  const settings = useResultQuery(rpcClient.settings.get, {});
  const [runtimeSidebar, setRuntimeSidebar] = useState<AppSidebarProps | null>(null);
  const [directory, setDirectory] = useState<Record<string, Pick<SidebarProject, 'workspaces' | 'error'>>>({});
  const projectId = location.searchParams.get('project');
  const workspaceId = location.searchParams.get('workspace');
  const projectValues = projects.state === 'success' ? projects.value : projects.state === 'failure' ? projects.previous ?? [] : [];
  const selectedProject = projectValues.find((project) => project.id === projectId);
  const directoryEnabled = selectedProject !== undefined && selectedProject.lifecycle !== 'cloud-only';
  // Match the inspection pane's query key so its saved context is read only once.
  const context = useResultQuery(rpcClient.inspector.bootstrap, { projectId: projectId ?? '', workspaceId }, { enabled: directoryEnabled });
  useEffect(() => {
    const changed = () => { void projects.refetch(); if (directoryEnabled) void context.refetch(); };
    window.addEventListener(ACCOUNT_DIRECTORY_CHANGED, changed);
    return () => window.removeEventListener(ACCOUNT_DIRECTORY_CHANGED, changed);
  }, [projectId, workspaceId, directoryEnabled]);
  useEffect(() => {
    if (!projectId || !directoryEnabled) return;
    if (context.state === 'success' && context.value.project.id === projectId) {
      const workspaces = context.value.workspaces.filter((workspace) => workspace.kind !== 'base').map((workspace) => ({ id: workspace.id, projectId: workspace.projectId, name: workspace.name, branch: workspace.branch, closedAt: workspace.archivedAt ? new Date(workspace.archivedAt) : null }));
      setDirectory((current) => ({ ...current, [projectId]: { workspaces, error: null } }));
    } else if (context.state === 'failure') {
      setDirectory((current) => ({ ...current, [projectId]: { workspaces: current[projectId]?.workspaces ?? [], error: context.error.message } }));
    }
  }, [projectId, directoryEnabled, context.state, context.state === 'success' ? context.value : null, context.state === 'failure' ? context.error.message : null]);
  const live = runtimeSidebar?.selected?.projectId === projectId ? runtimeSidebar : null;
  const sidebarProjects: SidebarProject[] = projectValues.map((project) => {
    const runtime = live?.projects.find((candidate) => candidate.id === project.id);
    const saved = directory[project.id];
    const workspaces = new Map((saved?.workspaces ?? []).map((workspace) => [workspace.id, workspace]));
    for (const workspace of runtime?.workspaces ?? []) workspaces.set(workspace.id, workspace);
    return { id: project.id, name: project.name, lifecycle: project.lifecycle, base: runtime?.base, workspaces: [...workspaces.values()], error: saved?.error };
  });
  const navigate = (view: ProductRoute, section?: 'source'): void => {
    const url = setProductRoute(new URL(window.location.href), view);
    if (section) url.searchParams.set('section', section);
    else url.searchParams.delete('section');
    navigateProductUrl(url);
  };
  return <AccountSidebarContext.Provider value={setRuntimeSidebar}>
    <SidebarProvider className="gitspace-shell" persist={false}>
      <AppSidebar {...live} view={route} onView={navigate} selected={projectId ? { projectId, workspaceId } : null} projects={sidebarProjects} machines={live?.machines ?? []} onSelectProject={(id) => selectInspection(id, null)} onSelectWorkspace={(workspace) => selectInspection(workspace.projectId, workspace.id)} onOpenSettings={(section) => navigate('settings', section)} user={settings.state === 'success' ? { name: settings.value.profile.displayName, handle: settings.value.profile.handle } : undefined} />
      <SidebarInset className="min-w-0 overflow-hidden">
        {!live ? <SidebarInsetTopbar><span className="truncate text-body font-medium">{route === 'settings' ? 'Account settings' : projectValues.find((project) => project.id === projectId)?.name ?? 'Your account'}</span></SidebarInsetTopbar> : null}
        {projects.state === 'failure' ? <div role="alert" className="flex items-center gap-2 px-4 py-2 text-caption text-destructive"><span>Project directory: {projects.error.message}</span><Button variant="ghost" size="compact" onClick={() => void projects.refetch()}>Retry</Button></div> : null}
        {children}
      </SidebarInset>
    </SidebarProvider>
  </AccountSidebarContext.Provider>;
}

type LiveWorkspaceProps = { onOpenSettings: (section?: 'source') => void; defaultMachineId: string | null; activeView: AppView; onNavigateView: (view: AppView) => void; user: { name: string; handle: string | null }; providers: readonly ProviderAuthView[] };

function selectInspection(projectId: string, workspaceId: string | null): void {
  const url = new URL(window.location.href);
  url.searchParams.set('project', projectId);
  if (workspaceId) url.searchParams.set('workspace', workspaceId);
  else url.searchParams.delete('workspace');
  navigateProductUrl(setProductRoute(url, 'agent'));
}

function LiveWorkspace(props: LiveWorkspaceProps) {
  const location = useProductLocation();
  const projects = useResultQuery(rpcClient.project.list, { lifecycle: 'all' });
  const projectId = location.searchParams.get('project') ?? '';
  const workspaceId = location.searchParams.get('workspace');
  const availability = useResultQuery(rpcClient.inspector.availability, { projectId, workspaceId }, { enabled: projectId.length > 0 });
  useEffect(() => {
    const changed = () => { void projects.refetch(); if (projectId) void availability.refetch(); };
    window.addEventListener(ACCOUNT_DIRECTORY_CHANGED, changed);
    return () => window.removeEventListener(ACCOUNT_DIRECTORY_CHANGED, changed);
  }, [projectId, workspaceId]);
  if (projects.state === 'failure') return <PageCanvas><EmptyState title="Project directory unavailable" description={projects.error.message} action={<Button variant="ghost" onClick={() => void projects.refetch()}>Retry</Button>} /></PageCanvas>;
  if (projects.state !== 'success') return <PageCanvas><EmptyState icon={<ThinkingIndicator />} title="Loading projects…" description="Reading your account without starting a machine." /></PageCanvas>;
  if (projectId && availability.state === 'success' && availability.value.runtimeAvailable) return <RunningWorkspace key={`${projectId}:${workspaceId ?? ''}`} {...props} projectId={projectId} workspaceId={workspaceId} />;
  if (props.activeView === 'projects' || (!projectId && props.activeView === 'agent')) return <ProjectsView
    projects={projects.value}
    onOpen={(workspace) => selectInspection(workspace.projectId, workspace.id)}
    onOpenProject={(id) => selectInspection(id, null)}
    onCreateProject={async (input) => {
      const result = await rpcClient.project.create(input);
      if (result.status === 'error') throw result.error;
      refreshInspection();
      selectInspection(result.value.project.id, null);
    }}
    onArchiveProject={async (id, expectedRevision) => {
      const result = await rpcClient.project.archive({ projectId: id, expectedRevision });
      if (result.status === 'error') throw result.error;
      refreshInspection();
    }}
    onRestoreProject={async (id, expectedRevision) => {
      const result = await rpcClient.project.restore({ projectId: id, expectedRevision });
      if (result.status === 'error') throw result.error;
      refreshInspection();
    }}
    onDeleteProject={async (id, expectedRevision) => {
      const result = await rpcClient.project.delete({ projectId: id, expectedRevision });
      if (result.status === 'error') throw result.error;
      refreshInspection();
    }}
  />;
  const selectedProject = projects.value.find((project) => project.id === projectId);
  if (props.activeView !== 'agent') return <PageCanvas><PageHeader title={props.activeView.charAt(0).toUpperCase() + props.activeView.slice(1)} /><EmptyState title="No workspace is open" description="Choose a project to inspect its cloud records. Machine tools become available after you explicitly open a workspace on a machine." action={selectedProject ? <Button variant="secondary" onClick={() => selectInspection(projectId, workspaceId)}>View selected project</Button> : undefined} /></PageCanvas>;
  if (!selectedProject) return <PageCanvas><EmptyState title="Project not found" description="Choose another project from your account sidebar." /></PageCanvas>;
  if (selectedProject.lifecycle === 'cloud-only') return <CloudOnlyProject key={projectId} project={selectedProject} defaultMachineId={props.defaultMachineId} onOpenSettings={props.onOpenSettings} />;
  if (availability.state === 'failure') return <PageCanvas><EmptyState title="Workspace availability unavailable" description={availability.error.message} action={<Button variant="ghost" onClick={() => void availability.refetch()}>Retry</Button>} /></PageCanvas>;
  if (availability.state !== 'success') return <PageCanvas><EmptyState icon={<ThinkingIndicator />} title="Loading workspace…" description="Checking cloud workspace availability without starting a machine." /></PageCanvas>;
  return <OfflineWorkspace key={`${projectId}:${workspaceId ?? ''}`} projectId={projectId} workspaceId={workspaceId} defaultMachineId={props.defaultMachineId} onOpenSettings={props.onOpenSettings} />;
}

function CloudOnlyProject({ project, defaultMachineId, onOpenSettings }: {
  project: { id: string; name: string; source: { release: string | null; branch: string | null; commit: string | null } | null };
  defaultMachineId: string | null;
  onOpenSettings: LiveWorkspaceProps['onOpenSettings'];
}) {
  const machines = useResultQuery(rpcClient.machines, {});
  const [chosen, setChosen] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const online = machines.state === 'success' ? machines.value.filter((machine) => machine.state === 'online' && machine.desiredState === 'online' && machine.rpcEndpoint) : [];
  const machine = online.find((machine) => machine.id === (chosen ?? defaultMachineId)) ?? online[0];
  const open = async (): Promise<void> => {
    if (!machine?.rpcEndpoint || pending) return;
    setPending(true); setError(null);
    try {
      const result = await createGitSpaceBrowserClient({ url: machine.rpcEndpoint }).project.open({ projectId: project.id });
      if (result.status === 'error') throw result.error;
      refreshInspection();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); setPending(false); }
  };
  return <main className="flex min-h-0 flex-1 flex-col bg-background">
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center gap-4 px-6">
      <h1 className="text-title font-semibold">{project.name}</h1>
      <p className="text-body text-muted-foreground">Your built-in GitSpace project is saved in the cloud. Opening it creates a checkout and project workspace on the machine you choose. Nothing runs until you open it.</p>
      <p className="break-all font-mono text-caption text-muted-foreground">Release {project.source?.release ?? 'not pinned'} · {project.source?.branch ?? 'HEAD'}{project.source?.commit ? ` · ${project.source.commit}` : ''}</p>
      {online.length ? <Select value={machine?.id ?? ''} onValueChange={setChosen} disabled={pending}><SelectTrigger aria-label="Open GitSpace on machine" /><SelectContent>{online.map((candidate, index) => <SelectItem value={candidate.id} index={index} key={candidate.id}>{candidate.label}</SelectItem>)}</SelectContent></Select> : <p className="text-body text-muted-foreground">Connect or start a machine in Account settings when you are ready. This project remains available without one.</p>}
      <div><Button variant="primary" disabled={!machine || pending} loading={pending} onClick={() => void open()}>Open GitSpace project</Button></div>
      <div><Button variant="ghost" onClick={() => onOpenSettings()}>Account settings</Button></div>
      {error || machines.state === 'failure' ? <p role="alert" className="text-caption text-destructive">{error ?? (machines.state === 'failure' ? machines.error.message : null)}</p> : null}
    </div>
  </main>;
}

function OfflineWorkspace({ projectId, workspaceId, defaultMachineId, onOpenSettings }: {
  projectId: string;
  workspaceId: string | null;
  defaultMachineId: string | null;
  onOpenSettings: LiveWorkspaceProps['onOpenSettings'];
}) {
  const context = useResultQuery(rpcClient.inspector.bootstrap, { projectId, workspaceId });
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [chosenMachineId, setChosenMachineId] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const [reviewerId, setReviewerId] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void currentDevice().then((device) => { if (!cancelled) setReviewerId(device?.deviceId ?? null); });
    return () => { cancelled = true; };
  }, []);
  const machines = context.state === 'success' ? context.value.machines : [];
  const onlineMachines = machines.filter((machine) => machine.state === 'online' && machine.desiredState === 'online' && machine.rpcEndpoint !== null);
  const machineId = [chosenMachineId, defaultMachineId, context.state === 'success' ? context.value.checkpoint?.lastMachineId : null, onlineMachines[0]?.id]
    .find((id) => id && onlineMachines.some((machine) => machine.id === id)) ?? null;
  const turns = useMemo(() => context.state === 'success' ? reduceTranscriptToTurns(context.value.savedTranscript.events) : [], [context.state, context.state === 'success' ? context.value.savedTranscript.events : null]);
  const openWorkspace = async (): Promise<void> => {
    if (context.state !== 'success' || !machineId || opening) return;
    setOpening(true);
    setOpenError(null);
    try {
      const machine = onlineMachines.find((candidate) => candidate.id === machineId)!;
      const client = createGitSpaceBrowserClient({ url: machine.rpcEndpoint! });
      const input = { spaceId: context.value.identity.spaceId, expectedGeneration: context.value.placement?.generation ?? 0 };
      const result = context.value.workspace.archivedAt ? await client.workspace.restore(input) : await client.space.reopen(input);
      if (result.status === 'error') throw result.error;
      refreshInspection();
    } catch (error) {
      setOpenError(error instanceof Error ? error.message : String(error));
      setOpening(false);
    }
  };
  const navigation = <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-4 py-3">
    {context.state === 'success' ? <span className="truncate text-body font-medium">{context.value.workspace.name}</span> : null}
    <div className="ml-auto flex items-center gap-1">
      <Tooltip content="Open this workspace on a machine first"><span><Button variant="ghost" size="icon-compact" aria-label="Open terminals" disabled><Terminal width={16} height={16} strokeWidth={1.5} /></Button></span></Tooltip>
      <Tooltip content="Inspector"><Button variant="ghost" size="icon-compact" aria-label="Open Inspector" aria-pressed={inspectorOpen} onClick={() => setInspectorOpen((open) => !open)}><LayoutRight width={16} height={16} strokeWidth={1.5} /></Button></Tooltip>
      <Button variant="ghost" size="compact" onClick={() => onOpenSettings()}>Account settings</Button>
    </div>
  </header>;
  if (context.state !== 'success') return <main className="flex min-h-0 flex-1 flex-col bg-background">{navigation}<div className="flex flex-1 items-center justify-center"><EmptyState icon={context.state === 'pending' ? <ThinkingIndicator /> : undefined} title={context.state === 'pending' ? 'Loading saved workspace…' : 'Cloud Inspector unavailable'} description={context.state === 'failure' ? context.error.message : 'Reading canonical workspace records without opening the workspace.'} action={context.state === 'failure' ? <Button variant="ghost" onClick={() => void context.refetch()}>Retry</Button> : undefined} /></div></main>;
  const saved = context.value;
  return <main className="flex min-h-0 flex-1 flex-col bg-background">{navigation}
    <div className="flex min-h-0 flex-1 max-md:flex-col">
      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex flex-col gap-2 px-6 py-4">
          <span className="text-caption text-muted-foreground">{saved.project.name} · {saved.workspace.branch}</span>
          <h1 className="text-title font-semibold">{saved.workspace.name}</h1>
          <p className="text-body text-muted-foreground">This workspace is not open on an online machine. Inspect cloud records without starting it.</p>
          {saved.checkpoint ? <p className="text-caption text-muted-foreground tabular-nums">Saved checkpoint · generation {saved.checkpoint.generation} · {new Date(saved.checkpoint.createdAt).toLocaleString()}{saved.checkpoint.lastMachineId ? ` · last on ${machines.find((machine) => machine.id === saved.checkpoint!.lastMachineId)?.label ?? saved.checkpoint.lastMachineId}` : ''}</p> : null}
          <div className="flex flex-wrap items-center gap-2">
            {onlineMachines.length ? <Select size="compact" value={machineId ?? ''} onValueChange={setChosenMachineId}><SelectTrigger aria-label="Open on machine" /><SelectContent>{onlineMachines.map((machine, index) => <SelectItem value={machine.id} index={index} key={machine.id}>{machine.label}</SelectItem>)}</SelectContent></Select> : null}
            <Tooltip content={machineId ? 'Open workspace on the selected machine' : 'Choose an online machine in Account settings'}><span><Button variant="secondary" size="compact" disabled={!machineId || opening} loading={opening} onClick={() => void openWorkspace()}>Open workspace</Button></span></Tooltip>
            <Button variant="ghost" size="compact" onClick={() => setInspectorOpen(true)}>Inspect workspace</Button>
          </div>
          {!onlineMachines.length ? <p className="text-caption text-muted-foreground">No online machines. Cloud Inspector remains available; manage machines in Account settings when you want to open this workspace.</p> : null}
          {openError ? <p role="alert" className="text-caption text-destructive">{openError}</p> : null}
        </div>
        <ScrollArea className="min-h-0 flex-1" viewportClassName="h-full">
          <h2 className="px-6 pb-2 text-caption font-medium text-muted-foreground">Saved transcript</h2>
          {saved.savedTranscript.status === 'available' ? <TurnTranscript turns={turns} transport={[]} /> : <div className="px-6 py-4"><EmptyState title={saved.savedTranscript.status === 'none' ? 'No saved transcript' : 'Saved transcript unavailable'} description={saved.savedTranscript.reason ?? 'No transcript has been saved for this workspace.'} /></div>}
        </ScrollArea>
      </section>
      {inspectorOpen ? <aside className="flex min-h-0 w-[min(55vw,900px)] min-w-0 flex-col border-l border-border max-md:h-1/2 max-md:w-full" aria-label="Inspector">{reviewerId ? <LiveInspector key={saved.identity.spaceId} projectId={projectId} spaceId={saved.identity.spaceId} generation={saved.placement?.generation ?? 0} reviewerId={reviewerId} sessionId={saved.checkpoint?.sessionId ?? null} turns={turns} workspaces={[]} onSelectWorkspace={(id) => selectInspection(projectId, id)} refreshToken={0} runtimeAvailable={false} onClose={() => setInspectorOpen(false)} /> : <EmptyState title="Inspector identity unavailable" description="This browser must be enrolled to inspect workspace records." />}</aside> : null}
    </div>
  </main>;
}

function RunningWorkspace({ projectId, workspaceId, onOpenSettings, defaultMachineId, activeView, onNavigateView, user, providers }: LiveWorkspaceProps & { projectId: string; workspaceId: string | null }) {
  const placementsQuery = useResultQuery(rpcClient.placements, {});
  const homeMachineId = placementsQuery.state === 'success' ? placementsQuery.value.machineId : null;
  const projectsQuery = useResultQuery(rpcClient.project.list, { lifecycle: 'all' });
  const bootstrap = useResultQuery(rpcClient.bootstrap, { projectId, workspaceId }, { enabled: projectId.length > 0 });
  const machinesQuery = useResultQuery(rpcClient.machines, {});
  const cronsQuery = useResultQuery(rpcClient.crons.list, { projectId }, { enabled: projectId.length > 0 });
  const [eventConnection, setEventConnection] = useState<'connecting' | 'open' | 'reconnecting' | 'closed'>('connecting');
  const [connectionRecoveryAttempt, setConnectionRecoveryAttempt] = useState(0);
  const skillsQuery = useResultQuery(rpcClient.skills.list, { projectId }, { enabled: projectId.length > 0 });
  const mcpConnectionsQuery = useResultQuery(rpcClient.mcp.connections.list, {});
  const composioCatalogQuery = useResultQuery(rpcClient.mcp.composio.catalog, {});
  const mcpGrantsQuery = useResultQuery(rpcClient.mcp.grants.list, { projectId }, { enabled: projectId.length > 0 });
  const [allMcpGrants, setAllMcpGrants] = useState<ProjectMcpGrantRpcView[] | null>(null);
  useEffect(() => {
    if (projectsQuery.state !== 'success') return;
    let cancelled = false;
    void Promise.all(projectsQuery.value.map(async (project) => {
      const result = await rpcClient.mcp.grants.list({ projectId: project.id });
      return result.status === 'ok' ? result.value : [];
    })).then((grants) => { if (!cancelled) setAllMcpGrants(grants.flat()); });
    return () => { cancelled = true; };
  }, [projectsQuery.state, projectsQuery.state === 'success' ? projectsQuery.value.map((project) => `${project.id}:${project.revision}`).join('|') : '']);
  const mcpToolsQuery = useResultQuery(rpcClient.mcp.discover, { projectId }, { enabled: projectId.length > 0 });
  const liveSession = bootstrap.state === 'success' ? bootstrap.value.mainAgent : null;
  const liveSessionId = liveSession?.id ?? '';
  const sessionControlQuery = useResultQuery(rpcClient.session.control, { sessionId: liveSessionId }, { enabled: liveSessionId.length > 0 });
  useEffect(() => {
    if (liveSessionId && liveSession?.state !== 'closed') void sessionControlQuery.refetch();
  }, [liveSessionId, liveSession?.state, liveSession?.resumePending]);
  const retryableBootstrapFailure = bootstrap.state === 'failure' && isRetryableConnectionError(bootstrap.error);
  useEffect(() => {
    if (bootstrap.state === 'success') {
      if (connectionRecoveryAttempt !== 0) setConnectionRecoveryAttempt(0);
      return;
    }
    if (!retryableBootstrapFailure || connectionRecoveryAttempt >= CONNECTION_RECOVERY_DELAYS_MS.length) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        const health = await fetchMachineHealth();
        if (cancelled) return;
        if (health) {
          routedTransport.invalidate();
          setEventConnection('reconnecting');
          await Promise.allSettled([placementsQuery.refetch(), projectsQuery.refetch()]);
          if (!cancelled) await bootstrap.refetch();
        }
        if (!cancelled) setConnectionRecoveryAttempt((attempt) => attempt + 1);
      })();
    }, CONNECTION_RECOVERY_DELAYS_MS[connectionRecoveryAttempt]);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [bootstrap.state, bootstrap.state === 'failure' ? bootstrap.error.message : null, retryableBootstrapFailure, connectionRecoveryAttempt, projectId, workspaceId]);
  const [transport, setTransport] = useState<TransportBlock[]>([]);
  const [inspectorRefreshToken, setInspectorRefreshToken] = useState(0);
  // Self-development: what GitSpace runs, polled every 3s while a launch runs
  // on the home machine and every 15s while the fleet converges on it.
  const deploymentQuery = useResultQuery(rpcClient.deployment.status, {});
  const launchDeployment = useResultMutation(rpcClient.deployment.launch);
  const revertDeployment = useResultMutation(rpcClient.deployment.revert);
  const [launch, setLaunch] = useState<LaunchTrack | null>(null);
  const [launchSheetOpen, setLaunchSheetOpen] = useState(false);
  const [launchedMark, setLaunchedMark] = useState<LaunchedMark | null>(() => readLaunchedMark(window.localStorage, Date.now()));
  // The event stream effect outlives renders; refs hand it the newest launch and status.
  const launchRef = useRef<LaunchTrack | null>(null);
  const deploymentRef = useRef<DeploymentStatusView | null>(null);
  useEffect(() => { launchRef.current = launch; }, [launch]);
  useEffect(() => { deploymentRef.current = deploymentQuery.state === 'success' ? deploymentQuery.value : null; }, [deploymentQuery.state, deploymentQuery.state === 'success' ? deploymentQuery.value : null]);
  const launchRunning = launch?.status === 'running';
  const deploymentConverging = launchDeployment.state === 'pending' || (deploymentQuery.state === 'success' && converging(deploymentQuery.value));
  useEffect(() => {
    if (!launchRunning && !deploymentConverging) return;
    const timer = setInterval(() => { void deploymentQuery.refetch(); }, launchRunning ? 3_000 : 15_000);
    return () => clearInterval(timer);
  }, [launchRunning, deploymentConverging]);
  // `status.launch` seeds the track (a launch started elsewhere, or before this
  // page loaded) and fills gaps. Events are the finer-grained source; the poll
  // is merged by phase (the log dedupes) and can only move status forward, so a
  // poll that raced an event never regresses a finished launch to running.
  const statusLaunch = deploymentQuery.state === 'success' ? deploymentQuery.value.launch : null;
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
    const served = await awaitMachineSwap(swapTarget, swapTarget ? launched?.sha ?? null : null);
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

  useEffect(() => {
    if (!projectId || bootstrap.state !== 'success') return;
    const controller = new AbortController();
    let offset = bootstrap.value.eventOffset;
    const consume = async (): Promise<void> => {
      let firstAttempt = true;
      while (!controller.signal.aborted) {
        setEventConnection(firstAttempt ? 'connecting' : 'reconnecting');
        firstAttempt = false;
        try {
          const stream = rpcClient.events({ projectId, afterOffset: offset }, { signal: controller.signal });
          setEventConnection('open');
          for await (const result of stream) {
            if (controller.signal.aborted) return;
            if (result.status === 'error') throw result.error;
            if (result.value.offset <= offset) continue;
            offset = result.value.offset;
            setInspectorRefreshToken(result.value.offset);
            if (result.value.operation === 'code-version') {
              await reloadAfterSwap();
              return;
            }
            if (result.value.entity === 'skill') {
              await skillsQuery.refetch();
            } else if (result.value.entity.startsWith('project-cron')) {
              await cronsQuery.refetch();
            } else if (result.value.entity === 'deployment') {
              applyLaunchEvent(result.value.entityId, result.value.createdAt, result.value.payload);
              await deploymentQuery.refetch();
            } else if (!INSPECTOR_EVENT_ENTITIES[result.value.entity]) {
              await bootstrap.refetch();
              if (result.value.scope === 'session' && liveSessionId) await sessionControlQuery.refetch();
            }
          }
        } catch {
          if (controller.signal.aborted) return;
          routedTransport.invalidate();
          try {
            await bootstrap.refetch();
          } catch {
            // Bootstrap owns the retryable failure state; its recovery effect
            // waits for machine health before rebuilding routing and queries.
          }
        }
        if (!controller.signal.aborted) {
          const tick = Promise.withResolvers<void>();
          setTimeout(tick.resolve, 500);
          await tick.promise;
        }
      }
    };
    void consume().finally(() => setEventConnection('closed'));
    return () => controller.abort();
  }, [projectId, bootstrap.state === 'success', liveSessionId]);

  const prompt = useResultMutation(rpcClient.session.prompt);
  const archiveWorkspace = useResultMutation(rpcClient.workspace.archive);
  const closeSpace = useResultMutation(rpcClient.space.close);
  const reopenSpace = useResultMutation(rpcClient.space.reopen);
  const createProject = useResultMutation(rpcClient.project.create);
  const createWorkspace = useResultMutation(rpcClient.workspace.create);
  const archiveProject = useResultMutation(rpcClient.project.archive);
  const restoreProject = useResultMutation(rpcClient.project.restore);
  const deleteProject = useResultMutation(rpcClient.project.delete);
  const deleteWorkspace = useResultMutation(rpcClient.workspace.delete);
  const createMcpConnection = useResultMutation(rpcClient.mcp.connections.create);
  const updateMcpConnection = useResultMutation(rpcClient.mcp.connections.update);
  const deleteMcpConnection = useResultMutation(rpcClient.mcp.connections.delete);
  const putMcpGrant = useResultMutation(rpcClient.mcp.grants.put);
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
  // Claim: open a released or archived space on a chosen machine. Nothing holds
  // it, so the destination is explicit rather than routed; the home machine is `/rpc`.
  const claimSpace = async (targetSpaceId: string, destinationMachineId: string | null): Promise<void> => {
    if (bootstrap.state !== 'success') throw new Error('Workspace is unavailable');
    const target = targetSpaceId === bootstrap.value.baseSpace.id
      ? bootstrap.value.baseSpace
      : bootstrap.value.workspaces.find((candidate) => candidate.id === targetSpaceId);
    if (!target) throw new Error(`Space ${targetSpaceId} is unavailable`);
    const destinationUrl = destinationMachineId === null || destinationMachineId === homeMachineId
      ? homeRpcUrl
      : (machinesQuery.state === 'success' ? machinesQuery.value : []).find((machine) => machine.id === destinationMachineId)?.rpcEndpoint ?? null;
    if (!destinationUrl) throw new Error('That machine is not reachable right now');
    // The cloud generation from the checkpoint is authoritative for a space this
    // machine never held; the local one only matches when it was released here.
    const expectedGeneration = bootstrap.value.checkpoint && targetSpaceId === (workspaceId ?? bootstrap.value.baseSpace.id)
      ? bootstrap.value.checkpoint.generation
      : target.spaceGeneration;
    const destinationClient = createGitSpaceBrowserClient({ url: destinationUrl });
    const opened = target.closedAt
      ? await destinationClient.workspace.restore({ spaceId: targetSpaceId, expectedGeneration })
      : await destinationClient.space.reopen({ spaceId: targetSpaceId, expectedGeneration });
    if (opened.status === 'error') throw opened.error;
    routedTransport.invalidate();
    await Promise.all([placementsQuery.refetch(), bootstrap.refetch(), projectsQuery.refetch()]);
  };
  const shell = useMemo<GitSpaceShellProps | null>(() => {
    if (bootstrap.state !== 'success') return null;
    const value = bootstrap.value;
    const selectedWorkspace = workspaceId === null
      ? null
      : value.workspaces.find((candidate) => candidate.id === workspaceId) ?? null;
    const selectedSpaceId = selectedWorkspace?.id ?? value.baseSpace.id;
    const mainAgent = value.mainAgent;
    const turns = reduceTranscriptToTurns(value.transcript);
    const artifacts = value.artifacts.map((artifact) => ({
      url: artifact.url,
      name: artifact.path.split('/').at(-1) ?? artifact.path,
      path: artifact.path,
      scope: artifact.scope,
      size: artifact.size,
      ...(artifact.mediaType ? { mediaType: artifact.mediaType } : {}),
    }));
    const terminalApi: NonNullable<GitSpaceShellProps['terminals']> = {
      list: async () => {
        const result = await rpcClient.terminals.list({ spaceId: selectedSpaceId });
        if (result.status === 'error') throw result.error;
        return result.value;
      },
      create: async () => {
        const result = await rpcClient.terminals.create({ spaceId: selectedSpaceId });
        if (result.status === 'error') throw result.error;
        return result.value;
      },
      read: async (name, cursor) => {
        const result = await rpcClient.terminals.read({ spaceId: selectedSpaceId, name, cursor });
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
    const machineLabels: Record<string, string> = machinesQuery.state === 'success' ? Object.fromEntries(machinesQuery.value.map((machine) => [machine.id, machine.label])) : {};
    const placements: Record<string, { holderId: string; state: string }> = placementsQuery.state === 'success'
      ? Object.fromEntries(placementsQuery.value.spaces.map((space) => [space.spaceId, { holderId: space.holderId, state: space.state }]))
      : {};
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
    // Launch-into is only offered inside the GitSpace project itself; the RPC routes to the workspace holder.
    const isGitSpaceProject = /gitspace/i.test(repository);
    const sidebarDeployment: GitSpaceShellProps['deployment'] = deploymentQuery.state === 'success' ? {
      status: deploymentQuery.value,
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
      projects: projectsQuery.state === 'success' ? projectsQuery.value : [],
      workspace: scope,
      baseSpace,
      workspaces,
      mainAgent: mainAgent ? {
        id: mainAgent.id,
        title: `${mainAgent.scope === 'project' ? 'Project' : 'Workspace'} agent ${mainAgent.ompSessionId.slice(0, 8)}`,
        state: mainAgent.renderState,
        model: 'OMP',
        recovering: mainAgent.resumePending,
      } : null,
      sessionControls: mainAgent && sessionControlQuery.state === 'success' ? {
        value: sessionControlQuery.value,
        onCycleRole: async (direction) => {
          const result = await rpcClient.session.cycleRole({ sessionId: mainAgent.id, direction });
          if (result.status === 'error') throw result.error;
          await sessionControlQuery.refetch();
        },
        onSetModel: async (provider, model) => {
          const result = await rpcClient.session.setModel({ sessionId: mainAgent.id, provider, model });
          if (result.status === 'error') throw result.error;
          await sessionControlQuery.refetch();
        },
        onSetThinking: async (thinking) => {
          const result = await rpcClient.session.setThinking({ sessionId: mainAgent.id, thinking });
          if (result.status === 'error') throw result.error;
          await sessionControlQuery.refetch();
        },
        onSetFast: async (enabled) => {
          const result = await rpcClient.session.setFast({ sessionId: mainAgent.id, enabled });
          if (result.status === 'error') throw result.error;
          await sessionControlQuery.refetch();
        },
        onSetApproval: async (approvalMode) => {
          const result = await rpcClient.session.setApproval({ sessionId: mainAgent.id, approvalMode });
          if (result.status === 'error') throw result.error;
          await sessionControlQuery.refetch();
        },
        onSetGoal: async (enabled) => {
          const result = await rpcClient.session.setGoal({ sessionId: mainAgent.id, enabled, objective: null });
          if (result.status === 'error') throw result.error;
          await sessionControlQuery.refetch();
        },
        onCompact: async (instructions) => {
          const result = await rpcClient.session.compact({ sessionId: mainAgent.id, instructions: instructions ?? null });
          if (result.status === 'error') throw result.error;
          await sessionControlQuery.refetch();
        },
        onClearQueue: async () => {
          const result = await rpcClient.session.clearQueue({ sessionId: mainAgent.id });
          if (result.status === 'error') throw result.error;
          await sessionControlQuery.refetch();
        },
        onRemoveQueuedMessage: async (kind, index) => {
          const result = await rpcClient.session.removeQueuedMessage({ sessionId: mainAgent.id, kind, index });
          if (result.status === 'error') throw result.error;
          await sessionControlQuery.refetch();
        },
        onPromoteQueuedMessage: async (index) => {
          const result = await rpcClient.session.promoteQueuedMessage({ sessionId: mainAgent.id, index });
          if (result.status === 'error') throw result.error;
          await sessionControlQuery.refetch();
        },
        onAnswerAsk: async (id, answers) => {
          const result = await rpcClient.session.answerAsk({ sessionId: mainAgent.id, id, answers });
          if (result.status === 'error') throw result.error;
          await sessionControlQuery.refetch();
        },
        onStop: async () => {
          const result = await rpcClient.session.stop({ sessionId: mainAgent.id });
          if (result.status === 'error') throw result.error;
          await Promise.all([bootstrap.refetch(), sessionControlQuery.refetch()]);
        },
        onNavigateTree: async (entryId) => {
          const result = await rpcClient.session.navigateTree({ sessionId: mainAgent.id, entryId });
          if (result.status === 'error') throw result.error;
          await Promise.all([bootstrap.refetch(), sessionControlQuery.refetch()]);
        },
      } : undefined,
      onSetWorkspacePhase: async (targetWorkspaceId, phase) => {
        const result = await rpcClient.workspace.setPhase({ workspaceId: targetWorkspaceId, phase });
        if (result.status === 'error') throw result.error;
        await bootstrap.refetch();
      },
      onSetWorkspaceRelations: setWorkspaceRelations,
      turns,
      transport,
      artifacts,
      // Move destinations: every online machine except the one currently holding the selected space.
      machines: machinesQuery.state === 'success'
        ? machinesQuery.value.filter((machine) => machine.state === 'online' && machine.rpcEndpoint !== null && machine.id !== scope.possessedBy).map(({ id, label }) => ({ id, label }))
        : [],
      terminals: terminalApi,
      secrets: {
        projectName: value.project.name,
        list: async () => {
          const result = await rpcClient.secrets.list({ projectId });
          if (result.status === 'error') throw result.error;
          return result.value;
        },
        put: async (name, secretValue) => {
          const result = await rpcClient.secrets.put({ projectId, name, value: secretValue });
          if (result.status === 'error') throw result.error;
          return result.value;
        },
        delete: async (name) => {
          const result = await rpcClient.secrets.delete({ projectId, name });
          if (result.status === 'error') throw result.error;
        },
        listValues: async () => {
          const result = await rpcClient.environment.get({ spaceId: baseSpace.id });
          if (result.status === 'error') throw result.error;
          return { global: result.value.values.global, project: result.value.values.project };
        },
        putValue: async (valueScope, name, environmentValue) => {
          const result = await rpcClient.environment.putValue({ spaceId: baseSpace.id, scope: valueScope, name, value: environmentValue });
          if (result.status === 'error') throw result.error;
        },
        deleteValue: async (valueScope, name) => {
          const result = await rpcClient.environment.deleteValue({ spaceId: baseSpace.id, scope: valueScope, name });
          if (result.status === 'error') throw result.error;
        },
      },
      crons: {
        projectId,
        projectName: value.project.name,
        crons: cronsQuery.state === 'success' ? cronsQuery.value : [],
        holders: placementsQuery.state === 'success' ? Object.fromEntries(placementsQuery.value.spaces.map((space) => [space.spaceId, space.holderId])) : {},
        targetOptions: value.workspaces.map((candidate) => ({
          target: { scope: 'workspace' as const, projectId: candidate.projectId, spaceId: candidate.id },
          label: `Workspace agent · ${candidate.name}`,
          description: candidate.branch,
        })),
        loading: cronsQuery.state === 'pending',
        loadError: cronsQuery.state === 'failure' ? cronsQuery.error.message : null,
        onCreateCron: async (draft) => {
          const result = await rpcClient.crons.create({ projectId, draft });
          if (result.status === 'error') throw result.error;
          return result.value;
        },
        onUpdateCron: async (cronId, expectedRevision, draft) => {
          const result = await rpcClient.crons.update({ projectId, cronId, expectedRevision, draft });
          if (result.status === 'error') throw result.error;
          return result.value;
        },
        onDeleteCron: async (cronId, expectedRevision) => {
          const result = await rpcClient.crons.delete({ projectId, cronId, expectedRevision });
          if (result.status === 'error') throw result.error;
        },
        onRunNow: async (cronId) => {
          const result = await rpcClient.crons.runNow({ projectId, cronId });
          if (result.status === 'error') throw result.error;
          return result.value;
        },
        onListRuns: async (cronId) => {
          const result = await rpcClient.crons.history({ projectId, cronId });
          if (result.status === 'error') throw result.error;
          return result.value;
        },
      },
      skills: {
        projectId,
        projectName: value.project.name,
        projects: projectsQuery.state === 'success' ? projectsQuery.value.map((project) => ({ id: project.id, name: project.name })) : [{ id: projectId, name: value.project.name }],
        skills: skillsQuery.state === 'success' ? skillsQuery.value : [],
        loading: skillsQuery.state === 'pending',
        error: skillsQuery.state === 'failure' ? skillsQuery.error.message : null,
        update: async (skill, changes) => {
          const result = await rpcClient.skills.update({
            projectId,
            update: { id: skill.id, expectedRevision: skill.revision, ...changes },
          });
          if (result.status === 'error') throw result.error;
          return result.value;
        },
      },
      plugins: {
        projectId,
        projectName: value.project.name,
        projects: projectsQuery.state === 'success' ? projectsQuery.value.map((project) => ({ id: project.id, name: project.name })) : [{ id: projectId, name: value.project.name }],
        connections: mcpConnectionsQuery.state === 'success' ? mcpConnectionsQuery.value : [],
        grants: allMcpGrants ?? (mcpGrantsQuery.state === 'success' ? mcpGrantsQuery.value : []),
        tools: mcpToolsQuery.state === 'success' ? mcpToolsQuery.value : [],
        machines: machinesQuery.state === 'success' ? machinesQuery.value.map((machine) => ({ id: machine.id, label: machine.label, state: machine.state })) : [],
        loading: mcpConnectionsQuery.state === 'pending' || mcpGrantsQuery.state === 'pending' || mcpToolsQuery.state === 'pending',
        error: mcpConnectionsQuery.state === 'failure' ? mcpConnectionsQuery.error.message : mcpGrantsQuery.state === 'failure' ? mcpGrantsQuery.error.message : mcpToolsQuery.state === 'failure' ? mcpToolsQuery.error.message : undefined,
        composioCatalog: composioCatalogQuery.state === 'success' ? composioCatalogQuery.value : { configured: false, toolkits: [] },
        onCreate: async (connection) => {
          const result = await createMcpConnection.mutateAsync({ connection });
          if (result.status === 'error') throw result.error;
          await Promise.all([mcpConnectionsQuery.refetch(), mcpGrantsQuery.refetch(), mcpToolsQuery.refetch()]);
        },
        onUpdate: async (connectionId, expectedRevision, connection) => {
          const result = await updateMcpConnection.mutateAsync({ connectionId, expectedRevision, connection });
          if (result.status === 'error') throw result.error;
          await Promise.all([mcpConnectionsQuery.refetch(), mcpToolsQuery.refetch()]);
        },
        onDelete: async (connectionId, expectedRevision) => {
          const result = await deleteMcpConnection.mutateAsync({ connectionId, expectedRevision });
          if (result.status === 'error') throw result.error;
          await Promise.all([mcpConnectionsQuery.refetch(), mcpGrantsQuery.refetch(), mcpToolsQuery.refetch()]);
        },
        onSetGrant: async (targetProjectId, connectionId, projectSpaceEnabled, workspacesEnabled, expectedRevision) => {
          const enabled = projectSpaceEnabled || workspacesEnabled;
          const result = await putMcpGrant.mutateAsync({ projectId: targetProjectId, connectionId, enabled, projectSpaceEnabled, workspacesEnabled, expectedRevision });
          if (result.status === 'error') throw result.error;
          setAllMcpGrants((current) => [...(current ?? []).filter((grant) => grant.projectId !== targetProjectId || grant.connectionId !== connectionId), result.value]);
          if (targetProjectId === projectId) await Promise.all([mcpGrantsQuery.refetch(), mcpToolsQuery.refetch()]);
        },
        onAuthorizeComposio: async (toolkit, label) => {
          const result = await rpcClient.mcp.composio.authorize({ toolkit, label });
          if (result.status === 'error') throw result.error;
          await mcpConnectionsQuery.refetch();
          return result.value.redirectUrl;
        },
        onRefreshComposio: async (connectionId) => {
          const result = await rpcClient.mcp.composio.refresh({ connectionId });
          if (result.status === 'error') throw result.error;
          await Promise.all([mcpConnectionsQuery.refetch(), mcpToolsQuery.refetch()]);
        },
        onLoadComposioTools: async (connectionId) => {
          const result = await rpcClient.mcp.composio.tools({ connectionId });
          if (result.status === 'error') throw result.error;
          return result.value;
        },
        onUpdateComposioTools: async (connectionId, expectedRevision, allowedTools) => {
          const result = await rpcClient.mcp.composio.updateTools({ connectionId, expectedRevision, allowedTools });
          if (result.status === 'error') throw result.error;
          await Promise.all([mcpConnectionsQuery.refetch(), mcpToolsQuery.refetch()]);
        },
        onDisconnectComposio: async (connectionId, expectedRevision) => {
          const result = await rpcClient.mcp.composio.disconnect({ connectionId, expectedRevision });
          if (result.status === 'error') throw result.error;
          await Promise.all([mcpConnectionsQuery.refetch(), mcpGrantsQuery.refetch(), mcpToolsQuery.refetch()]);
        },
        onRefresh: async () => {
          await Promise.all([mcpConnectionsQuery.refetch(), mcpGrantsQuery.refetch(), mcpToolsQuery.refetch()]);
          if (projectsQuery.state === 'success') {
            const grants = await Promise.all(projectsQuery.value.map(async (project) => {
              const result = await rpcClient.mcp.grants.list({ projectId: project.id });
              return result.status === 'ok' ? result.value : [];
            }));
            setAllMcpGrants(grants.flat());
          }
        },
      },
      renderEnvironmentStatus: (onInspect) => <LiveEnvironmentStatus spaceId={selectedSpaceId} onInspect={onInspect} onConfigure={mainAgent ? async () => { const result = await prompt.mutateAsync({ sessionId: mainAgent.id, text: CONFIGURE_ENVIRONMENT_PROMPT, streamingBehavior: 'followUp', images: [] }); if (result.status === 'error') throw result.error; } : undefined} />,
      renderInspector: (onClose, initialView) => <LiveInspector
        initialView={initialView}
        runtimeAvailable
        onAskAgent={mainAgent ? async (text) => { const result = await prompt.mutateAsync({ sessionId: mainAgent.id, text, streamingBehavior: 'followUp', images: [] }); if (result.status === 'error') throw result.error; } : undefined}
        projectId={projectId}
        spaceId={selectedSpaceId}
        generation={selectedWorkspace?.spaceGeneration ?? value.baseSpace.spaceGeneration}
        reviewerId={homeMachineId ?? 'browser'}
        sessionId={mainAgent?.id ?? null}
        turns={turns}
        scope={scope}
        workspaces={workspaces}
        onSelectWorkspace={selectWorkspace}
        onSetRelations={setWorkspaceRelations}
        refreshToken={inspectorRefreshToken}
        onClose={onClose}
        onGenerateChangeGuide={mainAgent ? async () => {
          const result = await prompt.mutateAsync({
            sessionId: mainAgent.id,
            text: 'Use the review-guide-narrator skill. Delegate a focused narrator subagent to analyze the current diff and typed Journal, submit every stale Change Guide cluster through the GitSpace Change Guide API, fix validation errors, and confirm the saved guide.',
            streamingBehavior: 'followUp',
            images: [],
          });
          if (result.status === 'error') throw result.error;
        } : undefined}
      />,
      ...((selectedWorkspace === null || !selectedWorkspace.closedAt) && mainAgent ? {
        onSend: async (text: string, behavior?: 'steer' | 'followUp', images?: Array<{ data: string; mimeType: string }>) => {
          const result = await prompt.mutateAsync({ sessionId: mainAgent.id, text, streamingBehavior: behavior ?? 'followUp', images: images ?? [] });
          if (result.status === 'error') throw result.error;
          await sessionControlQuery.refetch();
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
      onReopenSpace: async (targetSpaceId: string) => {
        const target = targetSpaceId === value.baseSpace.id ? value.baseSpace : value.workspaces.find((candidate) => candidate.id === targetSpaceId);
        if (!target) throw new Error(`Space ${targetSpaceId} is unavailable`);
        const result = await reopenSpace.mutateAsync({ spaceId: targetSpaceId, expectedGeneration: target.spaceGeneration });
        if (result.status === 'error') throw result.error;
        refreshInspection();
        await Promise.all([placementsQuery.refetch(), bootstrap.refetch()]);
      },
      onArchiveWorkspace: async (targetSpaceId: string) => {
        const target = value.workspaces.find((candidate) => candidate.id === targetSpaceId);
        if (!target) throw new Error(`Workspace ${targetSpaceId} is unavailable`);
        const result = await archiveWorkspace.mutateAsync({ spaceId: targetSpaceId, expectedGeneration: target.spaceGeneration });
        if (result.status === 'error') throw result.error;
        refreshInspection();
        if (targetSpaceId === selectedSpaceId) return;
        await Promise.all([bootstrap.refetch(), projectsQuery.refetch()]);
      },
      onClaimWorkspace: claimSpace,
      // Claim targets: every reachable online machine; the space is held by nobody, so none is excluded.
      claimMachines: machinesQuery.state === 'success'
        ? machinesQuery.value.filter((machine) => machine.state === 'online' && machine.rpcEndpoint !== null).map(({ id, label }) => ({ id, label }))
        : [],
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
      activeView,
      onNavigateView,
      deployment: sidebarDeployment,
      launchBanner: launchedMark ? <LaunchedBanner mark={launchedMark} onRevert={revertToStable} onDismiss={dismissLaunched} /> : null,
    };
  }, [bootstrap.state, bootstrap.state === 'success' ? bootstrap.value : null, projectsQuery.state, projectsQuery.state === 'success' ? projectsQuery.value : null, machinesQuery.state, machinesQuery.state === 'success' ? machinesQuery.value : null, cronsQuery.state, cronsQuery.state === 'success' ? cronsQuery.value : null, skillsQuery.state, skillsQuery.state === 'success' ? skillsQuery.value : null, mcpConnectionsQuery.state, mcpConnectionsQuery.state === 'success' ? mcpConnectionsQuery.value : null, composioCatalogQuery.state, composioCatalogQuery.state === 'success' ? composioCatalogQuery.value : null, mcpGrantsQuery.state, mcpGrantsQuery.state === 'success' ? mcpGrantsQuery.value : null, allMcpGrants, mcpToolsQuery.state, mcpToolsQuery.state === 'success' ? mcpToolsQuery.value : null, sessionControlQuery.state, sessionControlQuery.state === 'success' ? sessionControlQuery.value : null, deploymentQuery.state, deploymentQuery.state === 'success' ? deploymentQuery.value : null, launchDeployment.state, launch, launchedMark, eventConnection, inspectorRefreshToken, prompt.state, archiveWorkspace.state, createProject.state, createWorkspace.state, archiveProject.state, restoreProject.state, deleteProject.state, deleteWorkspace.state, createMcpConnection.state, updateMcpConnection.state, deleteMcpConnection.state, putMcpGrant.state, workspaceId, homeMachineId, defaultMachineId, transport, placementsQuery.state, placementsQuery.state === 'success' ? placementsQuery.value : null, onOpenSettings, activeView, onNavigateView, user.name, user.handle]);
  const lastGoodShell = useRef<GitSpaceShellProps | null>(null);
  if (shell) lastGoodShell.current = shell;
  const recoveryScheduled = retryableBootstrapFailure && connectionRecoveryAttempt < CONNECTION_RECOVERY_DELAYS_MS.length;
  const retainedShell = lastGoodShell.current;
  if ((bootstrap.state === 'pending' || recoveryScheduled) && retainedShell) return <>
    <GitSpaceShell {...retainedShell} providers={providers} />
    <div role="status" className="fixed inset-x-0 top-3 z-50 flex justify-center px-4">
      <div className="flex items-center gap-2 rounded-lg bg-surface-3 px-3 py-2 text-caption text-foreground shadow-surface-3">
        <ThinkingIndicator size="compact" />
        Reconnecting to this machine…
      </div>
    </div>
  </>;
  if (projectsQuery.state === 'pending') return <PageCanvas><EmptyState icon={<ThinkingIndicator />} title="Opening projects…" description="Loading cloud project authority." /></PageCanvas>;
  if (projectsQuery.state === 'failure') return <PageCanvas><EmptyState title="Projects are unavailable" description={projectsQuery.error.message} action={<Button variant="ghost" onClick={() => void projectsQuery.refetch()}>Retry</Button>} /></PageCanvas>;

  if (bootstrap.state === 'pending' || recoveryScheduled) return <PageCanvas><EmptyState icon={<ThinkingIndicator />} title="Opening GitSpace…" description={recoveryScheduled ? 'Reconnecting to the selected machine.' : 'Loading the selected agent.'} /></PageCanvas>;
  if (bootstrap.state === 'failure') return <PageCanvas><EmptyState title="GitSpace is unavailable" description={bootstrap.error.message} action={<Button variant="ghost" onClick={() => { setConnectionRecoveryAttempt(0); refreshInspection(); void bootstrap.refetch(); }}>Retry</Button>} /></PageCanvas>;
  if (!shell) return <PageCanvas><EmptyState title="Project unavailable" description="The selected project is not available on this machine." /></PageCanvas>;
  return <>
    <GitSpaceShell {...shell} providers={providers} />
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
  const settingsQuery = useResultQuery(rpcClient.settings.get, {});
  const productProjectsQuery = useResultQuery(rpcClient.project.list, { lifecycle: 'all' });
  const selectedProjectId = location.searchParams.get('project') ?? '';
  const workspaceAvailability = useResultQuery(rpcClient.inspector.availability, { projectId: selectedProjectId, workspaceId: optionalQueryParameter('workspace') }, { enabled: selectedProjectId.length > 0 });
  const runtimeMetadataEnabled = route === 'settings' || forceOnboarding || (settingsQuery.state === 'success' && !settingsQuery.value.onboardingComplete) || (workspaceAvailability.state === 'success' && workspaceAvailability.value.runtimeAvailable);
  const machinesQuery = useResultQuery(rpcClient.machines, {}, { enabled: runtimeMetadataEnabled });
  const onlineMachineIds = machinesQuery.state === 'success'
    ? machinesQuery.value.filter((machine) => machine.state === 'online' && machine.desiredState === 'online' && machine.rpcEndpoint).map((machine) => machine.id).sort().join(',')
    : '';
  const runtimeAvailable = runtimeMetadataEnabled && onlineMachineIds.length > 0;
  const ompQuery = useResultQuery(rpcClient.settings.omp.get, {}, { enabled: runtimeMetadataEnabled });
  const gitIdentityQuery = useResultQuery(rpcClient.settings.git.get, {});
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
  const revokeDevice = useResultMutation(rpcClient.devices.revoke);
  const [browserDevice, setBrowserDevice] = useState<BrowserDevice | null>(null);
  useEffect(() => { void currentDevice().then(setBrowserDevice); }, []);
  const currentBrowserView = devicesQuery.state === 'success' ? devicesQuery.value.find(device => device.current) : undefined;
  // Settings → Source reads the same status entry LiveWorkspace polls; revert is only offered there.
  const settingsDeploymentQuery = useResultQuery(rpcClient.deployment.status, {}, { enabled: runtimeMetadataEnabled });
  const revertDeployment = useResultMutation(rpcClient.deployment.revert);
  const composioSetupQuery = useResultQuery(rpcClient.mcp.composio.setup.get, {});
  const putComposioSetup = useResultMutation(rpcClient.mcp.composio.setup.put);
  const deleteComposioSetup = useResultMutation(rpcClient.mcp.composio.setup.delete);
  const browserRelayQuery = useResultQuery(rpcClient.browserRelay.status, {}, { enabled: runtimeMetadataEnabled });
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
  // Usage is fetched only once the Providers tab/step is shown; the first
  // load reads the machine's cache, every explicit refresh bypasses it.
  const [usageVisible, setUsageVisible] = useState(false);
  const [usageRefresh, setUsageRefresh] = useState(false);
  const usageQuery = useResultQuery(rpcClient.providers.usage, { providerId: null, refresh: usageRefresh }, { enabled: runtimeAvailable && usageVisible });
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
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      while (!controller.signal.aborted) {
        try {
          for await (const event of rpcClient.settings.events({}, { signal: controller.signal })) {
            if (controller.signal.aborted) return;
            if (event.status === 'error') break;
            await Promise.all([settingsQuery.refetch(), gitIdentityQuery.refetch(), ...(runtimeMetadataEnabled ? [ompQuery.refetch()] : [])]);
          }
        } catch {
          if (controller.signal.aborted) return;
        }
        if (!controller.signal.aborted) {
          const tick = Promise.withResolvers<void>();
          setTimeout(tick.resolve, 500);
          await tick.promise;
        }
      }
    })();
    return () => controller.abort();
  }, [runtimeMetadataEnabled]);
  useEffect(() => {
    if (!runtimeMetadataEnabled) return;
    const controller = new AbortController();
    void (async () => {
      while (!controller.signal.aborted) {
        try {
          for await (const event of rpcClient.machine.events({}, { signal: controller.signal })) {
            if (controller.signal.aborted) return;
            if (event.status === 'error') break;
            await machinesQuery.refetch();
          }
        } catch {
          if (controller.signal.aborted) return;
        }
        if (!controller.signal.aborted) {
          const tick = Promise.withResolvers<void>();
          setTimeout(tick.resolve, 500);
          await tick.promise;
        }
      }
    })();
    return () => controller.abort();
  }, [runtimeMetadataEnabled]);
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
  const providerViews = providersQuery.state === 'success' ? providersQuery.value.providers : [];
  const providersSection: ProvidersSectionProps = {
    providers: providerViews,
    ...(providersQuery.state === 'failure' ? { error: providersQuery.error.message } : {}),
    usage: usageQuery.state === 'success' ? usageQuery.value : usageQuery.state === 'failure' ? usageQuery.previous ?? null : null,
    usageStatus: !runtimeAvailable || !usageVisible ? 'idle' : usageQuery.state === 'failure' ? 'error' : usageQuery.state === 'pending' || usageQuery.fetch === 'fetching' ? 'loading' : 'ready',
    ...(runtimeAvailable && usageQuery.state === 'failure' ? { usageError: usageQuery.error.message } : {}),
    onShow: () => setUsageVisible(true),
    onRefreshUsage: refreshUsage,
    onSignIn: signInProvider,
    onSignOut: signOutProvider,
    onSetApiKey: saveProviderApiKey,
    login: { flow: loginFlow, respond: respondLogin, cancel: dismissLogin },
  };
  if (!runtimeMetadataEnabled && settingsQuery.state === 'success' && draft && gitIdentityQuery.state === 'success') return <LiveWorkspace onOpenSettings={(section) => navigateProduct('settings', 'push', section ?? null)} defaultMachineId={draft.defaults.machineId} activeView={route} onNavigateView={(next) => navigateProduct(next)} user={{ name: draft.profile.displayName, handle: draft.profile.handle }} providers={providerViews} />;
  if (settingsQuery.state === 'failure' || ompQuery.state === 'failure' || gitIdentityQuery.state === 'failure') {
    const message = settingsQuery.state === 'failure' ? settingsQuery.error.message : ompQuery.state === 'failure' ? ompQuery.error.message : gitIdentityQuery.state === 'failure' ? gitIdentityQuery.error.message : 'Cloud settings are unavailable';
    return <PageCanvas><EmptyState title="GitSpace setup is unavailable" description={message} action={<Button variant="ghost" onClick={() => { void settingsQuery.refetch(); if (runtimeMetadataEnabled) void ompQuery.refetch(); void gitIdentityQuery.refetch(); }}>Retry</Button>} /></PageCanvas>;
  }
  if (settingsQuery.state === 'pending' || !draft || ompQuery.state === 'pending' || gitIdentityQuery.state === 'pending') {
    return <PageCanvas><EmptyState icon={<ThinkingIndicator />} title="Opening your GitSpace account…" description="Loading cloud settings and OMP configuration." /></PageCanvas>;
  }
  const page = (mode: 'settings' | 'onboarding') => <SettingsPage
    mode={mode}
    settings={draft}
    machines={machinesQuery.state === 'success' ? machinesQuery.value : []}
    ompSettings={ompQuery.value.schema}
    models={modelsQuery.state === 'success' ? modelsQuery.value.models : []}
    ompGeneration={ompQuery.value.document.generation}
    providers={providersSection}
    ompSync={ompQuery.value.sync}
    gitIdentity={gitIdentityQuery.value}
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
    deployment={settingsDeploymentQuery.state === 'success' ? settingsDeploymentQuery.value : null}
    onRevertDeployment={revertToChannel}
    devices={devicesQuery.state === 'success' ? devicesQuery.value : null}
    onRevokeDevice={revokeDeviceAndRefresh}
    onSignOut={signOutThisBrowser}
    onCreateApiClient={mintApiClient}
    canConnectBrowser={canConnectBrowser(browserDevice, currentBrowserView)}
    onCreateBrowserInvitation={() => createBrowserInvitation(new URL(window.location.origin), currentBrowserView)}
    onBrowserInvitationStatus={browserInvitationStatus}
    onCancelBrowserInvitation={cancelBrowserInvitation}
    onBrowserConnected={async () => { await devicesQuery.refetch(); }}
    composioSetup={composioSetupQuery.state === 'success' ? composioSetupQuery.value : null}
    onPutComposioSetup={saveComposioSetup}
    onDeleteComposioSetup={removeComposioSetup}
    browserRelay={browserRelayQuery.state === 'success' ? browserRelayQuery.value : null}
    onSetupBrowserRelay={() => runBrowserRelay('setup')}
    onStartBrowserRelay={() => runBrowserRelay('start')}
    onStopBrowserRelay={() => runBrowserRelay('stop')}
    onTestBrowserRelay={() => runBrowserRelay('test')}
    projects={productProjectsQuery.state === 'success' ? productProjectsQuery.value.map((project) => ({ id: project.id, name: project.name })) : []}
    onBack={() => navigateProduct(optionalQueryParameter('project') ? 'agent' : 'projects', 'replace')}
    onComplete={completeOnboarding}
    saving={ensureStarterProject.state === 'pending' || updateSettings.state === 'pending' || reserveHandle.state === 'pending' || setOmpSetting.state === 'pending' || updateMachineNotes.state === 'pending' || createSandboxMachine.state === 'pending' || sleepMachine.state === 'pending' || resumeMachine.state === 'pending' || destroyMachine.state === 'pending' || revertDeployment.state === 'pending'}
    error={settingsError}
  />;
  if (!draft.onboardingComplete || forceOnboarding) return page('onboarding');
  if (route === 'settings') return page('settings');
  return <LiveWorkspace onOpenSettings={(section) => navigateProduct('settings', 'push', section ?? null)} defaultMachineId={draft.defaults.machineId} activeView={route} onNavigateView={(next) => navigateProduct(next)} user={{ name: draft.profile.displayName, handle: draft.profile.handle }} providers={providerViews} />;
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

export function LiveApp() {
  return <DeviceGate><ResultRpcProvider client={rpcClient}><AccountFrame><GitSpaceProduct /></AccountFrame></ResultRpcProvider></DeviceGate>;
}
