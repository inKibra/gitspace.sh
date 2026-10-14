import { join } from 'node:path';
import {
  CloudDataCheckpointBlobStore,
  CloudSpaceCheckpointAuthority,
  BrowserRelaySupervisor,
  CanonicalSettingsCoordinator,
  MachineMcpCoordinator,
  SharedGitIdentityCoordinator,
  ArtifactsGitRemote,
  WorkspaceHubTerminalCoordinator,
  createGitSpaceRpcHandler,
  startGitSpaceRpcHttpServer,
  type WorkspaceCheckouts,
} from './index.js';
import { installDefaultGitSpaceSkills } from './default-skills.js';
import { WorkspaceServiceManager } from './workspace-services.js';
import { createServiceAccessClient } from './service-forward.js';
import { WorkspaceEnvironmentManager } from './workspace-environment.js';
import { createServerClock, credentialProtocolBase64, relayNoticeSchema, type RelayNoticeTopic } from '@gitspace/protocol';
import { receiveMachineNotices, type MachineNoticeTargets } from './machine-notices.js';
import { appendFileSync, existsSync } from 'node:fs';
import { DeviceRegistry } from './device-registry.js';
import { createSignedRpcHandler } from './signed-rpc.js';
import { DeploymentLauncher } from './deployment-launcher.js';
import { atomicJson } from './machine-update.js';
import { ReleaseFollower } from './release-follower.js';
import { createCloudGitLfsPublisher, createCloudGitLfsStore } from './cloud-lfs-store.js';
import type { MachineGitLfsAccess } from './git-lfs.js';
import { machineToolEnvironment, prepareMachineNativeRuntime } from '../../deployment/src/native-runtime.js';
import { pinnedGitLfs, pinnedRipgrep } from '../../deployment/src/native-build.js';
import { CloudRuntimeClient } from './cloud-runtime-client.js';
import { z } from 'zod';
import { createMachineExecutor, type MachineExecutorRuntime } from './runtime-executor.js';
import { machineOperationalTools } from './runtime-operations.js';
import { RuntimeSnapshotCommitInputSchema, RuntimeSnapshotCommitResultSchema } from '@gitspace/protocol-runtime';
import type { LocalAttachment } from '@gitspace/runtime-machine';

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function artifactKey(): Uint8Array {
  const key = Uint8Array.from(Buffer.from(requiredEnvironment('GITSPACE_ARTIFACT_KEY'), 'base64'));
  if (key.byteLength !== 32) throw new Error('GITSPACE_ARTIFACT_KEY must decode to 32 bytes');
  return key;
}

function signingKey(): Uint8Array {
  const key = Uint8Array.from(Buffer.from(requiredEnvironment('GITSPACE_MACHINE_SIGNING_PRIVATE_KEY'), 'base64'));
  if (key.byteLength !== 32) throw new Error('GITSPACE_MACHINE_SIGNING_PRIVATE_KEY must decode to 32 bytes');
  return key;
}

