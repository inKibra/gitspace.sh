import { reduceTranscriptToTurns, type TransportBlock, type TurnBlock } from '@gitspace/blocks';
import type { DeploymentStatusView, LaunchProgressView, OmpSettingValue, ProviderLoginEvent, ReleaseTarget, RepositoryDiffView, RepositoryFileView, RepositoryMode, UserSettings } from '@gitspace/protocol';
import type { ProjectMcpGrantRpcView } from '@gitspace/protocol/mcp-contract';
import { Button, InputField, InputGroup, ThinkingIndicator } from '@gitspace/ui';
import { Key01 } from '@untitledui/icons';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ResultRpcProvider, useResultMutation, useResultQuery } from 'result-rpc/react';
import { EmptyState, GitSpaceShell, ProjectsView, type GitSpaceShellProps, type ProviderAuthView, type SpaceHolderView } from './GitSpaceShell.js';
import { LaunchSheet, LaunchedBanner, LAUNCHED_STORAGE_KEY, readLaunchedMark, type LaunchedMark } from './LaunchSheet.js';
import { createGitSpaceBrowserClient, routedTransport, rpcClient } from './rpc-client.js';
import { currentDevice, DEVICE_REJECTED_EVENT, deviceRejected, setCurrentDevice } from './device-session.js';
import { createApiClient, enrollDevice, type ApiClientDraft } from './device.js';
import { applyAppearance } from './appearance.js';
import type { ProviderLoginFlow, ProvidersSectionProps } from './ProvidersSection.js';
import { SettingsPage } from './SettingsPage.js';
import { Inspector } from './inspector/index.js';
import { appendLaunchProgress, converging, launchTrackFrom, RELEASE_TARGETS, shortSha, type LaunchTrack } from './release.js';
import { productRouteFromLocation, setProductRoute, type AppView, type ProductRoute } from './routes.js';

const INSPECTOR_EVENT_ENTITIES: Readonly<Record<string, true>> = {
  goal: true,
  workflow: true,
  rubric: true,
  journal: true,
  'change-guide': true,
  'review-thread': true,
};

interface MachineHealth { generation: string | null; release: string | null }

/** `GET /health` beside `/rpc`: unauthenticated, so it answers even while the device session is mid-swap. */
async function fetchMachineHealth(): Promise<MachineHealth | null> {
  try {
    const response = await fetch('/health', { cache: 'no-store' });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    if (body === null || typeof body !== 'object') return null;
    return {
      generation: 'generation' in body && typeof body.generation === 'string' ? body.generation : null,
      release: 'release' in body && typeof body.release === 'string' ? body.release : null,
    };
  } catch {
    return null;
  }
}

const HEALTH_GATE_INTERVAL_MS = 1_000;
const HEALTH_GATE_TIMEOUT_MS = 90_000;
/**
 * `code-version` means the frontend generation is already swapped; what may
 * still be in flight is the machine daemon. Resolves once `/health` answers
 * (the proxy 503s while a generation is replacing) and, when the swap belongs
 * to a launch with a known sha, from that release; gives up after the timeout
 * so the reload happens regardless.
 */
async function awaitMachineSwap(sha: string | null): Promise<boolean> {
  const deadline = Date.now() + HEALTH_GATE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const health = await fetchMachineHealth();
    if (health && (sha === null || health.release === sha)) return true;
    const tick = Promise.withResolvers<void>();
    setTimeout(tick.resolve, HEALTH_GATE_INTERVAL_MS);
    await tick.promise;
  }
  return false;
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