export async function startMachineRuntime() {
  const nativeRoot = process.env.GITSPACE_MACHINE_RUNTIME_PATH ?? import.meta.dir;
  const packaged = Boolean(process.env.GITSPACE_MACHINE_RUNTIME_PATH) || await Bun.file(join(nativeRoot, 'machine-native.json')).exists();
  process.env.GITSPACE_SUPERVISOR_WORKER_ENTRY = packaged ? join(nativeRoot, 'machine-worker.js') : join(import.meta.dir, 'terminal-worker.ts');
  const native = packaged
    ? await prepareMachineNativeRuntime(nativeRoot)
    : { gitLfs: (await pinnedGitLfs()).path, ripgrep: (await pinnedRipgrep()).path };
  if (packaged) process.env.GITSPACE_MACHINE_RUNTIME_PATH = nativeRoot;
  // Hosts already start this process with the tool directory; this also covers source runs and older hosts
  // for children spawned from process.env (OMP sessions, terminals, lifecycle scripts).
  Object.assign(process.env, machineToolEnvironment(process.env, native));
  const environmentRoot = requiredEnvironment('GITSPACE_ENVIRONMENT_ROOT');
  const machineId = requiredEnvironment('GITSPACE_MACHINE_ID');
  const encryptionKey = artifactKey();
  const controlOptions = {
    baseUrl: requiredEnvironment('GITSPACE_CONTROL_URL'),
    userId: requiredEnvironment('GITSPACE_USER_ID'),
    machineId,
    signingPrivateKey: signingKey(),
    // One account clock for every signer in this process, including the settings socket that cannot see its rejection.
    clock: createServerClock(),
  };
  const serviceAccess = createServiceAccessClient(controlOptions);
  const authority = new CloudSpaceCheckpointAuthority(controlOptions);
  const checkpointBlobs = new CloudDataCheckpointBlobStore(controlOptions);
  const cloudRuntime = new CloudRuntimeClient(controlOptions);
  const bootstrapProjectId = process.env.GITSPACE_BOOTSTRAP_PROJECT_ID;
  let executorRuntime: MachineExecutorRuntime | null = null;
  const readyCheckout = (spaceId: string): LocalAttachment | null =>
    executorRuntime?.journal.attachments().find(local => local.attachment.workspaceId === spaceId && local.attachment.state === 'ready') ?? null;
  const checkouts: WorkspaceCheckouts = {
    path: spaceId => readyCheckout(spaceId)?.rootPath ?? null,
    projectId: spaceId => readyCheckout(spaceId)?.attachment.projectId ?? null,
    list: () => [...new Set((executorRuntime?.journal.attachments() ?? []).filter(local => local.attachment.state === 'ready').map(local => local.attachment.workspaceId))],
    use: async spaceId => { if (executorRuntime) await executorRuntime.useWorkspace(spaceId); },
    changed: async () => { await executorRuntime?.sync(); },
  };
  const gitIdentity = new SharedGitIdentityCoordinator(
    authority,
    environmentRoot,
    // Checkouts commit as the account (agents run `git commit` there).
    () => (executorRuntime?.journal.attachments() ?? []).filter(local => local.attachment.state !== 'detached').map(local => local.rootPath),
  );
  await gitIdentity.start();
  await installDefaultGitSpaceSkills(join(environmentRoot, 'agent'));
  const mcp = new MachineMcpCoordinator(authority, machineId);
  const machineReleaseSha = process.env.GITSPACE_MACHINE_RELEASE_SHA || null;
  const releases = new ReleaseFollower({
    authority,
    blobs: checkpointBlobs,
    machineId,
    environmentRoot,
    hostUrl: process.env.GITSPACE_HOST_URL ?? null,
    controlToken: process.env.GITSPACE_CONTROL_TOKEN ?? null,
    runningMachineSha: machineReleaseSha,
    generation: process.env.GITSPACE_GENERATION_HASH ?? null,
    onError: (error) => console.error('[gitspace-deploy]', error),
  });
  const managedSpaceRoot = requiredEnvironment('GITSPACE_MANAGED_SPACE_ROOT');
  const settings = new CanonicalSettingsCoordinator(
    authority,
    (userSettings) => gitIdentity.apply(userSettings),
  );
  await settings.start();
  const existingMachine = (await authority.listMachineDefinitions()).find((machine) => machine.id === machineId);
  const browserEnabled = existingMachine?.kind === 'physical' && existingMachine.provider === 'physical';
  const browserRelay = new BrowserRelaySupervisor({
    environmentRoot, machineId, enabled: browserEnabled, accountUrl: controlOptions.baseUrl,
  });
  if (browserEnabled && !process.env.GITSPACE_UPDATE_OWNER && (await browserRelay.status()).installed) {
    void browserRelay.start().catch((error) => console.error('[gitspace-browser-relay]', error));
  }
  const repositoryCredentialsSchema = z.object({ remote: z.url(), plaintext: z.string().min(1), expiresAt: z.iso.datetime() });
  const gitRemote = new ArtifactsGitRemote({
    credentials: (binding, scope) => cloudRuntime.call('runtime.repository.credentials', { ...binding, scope }, repositoryCredentialsSchema),
  });
  const lfsOrigin = async (projectId: string) => {
    const project = await authority.getProject(projectId);
    if (!project) throw new Error('LFS project is unavailable');
    return {
      canonicalOrigin: project.repositoryReference,
      originEnvironment: async (repositoryPath: string) => {
        const origin = Bun.spawn(['git', 'remote', 'get-url', 'origin'], { cwd: repositoryPath, stdout: 'pipe', stderr: 'pipe' });
        const [code, url, error] = await Promise.all([origin.exited, new Response(origin.stdout).text(), new Response(origin.stderr).text()]);
        if (code !== 0) throw new Error(`LFS origin is unavailable: ${error}`);
        return gitIdentity.gitEnvironment(url.trim());
      },
    };
  };
  const lfs: MachineGitLfsAccess = {
    read: async projectId => {
      const origin = await lfsOrigin(projectId);
      const store = await createCloudGitLfsStore({ projectId, blobs: checkpointBlobs, encryptionKey, controlOptions });
      return { ...origin, store, confirmOrigin: confirmation => store.confirmOrigin(confirmation), resolveSources: objects => store.resolveSources(objects) };
    },
    publish: async (projectId, publicationId) => {
      const origin = await lfsOrigin(projectId);
      const store = await createCloudGitLfsPublisher({ projectId, publicationId, blobs: checkpointBlobs, encryptionKey, controlOptions });
      return {
        ...origin, store,
        confirmOrigin: confirmation => store.confirmOrigin(confirmation),
        resolveSources: objects => store.resolveSources(objects),
        releasePublication: () => store.releasePublication(),
      };
    },
  };
  const terminals = new WorkspaceHubTerminalCoordinator(machineId, checkouts);
  const environments = new WorkspaceEnvironmentManager(checkouts, authority, terminals, authority, {
    machineId,
    stateRoot: join(environmentRoot, 'lifecycle-runs'),
  });
  const serviceManager = new WorkspaceServiceManager(
    checkouts,
    terminals,
    machineId,
    environmentRoot,
    process.env.GITSPACE_SERVICE_DOMAIN ?? null,
    process.env.GITSPACE_SERVICE_NAMESPACE ?? null,
    authority,
    serviceAccess.trust,
  );
  let startupCommitted = !process.env.GITSPACE_UPDATE_OWNER;
  // Pinned at enrollment, never fetched from the worker: every device grant is
  // verified against this key locally, so the control plane cannot mint callers.
  const devices = new DeviceRegistry({
    authority,
    rootSigningPublicKey: credentialProtocolBase64.decode(requiredEnvironment('GITSPACE_ROOT_PUBLIC_KEY')),
    onError: (error) => console.error('[gitspace-devices]', error),
  });
  // A read a notice asked for that fails is asked for again with backoff until it succeeds; a healthy machine reads only
  // when notified. A failed workspace read retries as an assignments read, which applies every ready checkout's version.
  const noticeFailures = new Map<RelayNoticeTopic, number>();
  const settled = async (topic: RelayNoticeTopic, read: Promise<void>) => { await read; noticeFailures.delete(topic); };
  const noticeTargets: MachineNoticeTargets = {
    assignments: () => settled('assignments', (async () => { await executorRuntime?.sync(); })()),
    snapshot: async (workspaceId) => { await executorRuntime?.refreshWorkspace(workspaceId); },
    release: () => settled('release', releases.nudge()),
    devices: () => devices.invalidate(),
    settings: () => settled('settings', settings.refresh()),
    environment: (workspaceId) => authority.wakeLifecycleWatches(workspaceId),
    failed: (topic, error) => {
      console.error('[gitspace-notice]', topic, error);
      const retry = topic === 'workspace.snapshot' ? 'assignments' : topic;
      const attempt = (noticeFailures.get(retry) ?? 0) + 1;
      noticeFailures.set(retry, attempt);
      setTimeout(() => receiveMachineNotices([{ topics: [retry] }], noticeTargets), Math.min(60_000, 1000 * 2 ** attempt));
    },
  };
  // Account-owned releases build from this executor's ready canonical cache.
  const launcher = new DeploymentLauncher({
    attachments: () => executorRuntime?.journal.attachments() ?? [],
    machineId,
    authority,
    blobs: checkpointBlobs,
    buildRoot: join(environmentRoot, 'builds'),
  });
  const rpc = createGitSpaceRpcHandler({
    machineId,
    terminals,
    environments,
    deployment: { launch: (input) => launcher.launch(input) },
    onInternalError: ({ incidentId, phase, cause, procedurePath }) => {
      console.error('[gitspace-rpc]', { incidentId, phase, procedurePath, cause });
    },
  });
  let preparingReplacement = !startupCommitted;
  let activeRpcRequests = 0;
  let replacementControl: Promise<unknown> = Promise.resolve();
  /** Stops local work and pushes the machine's changes; the cloud store then holds everything a successor needs. */
  const prepareReplacement = async () => {
    preparingReplacement = true;
    while (activeRpcRequests > 0) await Bun.sleep(25);
    for (const spaceId of checkouts.list()) await terminals.stopOwned(spaceId);
    await serviceManager.dispose();
    await executorRuntime?.sync();
    return { prepared: true, machineId };
  };
  const cancelReplacement = async () => {
    await serviceManager.rehydrate();
    preparingReplacement = false;
    return { prepared: false, machineId };
  };
  const rpcHandler = createSignedRpcHandler({
    handler: rpc.handler,
    lookupDevice: (deviceId) => devices.lookup(deviceId),
    procedureKind: rpc.procedureKind,
    workspaceProject: (workspaceId) => checkouts.projectId(workspaceId),
  });
  const http = startGitSpaceRpcHttpServer({
    handler: async (request) => {
      if (preparingReplacement) return Response.json({ error: 'Machine is prepared for provider replacement' }, { status: 503 });
      activeRpcRequests += 1;
      try { return await rpcHandler(request); }
      finally { activeRpcRequests -= 1; }
    },
    hostname: process.env.GITSPACE_RPC_HOST ?? '127.0.0.1',
    releaseStatus: () => ({ machineRelease: machineReleaseSha }),
    port: Number(process.env.GITSPACE_RPC_PORT ?? 0),
    additionalFetch: async (request) => {
      const service = preparingReplacement ? null : await serviceManager.proxy(request);
      if (new URL(request.url).pathname === '/runtime/execute') {
        if (preparingReplacement || !executorRuntime) return Response.json({ error: 'Executor unavailable' }, { status: 503 });
        return executorRuntime.executor.fetch(request);
      }
      if (service) return service;
      const url = new URL(request.url);
      if (!url.pathname.startsWith('/__control/') || request.method !== 'POST') return null;
      const token = process.env.GITSPACE_CONTROL_TOKEN;
      if (!token || request.headers.get('authorization') !== `Bearer ${token}`) {
        return Response.json({ error: 'unauthorized' }, { status: 401 });
      }
      // A successor retires this generation; stopping holds no workspace state to hand over.
      if (url.pathname === '/__control/retire') return Response.json({ stopMode: 'replace' });
      if (url.pathname === '/__control/prepare-replacement' || url.pathname === '/__control/cancel-replacement') {
        const operation = replacementControl.then(() => url.pathname === '/__control/prepare-replacement' ? prepareReplacement() : cancelReplacement());
        replacementControl = operation.catch(() => undefined);
        try { return Response.json(await operation); }
        catch (error) {
          try { await cancelReplacement(); } catch { /* The provider retries cancellation. */ }
          return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 409 });
        }
      }
      if (preparingReplacement) return Response.json({ error: 'Provider replacement preparation is active' }, { status: 409 });
      if (url.pathname === '/__control/notice') {
        const { notices } = z.object({ notices: z.array(relayNoticeSchema).max(256) }).parse(await request.json());
        receiveMachineNotices(notices, noticeTargets);
        return Response.json({ received: true });
      }
      if (url.pathname !== '/__control/code-version') return null;
      const input = z.object({ hash: z.string().optional() }).parse(await request.json());
      const hash = input.hash ?? 'unknown';
      if (!bootstrapProjectId) return Response.json({ offset: null });
      const event = await authority.appendProjectEvent({ eventId: crypto.randomUUID(), projectId: bootstrapProjectId,
        scope: 'code',
        entity: 'frontend-generation',
        entityId: hash,
        revision: Date.now(),
        operation: 'code-version',
        payload: { hash, replacing: false } });
      return Response.json({ offset: event.offset });
    },
  });
  executorRuntime = await createMachineExecutor({
    environmentRoot, managedSpaceRoot, machineId, cloud: cloudRuntime, gitRemote, lfs,
    browser: { enabled: true, services: {
      serviceHostname: hostname => hostname.endsWith(`--${process.env.GITSPACE_SERVICE_NAMESPACE}-srv.${process.env.GITSPACE_SERVICE_DOMAIN}`),
      workspaceServiceHostname: async (hostname, scope) => (await authority.listHostedRoutes(scope.projectId)).some(route => route.workspaceId === scope.workspaceId && route.hostname === hostname),
      serviceForward: serviceAccess.forward,
    } },
    prepareAttachment: async (local, signal, progress) => {
      await gitIdentity.apply(await settings.getUserSettings(), [local.rootPath]);
      await environments.prepareAttachment(local, signal, progress);
    },
    ...(process.env.GITSPACE_ARTIFACTFS_BINARY ? { artifactFsBinary: process.env.GITSPACE_ARTIFACTFS_BINARY } : {}),
    operations: machineOperationalTools({ environments, services: serviceManager, authority, mcp }),
    commitSnapshot: async (local, checkpoint, previousWorktreeCommit) => {
      const accepted = await cloudRuntime.call('runtime.snapshot.commit', RuntimeSnapshotCommitInputSchema.parse({
        projectId: local.attachment.projectId, workspaceId: local.attachment.workspaceId,
        attachmentId: local.attachment.attachmentId, generation: local.attachment.generation, checkpoint, previousWorktreeCommit,
      }), RuntimeSnapshotCommitResultSchema);
      return accepted.checkpoint;
    },
  });

  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    preparingReplacement = true;
    if (bootstrapProjectId) {
      await authority.appendProjectEvent({ eventId: crypto.randomUUID(), projectId: bootstrapProjectId,
        scope: 'code',
        entity: 'machine-generation',
        entityId: process.env.GITSPACE_GENERATION_HASH ?? 'unknown',
        revision: Date.now(),
        operation: 'code-version',
        payload: { replacing: true } });
      await Bun.sleep(150);
    }
    releases.stop();
    await serviceManager.dispose();
    await executorRuntime?.close();
    await http.stop();
  };
  const shutdown = (): void => {
    void stop()
      .catch((error) => {
        try { appendFileSync(join(environmentRoot, 'stop.log'), `${new Date().toISOString()} [gitspace-stop] failed ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`); } catch { /* diagnostics only */ }
      })
      .finally(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  process.env.GITSPACE_MACHINE_LOCAL_URL = http.url;
  await atomicJson(join(environmentRoot, 'host-machine.json'), {
    pid: process.pid, hostPid: Number(process.env.GITSPACE_HOST_PID) || process.ppid,
    url: http.url, hash: process.env.GITSPACE_GENERATION_HASH,
  });
  console.log(`GitSpace RPC ready at ${http.url}/rpc generation=${process.env.GITSPACE_GENERATION_HASH ?? 'unknown'} machine=${machineReleaseSha ?? 'local'} runtime=cloud`);
  if (startupCommitted) {
    await environments.recoverInterruptedRuns();
    await serviceManager.rehydrate();
  } else {
    // Health is available to the updater, but no service or user RPC may run
    // until the whole host's durable transaction has finished.
    while (existsSync(join(environmentRoot, 'machine-update.json'))) {
      if (stopping) return { environmentRoot, settings, http, stop };
      await Bun.sleep(100);
    }
    if (stopping) return { environmentRoot, settings, http, stop };
    await environments.recoverInterruptedRuns();
    await serviceManager.rehydrate();
    if ((await browserRelay.status()).installed) {
      void browserRelay.start().catch((error) => console.error('[gitspace-browser-relay]', error));
    }
    startupCommitted = true;
    preparingReplacement = false;
  }
  await releases.start();
  return { environmentRoot, settings, http, stop };
}

if (import.meta.main) await startMachineRuntime();