function LiveInspector({
  projectId,
  spaceId,
  generation,
  reviewerId,
  sessionId,
  turns,
  artifacts,
  scope,
  workspaces,
  onSelectWorkspace,
  onSetRelations,
  refreshToken,
  onClose,
  onGenerateChangeGuide,
}: {
  projectId: string;
  spaceId: string;
  generation: number;
  reviewerId: string;
  sessionId: string | null;
  turns: TurnBlock[];
  artifacts: GitSpaceShellProps['artifacts'];
  scope: GitSpaceShellProps['workspace'];
  workspaces: GitSpaceShellProps['workspaces'];
  onSelectWorkspace: NonNullable<GitSpaceShellProps['onSelectWorkspace']>;
  onSetRelations: NonNullable<GitSpaceShellProps['onSetWorkspaceRelations']>;
  refreshToken: number;
  onClose: () => void;
  onGenerateChangeGuide?: () => Promise<void>;
}) {
  const request = { spaceId, expectedGeneration: generation };
  const overview = useResultQuery(rpcClient.inspector.overview, request);
  const [secondaryQueries, setSecondaryQueries] = useState({ repository: false, journal: false, threads: false, services: false });
  const repository = useResultQuery(rpcClient.inspector.repository.tree, { ...request, mode: 'current', path: null }, { enabled: secondaryQueries.repository });
  const journal = useResultQuery(rpcClient.inspector.journal.list, request, { enabled: secondaryQueries.journal });
  const threads = useResultQuery(rpcClient.inspector.review.list, request, { enabled: secondaryQueries.threads });
  const services = useResultQuery(rpcClient.inspector.services.list, request, { enabled: secondaryQueries.services });
  const [usageRequested, setUsageRequested] = useState(false);
  const usage = useResultQuery(rpcClient.session.usage, { sessionId: sessionId ?? '' }, { enabled: usageRequested && sessionId !== null });
  const stackedOn = scope.kind === 'workspace' ? scope.relations.stackedOn : null;
  const stackStatus = useResultQuery(rpcClient.workspace.stackStatus, { workspaceId: spaceId }, { enabled: stackedOn !== null && scope.kind === 'workspace' && !scope.closedAt });
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
      await repository.refetch();
      await services.refetch();
      if (stackedOn !== null) await stackStatus.refetch();
    })().catch((error: unknown) => setActionError(error instanceof Error ? error.message : String(error)));
  }, [refreshToken]);


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

  return <Inspector
    overview={overview.value}
    scope={scope}
    workspaces={workspaces}
    onSelectWorkspace={onSelectWorkspace}
    onSetRelations={onSetRelations}
    stackStatus={stackStatus.state === 'success' ? stackStatus.value : null}
    repositoryEntries={repository.state === 'success' ? repository.value : []}
    repositoryFile={repositoryFile}
    repositoryDiff={repositoryDiff}
    journalEntries={journal.state === 'success' ? journal.value : []}
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
      const result = await rpcClient.inspector.artifacts.read({ spaceId, expectedGeneration: generation, url: reference.url });
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
    error={queryError}
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

function LiveWorkspace({ onOpenSettings, enterAction, defaultMachineId, activeView, onNavigateView, user, providers }: { onOpenSettings: (section?: 'source') => void; enterAction: 'queue' | 'steer'; defaultMachineId: string | null; activeView: AppView; onNavigateView: (view: AppView) => void; user: { name: string; handle: string | null }; providers: readonly ProviderAuthView[] }) {
  const requestedProjectId = optionalQueryParameter('project');
  const workspaceId = optionalQueryParameter('workspace');
  const placementsQuery = useResultQuery(rpcClient.placements, {});
  const homeMachineId = placementsQuery.state === 'success' ? placementsQuery.value.machineId : null;
  const projectsQuery = useResultQuery(rpcClient.project.list, { lifecycle: 'all' });
  const projectId = requestedProjectId ?? (projectsQuery.state === 'success' ? projectsQuery.value.find((project) => project.lifecycle === 'active')?.id ?? '' : '');
  const bootstrap = useResultQuery(rpcClient.bootstrap, { projectId, workspaceId }, { enabled: projectId.length > 0 });
  const machinesQuery = useResultQuery(rpcClient.machines, {});
  const cronsQuery = useResultQuery(rpcClient.crons.list, { projectId }, { enabled: projectId.length > 0 });
  const [eventConnection, setEventConnection] = useState<'connecting' | 'open' | 'reconnecting' | 'closed'>('connecting');
  const skillsQuery = useResultQuery(rpcClient.skills.list, { projectId }, { enabled: projectId.length > 0 });
  const mcpConnectionsQuery = useResultQuery(rpcClient.mcp.connections.list, {});
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
  const liveSessionId = bootstrap.state === 'success' ? bootstrap.value.mainAgent?.id ?? '' : '';
  const sessionControlQuery = useResultQuery(rpcClient.session.control, { sessionId: liveSessionId }, { enabled: liveSessionId.length > 0 });
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
  const alreadyServed = launch?.status === 'succeeded' && launch.sha !== null && deploymentQuery.state === 'success' && deploymentQuery.value.thisMachine.sha === launch.sha;
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
    const served = await awaitMachineSwap(launched?.targets.includes('machine') ? launched.sha : null);
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
        const stream = rpcClient.events({ projectId, afterOffset: offset }, { signal: controller.signal });
        setEventConnection('open');
        for await (const result of stream) {
          if (controller.signal.aborted) return;
          if (result.status === 'error') break;
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
          }
        }
        if (!controller.signal.aborted) await new Promise((resolve) => setTimeout(resolve, 500));
      }
    };
    void consume().finally(() => setEventConnection('closed'));
    return () => controller.abort();
  }, [projectId, bootstrap.state === 'success']);

  const prompt = useResultMutation(rpcClient.session.prompt);
  const archiveWorkspace = useResultMutation(rpcClient.workspace.archive);
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
    setTransport([{ id: 'move-close', type: 'transport', title: `Checkpointing on ${source}`, detail: 'Publishing Git and agent checkpoint', status: 'reconnecting' }]);
    // Archive routes to the current holder; restore is the one call whose
    // destination is a choice, so it goes to the chosen machine explicitly.
    const closed = await archiveWorkspace.mutateAsync({ spaceId: targetSpaceId, expectedGeneration: target.spaceGeneration });
    if (closed.status === 'error') throw closed.error;
    setTransport([
      { id: 'move-close', type: 'transport', title: `Checkpointed on ${source}`, detail: 'Source files removed', status: 'replaced' },
      { id: 'move-open', type: 'transport', title: `Opening on ${destination.label}`, detail: 'Restoring repository and agent', status: 'reconnecting' },
    ]);
    const destinationUrl = destination.id === homeMachineId ? '/rpc' : destination.rpcEndpoint;
    const opened = await createGitSpaceBrowserClient({ url: destinationUrl }).workspace.restore({ spaceId: targetSpaceId, expectedGeneration: closed.value.generation });
    if (opened.status === 'error') throw opened.error;
    setTransport([
      { id: 'move-close', type: 'transport', title: `Checkpointed on ${source}`, detail: 'Source files removed', status: 'replaced' },
      { id: 'move-open', type: 'transport', title: `Opened on ${destination.label}`, detail: 'Canonical agent restored', status: 'restored' },
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
      ? '/rpc'
      : (machinesQuery.state === 'success' ? machinesQuery.value : []).find((machine) => machine.id === destinationMachineId)?.rpcEndpoint ?? null;
    if (!destinationUrl) throw new Error('That machine is not reachable right now');
    // The cloud generation from the checkpoint is authoritative for a space this
    // machine never held; the local one only matches when it was released here.
    const expectedGeneration = bootstrap.value.checkpoint && targetSpaceId === (workspaceId ?? bootstrap.value.baseSpace.id)
      ? bootstrap.value.checkpoint.generation
      : target.spaceGeneration;
    const opened = await createGitSpaceBrowserClient({ url: destinationUrl }).workspace.restore({ spaceId: targetSpaceId, expectedGeneration });
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
    const selectWorkspace = (nextWorkspaceId: string): void => {
      const url = new URL(window.location.href);
      url.searchParams.set('project', value.workspaces.find((candidate) => candidate.id === nextWorkspaceId)?.projectId ?? projectId);
      url.searchParams.set('workspace', nextWorkspaceId);
      window.location.assign(setProductRoute(url, 'agent'));
    };
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
      defaultSendBehavior: enterAction === 'queue' ? 'followUp' : 'steer',
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
      renderInspector: (onClose) => <LiveInspector
        projectId={projectId}
        spaceId={selectedSpaceId}
        generation={selectedWorkspace?.spaceGeneration ?? value.baseSpace.spaceGeneration}
        reviewerId={homeMachineId ?? 'browser'}
        sessionId={mainAgent?.id ?? null}
        turns={turns}
        artifacts={artifacts}
        scope={scope}
        workspaces={workspaces}
        onSelectWorkspace={selectWorkspace}
        onSetRelations={setWorkspaceRelations}
        refreshToken={inspectorRefreshToken}
        onClose={onClose}
        onGenerateChangeGuide={mainAgent ? async () => {
          await prompt.mutateAsync({
            sessionId: mainAgent.id,
            text: 'Use the review-guide-narrator skill. Delegate a focused narrator subagent to analyze the current diff and typed Journal, submit every stale Change Guide cluster through the GitSpace Change Guide API, fix validation errors, and confirm the saved guide.',
            streamingBehavior: 'followUp',
            images: [],
          });
        } : undefined}
      />,
      ...((selectedWorkspace === null || !selectedWorkspace.closedAt) && mainAgent ? {
        onSend: async (text: string, behavior?: 'steer' | 'followUp', images?: Array<{ data: string; mimeType: string }>) => {
          await prompt.mutateAsync({ sessionId: mainAgent.id, text, streamingBehavior: behavior ?? (enterAction === 'queue' ? 'followUp' : 'steer'), images: images ?? [] });
        },
      } : {}),
      sendPending: prompt.state === 'pending',
      ...(prompt.state === 'failure' ? { sendError: prompt.error.message } : {}),
      onSelectWorkspace: selectWorkspace,
      onSelectProject: (nextProjectId: string) => {
        const url = new URL(window.location.href);
        url.searchParams.set('project', nextProjectId);
        url.searchParams.delete('workspace');
        window.location.assign(setProductRoute(url, 'agent'));
      },
      onCloseWorkspace: async (targetSpaceId: string) => {
        const target = targetSpaceId === value.baseSpace.id ? value.baseSpace : value.workspaces.find((candidate) => candidate.id === targetSpaceId);
        if (!target) throw new Error(`Space ${targetSpaceId} is unavailable`);
        const result = await archiveWorkspace.mutateAsync({ spaceId: targetSpaceId, expectedGeneration: target.spaceGeneration });
        if (result.status === 'error') throw result.error;
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
        const url = new URL(window.location.href);
        url.searchParams.set('project', result.value.project.id);
        url.searchParams.delete('workspace');
        window.location.assign(setProductRoute(url, 'agent'));
      },
      onCreateWorkspace: async (input) => {
        const result = await createWorkspace.mutateAsync({ ...input, dependsOn: [...input.dependsOn] });
        if (result.status === 'error') throw result.error;
        await projectsQuery.refetch();
        if (input.projectId === projectId) await bootstrap.refetch();
        const url = new URL(window.location.href);
        url.searchParams.set('project', input.projectId);
        url.searchParams.set('workspace', result.value.workspace.id);
        window.location.assign(setProductRoute(url, 'agent'));
      },
      onArchiveProject: async (targetProjectId, expectedRevision) => {
        const result = await archiveProject.mutateAsync({ projectId: targetProjectId, expectedRevision });
        if (result.status === 'error') throw result.error;
        await projectsQuery.refetch();
      },
      onRestoreProject: async (targetProjectId, expectedRevision) => {
        const result = await restoreProject.mutateAsync({ projectId: targetProjectId, expectedRevision });
        if (result.status === 'error') throw result.error;
        await projectsQuery.refetch();
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
        window.location.assign(setProductRoute(url, 'agent'));
      },
      onDeleteWorkspace: async (targetWorkspaceId) => {
        const result = await deleteWorkspace.mutateAsync({ workspaceId: targetWorkspaceId });
        if (result.status === 'error') throw result.error;
        await projectsQuery.refetch();
        if (workspaceId === targetWorkspaceId) {
          const url = new URL(window.location.href);
          url.searchParams.delete('workspace');
          window.location.assign(setProductRoute(url, 'agent'));
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
  }, [bootstrap.state, bootstrap.state === 'success' ? bootstrap.value : null, projectsQuery.state, projectsQuery.state === 'success' ? projectsQuery.value : null, machinesQuery.state, machinesQuery.state === 'success' ? machinesQuery.value : null, cronsQuery.state, cronsQuery.state === 'success' ? cronsQuery.value : null, skillsQuery.state, skillsQuery.state === 'success' ? skillsQuery.value : null, mcpConnectionsQuery.state, mcpConnectionsQuery.state === 'success' ? mcpConnectionsQuery.value : null, mcpGrantsQuery.state, mcpGrantsQuery.state === 'success' ? mcpGrantsQuery.value : null, allMcpGrants, mcpToolsQuery.state, mcpToolsQuery.state === 'success' ? mcpToolsQuery.value : null, sessionControlQuery.state, sessionControlQuery.state === 'success' ? sessionControlQuery.value : null, deploymentQuery.state, deploymentQuery.state === 'success' ? deploymentQuery.value : null, launchDeployment.state, launch, launchedMark, eventConnection, inspectorRefreshToken, prompt.state, archiveWorkspace.state, createProject.state, createWorkspace.state, archiveProject.state, restoreProject.state, deleteProject.state, deleteWorkspace.state, createMcpConnection.state, updateMcpConnection.state, deleteMcpConnection.state, putMcpGrant.state, workspaceId, homeMachineId, defaultMachineId, transport, placementsQuery.state, placementsQuery.state === 'success' ? placementsQuery.value : null, onOpenSettings, enterAction, activeView, onNavigateView, user.name, user.handle]);
  if (projectsQuery.state === 'pending') return <main className="flex h-dvh items-center justify-center bg-background"><EmptyState icon={<ThinkingIndicator />} title="Opening projects…" description="Loading cloud project authority." /></main>;
  if (projectsQuery.state === 'failure') return <main className="flex h-dvh items-center justify-center bg-background"><EmptyState title="Projects are unavailable" description={projectsQuery.error.message} action={<Button variant="ghost" onClick={() => void projectsQuery.refetch()}>Retry</Button>} /></main>;
  if (!projectId) return <ProjectsView
    projects={projectsQuery.value}
    workspaces={[]}
    onOpen={() => undefined}
    onOpenProject={(nextProjectId) => {
      const url = new URL(window.location.href);
      url.searchParams.set('project', nextProjectId);
      window.location.assign(setProductRoute(url, 'agent'));
    }}
    onCreateProject={async (input) => {
      const result = await createProject.mutateAsync(input);
      if (result.status === 'error') throw result.error;
      await projectsQuery.refetch();
      const url = new URL(window.location.href);
      url.searchParams.set('project', result.value.project.id);
      window.location.assign(setProductRoute(url, 'agent'));
    }}
    onRestoreProject={async (targetProjectId, expectedRevision) => {
      const result = await restoreProject.mutateAsync({ projectId: targetProjectId, expectedRevision });
      if (result.status === 'error') throw result.error;
      await projectsQuery.refetch();
    }}
    onDeleteProject={async (targetProjectId, expectedRevision) => {
      const result = await deleteProject.mutateAsync({ projectId: targetProjectId, expectedRevision });
      if (result.status === 'error') throw result.error;
      await projectsQuery.refetch();
    }}
  />;

  if (bootstrap.state === 'pending') return <main className="flex h-dvh items-center justify-center bg-background"><EmptyState icon={<ThinkingIndicator />} title="Opening GitSpace…" description="Loading the selected agent." /></main>;
  if (bootstrap.state === 'failure') return <main className="flex h-dvh items-center justify-center bg-background"><EmptyState title="GitSpace is unavailable" description={bootstrap.error.message} action={<Button variant="ghost" onClick={() => void bootstrap.refetch()}>Retry</Button>} /></main>;
  if (!shell) return <main className="flex h-dvh items-center justify-center bg-background"><EmptyState title="Project unavailable" description="The selected project could not be materialized." /></main>;
  return <>
    <GitSpaceShell {...shell} providers={providers} />
    {launch ? <LaunchSheet launch={launch} open={launchSheetOpen} onOpenChange={setLaunchSheetOpen} onRetry={() => launchInto(launch.workspaceId, launch.targets).catch((cause: unknown) => {
      const message = cause instanceof Error ? cause.message : String(cause);
      setLaunch((current) => current ? { ...current, status: 'failed', error: message } : current);
    })} /> : null}
  </>;
}

function GitSpaceProduct() {
  const [route, setRoute] = useState<ProductRoute>(() => productRouteFromLocation(window.location));
  const [draft, setDraft] = useState<UserSettings | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  // Preview the draft's scheme immediately; saving persists it for every machine.
  useEffect(() => { if (draft) applyAppearance(draft.defaults.appearance); }, [draft?.defaults.appearance]);
  const forceOnboarding = new URL(window.location.href).searchParams.get('mode') === 'onboarding';
  const machinesQuery = useResultQuery(rpcClient.machines, {});
  const settingsQuery = useResultQuery(rpcClient.settings.get, {});
  const ompQuery = useResultQuery(rpcClient.settings.omp.get, {});
  const gitIdentityQuery = useResultQuery(rpcClient.settings.git.get, {});
  const updateSettings = useResultMutation(rpcClient.settings.update);
  const reserveHandle = useResultMutation(rpcClient.settings.reserveHandle);
  const setOmpSetting = useResultMutation(rpcClient.settings.omp.set);
  const updateMachineNotes = useResultMutation(rpcClient.machine.updateNotes);
  const createSandboxMachine = useResultMutation(rpcClient.machine.createSandbox);
  const sleepMachine = useResultMutation(rpcClient.machine.sleep);
  const resumeMachine = useResultMutation(rpcClient.machine.resume);
  const destroyMachine = useResultMutation(rpcClient.machine.destroy);
  const devicesQuery = useResultQuery(rpcClient.devices.list, {});
  const revokeDevice = useResultMutation(rpcClient.devices.revoke);
  // Settings → Source reads the same status entry LiveWorkspace polls; revert is only offered there.
  const settingsDeploymentQuery = useResultQuery(rpcClient.deployment.status, {});
  const revertDeployment = useResultMutation(rpcClient.deployment.revert);
  const revokeDeviceAndRefresh = async (deviceId: string): Promise<void> => {
    const result = await revokeDevice.mutateAsync({ deviceId });
    if (result.status === 'error') throw result.error;
    await devicesQuery.refetch();
  };
  const productProjectsQuery = useResultQuery(rpcClient.project.list, { lifecycle: 'active' });
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
  const providersQuery = useResultQuery(rpcClient.providers.list, {});
  const modelsQuery = useResultQuery(rpcClient.providers.models, {});
  // Usage is fetched only once the Providers tab/step is shown; the first
  // load reads the machine's cache, every explicit refresh bypasses it.
  const [usageVisible, setUsageVisible] = useState(false);
  const [usageRefresh, setUsageRefresh] = useState(false);
  const usageQuery = useResultQuery(rpcClient.providers.usage, { providerId: null, refresh: usageRefresh }, { enabled: usageVisible });
  const startProviderLogin = useResultMutation(rpcClient.providers.login.start);
  const respondProviderLogin = useResultMutation(rpcClient.providers.login.respond);
  const cancelProviderLogin = useResultMutation(rpcClient.providers.login.cancel);
  const logoutProvider = useResultMutation(rpcClient.providers.logout);
  const setProviderApiKey = useResultMutation(rpcClient.providers.apiKey.set);
  const [loginFlow, setLoginFlow] = useState<(ProviderLoginFlow & { done: boolean }) | null>(null);
  const loginStream = useRef<AbortController | null>(null);
  useEffect(() => () => loginStream.current?.abort(), []);
  useEffect(() => {
    const onPopState = () => setRoute(productRouteFromLocation(window.location));
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);
  useEffect(() => {
    if (settingsQuery.state !== 'success') return;
    setDraft((current) => current?.revision === settingsQuery.value.revision ? current : { ...settingsQuery.value });
  }, [settingsQuery.state, settingsQuery.state === 'success' ? settingsQuery.value.revision : null]);
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      for await (const event of rpcClient.settings.events({}, { signal: controller.signal })) {
        if (event.status === 'error') break;
        await Promise.all([settingsQuery.refetch(), ompQuery.refetch(), gitIdentityQuery.refetch()]);
      }
    })();
    return () => controller.abort();
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      for await (const event of rpcClient.machine.events({}, { signal: controller.signal })) {
        if (event.status === 'error') break;
        await machinesQuery.refetch();
      }
    })();
    return () => controller.abort();
  }, []);
  const navigateProduct = (next: ProductRoute, mode: 'push' | 'replace' = 'push', section: 'source' | null = null): void => {
    const url = setProductRoute(new URL(window.location.href), next);
    if (section) url.searchParams.set('section', section);
    else url.searchParams.delete('section');
    window.history[mode === 'push' ? 'pushState' : 'replaceState'](null, '', url);
    setRoute(next);
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
    await saveSettings({ ...next, onboardingComplete: true });
    navigateProduct('agent', 'replace');
  };
  const refreshProviders = async (): Promise<void> => {
    await Promise.all([providersQuery.refetch(), modelsQuery.refetch()]);
    if (usageVisible) await usageQuery.refetch();
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
    if (providersQuery.state === 'failure') await providersQuery.refetch();
    if (usageRefresh) await usageQuery.refetch();
    else setUsageRefresh(true);
  };
  const providerViews = providersQuery.state === 'success' ? providersQuery.value.providers : [];
  const providersSection: ProvidersSectionProps = {
    providers: providerViews,
    ...(providersQuery.state === 'failure' ? { error: providersQuery.error.message } : {}),
    usage: usageQuery.state === 'success' ? usageQuery.value : usageQuery.state === 'failure' ? usageQuery.previous ?? null : null,
    usageStatus: !usageVisible ? 'idle' : usageQuery.state === 'failure' ? 'error' : usageQuery.state === 'pending' || usageQuery.fetch === 'fetching' ? 'loading' : 'ready',
    ...(usageQuery.state === 'failure' ? { usageError: usageQuery.error.message } : {}),
    onShow: () => setUsageVisible(true),
    onRefreshUsage: refreshUsage,
    onSignIn: signInProvider,
    onSignOut: signOutProvider,
    onSetApiKey: saveProviderApiKey,
    login: { flow: loginFlow, respond: respondLogin, cancel: dismissLogin },
  };
  if (settingsQuery.state === 'pending' || !draft || ompQuery.state === 'pending' || gitIdentityQuery.state === 'pending') {
    return <main className="flex h-dvh items-center justify-center bg-background"><EmptyState icon={<ThinkingIndicator />} title="Opening your GitSpace account…" description="Loading cloud settings and OMP configuration." /></main>;
  }
  if (settingsQuery.state === 'failure' || ompQuery.state === 'failure' || gitIdentityQuery.state === 'failure') {
    const message = settingsQuery.state === 'failure' ? settingsQuery.error.message : ompQuery.state === 'failure' ? ompQuery.error.message : gitIdentityQuery.state === 'failure' ? gitIdentityQuery.error.message : 'Cloud settings are unavailable';
    return <main className="flex h-dvh items-center justify-center bg-background"><EmptyState title="GitSpace setup is unavailable" description={message} action={<Button variant="ghost" onClick={() => { void settingsQuery.refetch(); void ompQuery.refetch(); void gitIdentityQuery.refetch(); }}>Retry</Button>} /></main>;
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
    projects={productProjectsQuery.state === 'success' ? productProjectsQuery.value.map((project) => ({ id: project.id, name: project.name })) : []}
    onBack={() => navigateProduct('agent', 'replace')}
    onComplete={completeOnboarding}
    saving={updateSettings.state === 'pending' || reserveHandle.state === 'pending' || setOmpSetting.state === 'pending' || updateMachineNotes.state === 'pending' || createSandboxMachine.state === 'pending' || sleepMachine.state === 'pending' || resumeMachine.state === 'pending' || destroyMachine.state === 'pending' || revertDeployment.state === 'pending'}
    error={settingsError}
  />;
  if (!draft.onboardingComplete || forceOnboarding) return page('onboarding');
  if (route === 'settings') return page('settings');
  return <LiveWorkspace onOpenSettings={(section) => navigateProduct('settings', 'push', section ?? null)} enterAction={draft.defaults.enterAction} defaultMachineId={draft.defaults.machineId} activeView={route} onNavigateView={(next) => navigateProduct(next)} user={{ name: draft.profile.displayName, handle: draft.profile.handle }} providers={providerViews} />;
}

type DeviceGateState =
  | { status: 'loading' }
  | { status: 'enrolling' }
  | { status: 'enrolled' }
  | { status: 'unenrolled'; error: string | null };

/**
 * Nothing renders until this browser holds an enrolled device: `?enroll=`
 * redeems an invite, a stored device passes straight through, and a
 * machine-side rejection (revoked, expired) drops back to this screen.
 */
function DeviceGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<DeviceGateState>({ status: 'loading' });
  const [pasted, setPasted] = useState('');
  const redeem = async (token: string): Promise<void> => {
    setState({ status: 'enrolling' });
    try {
      setCurrentDevice(await enrollDevice(token));
      const url = new URL(window.location.href);
      url.searchParams.delete('enroll');
      window.history.replaceState(null, '', url);
      setState({ status: 'enrolled' });
    } catch (error) {
      setState({ status: 'unenrolled', error: error instanceof Error ? error.message : 'Enrollment failed' });
    }
  };
  useEffect(() => {
    const token = new URL(window.location.href).searchParams.get('enroll');
    if (token) void redeem(token);
    else void currentDevice().then((device) => setState(device ? { status: 'enrolled' } : { status: 'unenrolled', error: null }));
    const onRejected = (event: Event): void => {
      const code = event instanceof CustomEvent ? String(event.detail?.code ?? '') : '';
      setState({ status: 'unenrolled', error: code === 'SIGNED_OUT' ? 'You signed out of this browser.' : 'This browser’s access was revoked. Reconnect with a new enrollment link.' });
    };
    window.addEventListener(DEVICE_REJECTED_EVENT, onRejected);
    return () => window.removeEventListener(DEVICE_REJECTED_EVENT, onRejected);
  }, []);
  if (state.status === 'enrolled') return <>{children}</>;
  if (state.status === 'loading' || state.status === 'enrolling') {
    return <main className="flex h-dvh items-center justify-center bg-background"><EmptyState icon={<ThinkingIndicator />} title={state.status === 'enrolling' ? 'Connecting this browser…' : 'Checking this browser…'} description="Device identity is verified by your machines, not by the cloud." /></main>;
  }
  const submit = (): void => {
    const trimmed = pasted.trim();
    let token = trimmed;
    try { token = new URL(trimmed).searchParams.get('enroll') ?? trimmed; } catch { /* a bare token */ }
    if (token) void redeem(token);
  };
  return <main className="flex h-dvh items-center justify-center bg-background p-6">
    <div className="w-full max-w-md">
      <EmptyState
        icon={<Key01 width={20} height={20} strokeWidth={1.5} />}
        title="This browser isn’t connected"
        description={state.error ?? 'Open the link printed by `gssh web`, or paste it here. Each browser gets its own revocable device key.'}
        action={<form className="flex w-full items-center gap-2" onSubmit={(event) => { event.preventDefault(); submit(); }}>
          <InputGroup className="flex-1"><InputField index={0} label="Enrollment link" labelHidden value={pasted} placeholder="Paste the enrollment link" onChange={setPasted} /></InputGroup>
          <Button variant="primary" type="submit" disabled={!pasted.trim()}>Connect</Button>
        </form>}
      />
    </div>
  </main>;
}

export function LiveApp() {
  return <DeviceGate><ResultRpcProvider client={rpcClient}><GitSpaceProduct /></ResultRpcProvider></DeviceGate>;
}
