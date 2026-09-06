import { join } from 'node:path';
import {
  GitSpaceDatabase,
  GitSpaceHandlers,
  LocalArtifactResolver,
  artifactScopes,
} from '@gitspace/core';
import {
  CloudDataCheckpointBlobStore,
  ClosedSpaceTranscriptReader,
  CloudSpaceCheckpointAuthority,
  BrowserRelaySupervisor,
  CanonicalSettingsCoordinator,
  ProcessOmpRuntime,
  EncryptedCheckpointBlobStore,
  MachinePortableSpaceController,
  MachineSessionCoordinator,
  MachineMcpCoordinator,
  ProviderAuthCoordinator,
  SharedGitIdentityCoordinator,
  PortableSpaceLifecycle,
  WalgitSupervisor,
  WorkspaceHubTerminalCoordinator,
  createGitSpaceRpcHandler,
  runNextProjectCron,
  sharedAuthStorage,
  startGitSpaceRpcHttpServer,
  type WalgitProjectBinding,
} from './index.js';
import { installDefaultGitSpaceSkills } from './default-skills.js';
import { WorkspaceServiceManager } from './workspace-services.js';
import { credentialProtocolBase64 } from '@gitspace/protocol';
import { appendFileSync, existsSync } from 'node:fs';
import { postmortem } from '@oh-my-pi/pi-utils';
import { CloudProjectEventWriter } from './cloud-project-events.js';
import { DeviceRegistry } from './device-registry.js';
import { createSignedRpcHandler } from './signed-rpc.js';
import { ProjectLifecycleManager } from './project-lifecycle.js';
import { CloudCanonicalSessionWriter } from './cloud-session-directory.js';
import { DeploymentLauncher } from './deployment-launcher.js';
import { ReleaseFollower } from './release-follower.js';
import { ompGenerationSelectionSchema } from './omp-runtime.js';
import { CloudArtifactObjectStore } from './cloud-artifact-object-store.js';
import { createSpaceWorkspaceControls } from './space-workspace-controls.js';
import type { SpaceWorkspaceControls } from './space-eval-sdk.js';

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

function projectPort(projectId: string): number {
  const hash = new Bun.CryptoHasher('sha256').update(`${process.pid}:${projectId}`).digest();
  return 30_000 + ((hash[0]! << 8 | hash[1]!) % 20_000);
}
export function possessBootstrapSpace(
  database: GitSpaceDatabase,
  spaceId: string | undefined,
  machineId: string,
  newlyCreated: boolean,
  rootPath?: string,
): void {
  if (!spaceId || !newlyCreated) return;
  const possession = database.possessSpace(spaceId, machineId, rootPath);
  if (possession.status === 'error' && database.getSpacePlacement(spaceId)?.holderId !== machineId) {
    throw possession.error;
  }
}


export async function startMachineRuntime() {
  const environmentRoot = requiredEnvironment('GITSPACE_ENVIRONMENT_ROOT');
  const machineId = requiredEnvironment('GITSPACE_MACHINE_ID');
  const database = new GitSpaceDatabase(join(environmentRoot, 'gitspace.db'), {
    ...(process.env.GITSPACE_MIGRATIONS_FOLDER ? { migrationsFolder: process.env.GITSPACE_MIGRATIONS_FOLDER } : {}),
  });
  const bootstrapProjectId = process.env.GITSPACE_BOOTSTRAP_PROJECT_ID;
  const bootstrapWorkspaceId = process.env.GITSPACE_BOOTSTRAP_WORKSPACE_ID;
  let bootstrapProjectCreated = false;
  if (bootstrapProjectId && !database.getProject(bootstrapProjectId)) {
    const created = database.createProject({
      id: bootstrapProjectId,
      name: requiredEnvironment('GITSPACE_BOOTSTRAP_PROJECT_NAME'),
      repositoryPath: requiredEnvironment('GITSPACE_BOOTSTRAP_REPOSITORY_PATH'),
      baseBranch: process.env.GITSPACE_BOOTSTRAP_BASE_BRANCH ?? 'main',
    });
    if (created.status === 'error') throw created.error;
    bootstrapProjectCreated = true;
  }
  let bootstrapWorkspaceCreated = false;
  if (bootstrapWorkspaceId && !database.getWorkspace(bootstrapWorkspaceId)) {
    const created = database.createWorkspace({
      id: bootstrapWorkspaceId,
      projectId: requiredEnvironment('GITSPACE_BOOTSTRAP_PROJECT_ID'),
      name: requiredEnvironment('GITSPACE_BOOTSTRAP_WORKSPACE_NAME'),
      branch: requiredEnvironment('GITSPACE_BOOTSTRAP_WORKSPACE_BRANCH'),
      rootPath: requiredEnvironment('GITSPACE_BOOTSTRAP_WORKSPACE_PATH'),
    });
    if (created.status === 'error') throw created.error;
    bootstrapWorkspaceCreated = true;
  }
  possessBootstrapSpace(
    database,
    bootstrapProjectId,
    machineId,
    bootstrapProjectCreated,
    bootstrapProjectId ? requiredEnvironment('GITSPACE_BOOTSTRAP_REPOSITORY_PATH') : undefined,
  );
  possessBootstrapSpace(database, bootstrapWorkspaceId, machineId, bootstrapWorkspaceCreated);

  const encryptionKey = artifactKey();
  const controlOptions = {
    baseUrl: requiredEnvironment('GITSPACE_CONTROL_URL'),
    userId: requiredEnvironment('GITSPACE_USER_ID'),
    machineId,
    signingPrivateKey: signingKey(),
  };
  const authority = new CloudSpaceCheckpointAuthority(controlOptions);
  const checkpointBlobs = new CloudDataCheckpointBlobStore(controlOptions);
  const artifacts = new LocalArtifactResolver(
    database,
    new CloudArtifactObjectStore(controlOptions.userId, checkpointBlobs),
    join(environmentRoot, 'cache'),
    encryptionKey,
  );
  const projectEventWriter = new CloudProjectEventWriter(authority, (error) => {
    console.error('[gitspace-project-events]', error);
  });
  const canonicalSessionWriter = new CloudCanonicalSessionWriter(authority, checkpointBlobs, (error) => {
    console.error('[gitspace-canonical-sessions]', error);
  });
  const gitIdentity = new SharedGitIdentityCoordinator(
    authority,
    environmentRoot,
    () => {
      const repositories: string[] = [];
      for (const project of database.listProjects()) {
        for (const space of database.listSpaces(project.id)) {
          if (space.holderId === machineId && space.placementState === 'open' && space.generation > 0) {
            repositories.push(space.rootPath);
          }
        }
      }
      return repositories;
    },
  );
  await gitIdentity.start();
  const ompAgentDir = requiredEnvironment('GITSPACE_OMP_AGENT_DIR');
  const configuredSkills = await authority.listSkills();
  await installDefaultGitSpaceSkills(ompAgentDir, configuredSkills.filter((skill) => skill.enabled).map((skill) => skill.id));
  const mcp = new MachineMcpCoordinator(authority, machineId);
  const authStorage = sharedAuthStorage(ompAgentDir);
  const workspaceControls = Promise.withResolvers<SpaceWorkspaceControls>();
  const omp = new ProcessOmpRuntime({
    environmentRoot,
    entrypoint: requiredEnvironment('GITSPACE_OMP_RUNTIME_PATH'),
    manifestHash: requiredEnvironment('GITSPACE_OMP_MANIFEST_HASH'),
    agentDir: ompAgentDir,
    sessionRoot: join(environmentRoot, 'omp-sessions'),
    mcp,
    skills: configuredSkills,
    spaceAuthority: authority,
    workspaceControls: () => ({
      create: async (input) => (await workspaceControls.promise).create(input),
      manage: async (method, workspace, input) => (await workspaceControls.promise).manage(method, workspace, input),
      instructionsChanged: async (projectId, spaceId) => (await workspaceControls.promise).instructionsChanged(projectId, spaceId),
      refreshArtifacts: async (projectId, spaceId) => (await workspaceControls.promise).refreshArtifacts(projectId, spaceId),
    }),
    onError: (error) => console.error('[gitspace-omp]', error),
  });
  await omp.initialize();
  const providers = new ProviderAuthCoordinator({ authStorage, onChanged: () => omp.reloadAuthStorage() });
  const managedSpaceRoot = requiredEnvironment('GITSPACE_MANAGED_SPACE_ROOT');
  const sessions = new MachineSessionCoordinator(
    database,
    artifacts,
    omp,
    machineId,
    join(environmentRoot, 'runtime'),
    projectEventWriter,
    managedSpaceRoot,
    canonicalSessionWriter,
    authority,
  );
  const settings = new CanonicalSettingsCoordinator(
    authority,
    machineId,
    ompAgentDir,
    environmentRoot,
    () => sessions.reloadOmpSettings(),
    (userSettings) => gitIdentity.apply(userSettings),
  );
  await settings.start();
  const browserRelay = new BrowserRelaySupervisor({
    environmentRoot,
    onError: (error) => console.error('[gitspace-browser-relay]', error),
  });
  if ((await browserRelay.status()).installed) {
    void browserRelay.start().catch((error) => console.error('[gitspace-browser-relay]', error));
  }

  for (const project of database.listProjects()) {
    const cloudProject = await authority.bootstrapProject({
      projectId: project.id,
      name: project.name,
      repositoryReference: project.repositoryReference,
      baseBranch: project.baseBranch,
    });
    for (const space of database.listSpaces(project.id)) {
      await authority.putSpaceDefinition({
        projectId: project.id,
        projectName: project.name,
        repositoryReference: project.repositoryReference,
        baseBranch: project.baseBranch,
        spaceId: space.id,
        kind: space.kind,
        name: space.name,
        branch: space.branch,
        phase: space.phase,
      });
    }
    if (cloudProject.lifecycle === 'provisioning') {
      await authority.setProjectLifecycle(project.id, cloudProject.revision, 'active');
    }
  }
  for (const project of await authority.listProjects('active')) {
    if (project.lifecycle === 'cloud-only') continue;
    if (!database.getProject(project.id)) {
      const created = database.createProject({
        id: project.id,
        name: project.name,
        repositoryPath: join(managedSpaceRoot, project.id, 'base'),
        baseBranch: project.baseBranch,
        ...(project.repositoryReference ? { repositoryReference: project.repositoryReference } : {}),
      });
      if (created.status === 'error') throw created.error;
    }
    for (const workspace of await authority.listProjectWorkspaces(project.id)) {
      if (workspace.kind !== 'worktree' || workspace.lifecycle !== 'active' || database.getWorkspace(workspace.id)) continue;
      const created = database.createWorkspace({
        id: workspace.id,
        projectId: project.id,
        name: workspace.name,
        branch: workspace.branch,
        phase: workspace.phase ?? 'code',
        rootPath: join(managedSpaceRoot, project.id, workspace.id),
      });
      if (created.status === 'error') throw created.error;
    }
  }
  const localGitEndpoint = process.env.GITSPACE_GIT_ENDPOINT;
  const gitStorage = localGitEndpoint
    ? {
        endpoint: localGitEndpoint,
        bucket: requiredEnvironment('GITSPACE_GIT_BUCKET'),
        region: process.env.GITSPACE_GIT_REGION ?? 'us-east-1',
      }
    : await authority.gitStorageBinding();
  const gitBinding = (projectId: string): WalgitProjectBinding => ({
    projectId,
    endpoint: gitStorage.endpoint,
    bucket: gitStorage.bucket,
    region: gitStorage.region,
  });
  const walgit = new WalgitSupervisor({
    binaryPath: requiredEnvironment('GITSPACE_WALGIT_BINARY'),
    runtimeRoot: join(environmentRoot, 'runtime'),
    credentials: async (binding) => localGitEndpoint
      ? {
          accessKeyId: requiredEnvironment('GITSPACE_GIT_ACCESS_KEY_ID'),
          secretAccessKey: requiredEnvironment('GITSPACE_GIT_SECRET_ACCESS_KEY'),
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000),
        }
      : authority.projectRepositoryCredentials(binding.projectId),
    port: (binding) => projectPort(binding.projectId),
  });
  const encryptedCheckpointBlobs = new EncryptedCheckpointBlobStore(checkpointBlobs, encryptionKey);
  const lifecycle = new PortableSpaceLifecycle(authority, encryptedCheckpointBlobs, walgit);
  const closedSpaceTranscripts = new ClosedSpaceTranscriptReader(authority, encryptedCheckpointBlobs, (bytes) => omp.checkpointTranscript(bytes));
  const spaces = new MachinePortableSpaceController(
    database,
    sessions,
    lifecycle,
    machineId,
    gitBinding,
    (spaceId) => authority.getSpaceDefinition(spaceId),
    managedSpaceRoot,
  );
  const recoverableSpaces = new Set<string>();
  const restoredSpaces = new Set<string>();
  for (const project of database.listProjects()) {
    for (const space of database.listSpaces(project.id)) {
      let cloud = await authority.getSpace(project.id, space.id);
      if (!cloud && space.holderId === machineId && space.placementState === 'open' && existsSync(join(space.rootPath, '.git'))) {
        await authority.bootstrap({ projectId: project.id, spaceId: space.id });
        cloud = await authority.getSpace(project.id, space.id);
      }
      const locallyOwned = space.holderId === machineId && space.placementState === 'open';
      const current = cloud?.state === 'open' && cloud.machineId === machineId && cloud.generation === space.generation;
      if (locallyOwned && (!current || !existsSync(join(space.rootPath, '.git')))) {
        const fenced = database.invalidateSpacePossession({ spaceId: space.id, holderId: machineId, expectedGeneration: space.generation });
        if (fenced.status === 'error') throw fenced.error;
      }
      if (cloud?.state === 'closed' && cloud.resumeMachineId === machineId) {
        try {
          await spaces.open(space.id, cloud.generation, { resumeOnMachineRestart: true, deferAgentStart: true });
          restoredSpaces.add(space.id);
          recoverableSpaces.add(space.id);
        } catch (error) {
          console.error('[gitspace-recovery] checkpoint restore failed; space remains unavailable', space.id, error);
        }
      } else if (locallyOwned && current && existsSync(join(space.rootPath, '.git'))) {
        recoverableSpaces.add(space.id);
      } else if (cloud?.machineId === machineId) {
        console.error(`[gitspace-recovery] ${space.id} unavailable: cloud ${cloud.state} generation ${cloud.generation}, local generation ${space.generation}; ${cloud.manifestKey ? `checkpoint revision ${cloud.checkpointRevision} predates the uncheckpointed disk loss and is not current work` : 'no durable repository checkpoint exists'}. Restore the intact machine or explicitly reset legacy rehearsal data.`);
      }
    }
  }
  const localScopes = new Map(database.orm.select().from(artifactScopes).all().map((scope) => [scope.spaceId, scope]));
  for (const project of database.listProjects()) {
    const projectSpaces = database.listSpaces(project.id);
    if (!projectSpaces.some((space) => recoverableSpaces.has(space.id))) continue;
    for (const scope of await authority.listArtifactScopes(project.id)) {
      if (!recoverableSpaces.has(scope.workspaceId) || restoredSpaces.has(scope.workspaceId)) continue;
      const local = localScopes.get(scope.workspaceId);
      if (local && (local.dirty || local.generation >= scope.generation)) continue;
      const restored = await artifacts.restoreScope({
        id: scope.id, spaceId: scope.workspaceId, generation: scope.generation, manifestHash: scope.manifestHash,
        dirty: false, createdAt: scope.updatedAt, updatedAt: scope.updatedAt,
      });
      if (restored.status === 'error') {
        recoverableSpaces.delete(scope.workspaceId);
        const localSpace = database.getSpace(scope.workspaceId);
        if (localSpace?.holderId === machineId) database.invalidateSpacePossession({ spaceId: localSpace.id, holderId: machineId, expectedGeneration: localSpace.generation });
        console.error('[gitspace-recovery] durable artifact scope unavailable', scope.workspaceId, restored.error);
      }
    }
    for (const session of await authority.listCanonicalSessions(project.id)) {
      if (!recoverableSpaces.has(session.workspaceId) || sessions.get(session.id)) continue;
      try {
        if (!session.sessionObjectKey || !session.sessionObjectHash) throw new Error('Canonical session has no durable session object');
        const bytes = await checkpointBlobs.get(session.sessionObjectKey, session.sessionObjectHash);
        if (!bytes) throw new Error(`Canonical session object ${session.sessionObjectKey} does not exist`);
        await sessions.materializeCanonicalSession(session, bytes);
      } catch (error) {
        recoverableSpaces.delete(session.workspaceId);
        const localSpace = database.getSpace(session.workspaceId);
        if (localSpace?.holderId === machineId) database.invalidateSpacePossession({ spaceId: localSpace.id, holderId: machineId, expectedGeneration: localSpace.generation });
        console.error('[gitspace-recovery] canonical session unavailable', session.id, error);
      }
    }
    for (const space of projectSpaces) {
      if (!recoverableSpaces.has(space.id)) continue;
      if (restoredSpaces.has(space.id)) {
        const opened = await sessions.openSpace(space.id);
        if (opened.status === 'error') {
          database.invalidateSpacePossession({ spaceId: space.id, holderId: machineId, expectedGeneration: space.generation });
          console.error('[gitspace-recovery] restored canonical agent unavailable', space.id, opened.error);
          continue;
        }
      }
      const recovered = await sessions.recover(space.id);
      if (recovered.status === 'error') {
        database.invalidateSpacePossession({ spaceId: space.id, holderId: machineId, expectedGeneration: space.generation });
        console.error('[gitspace-recovery] canonical agent unavailable', space.id, recovered.error);
        continue;
      }
      await authority.bootstrapInspector({ projectId: project.id, spaceId: space.id });
      for (const session of sessions.list(space.id)) canonicalSessionWriter.put(project.id, machineId, session, true);
    }
  }
  await canonicalSessionWriter.flush().catch((error) => console.error('[gitspace-recovery] canonical publication failed', error));
  await gitIdentity.apply(await settings.getUserSettings());
  const checkpointSpace = async (spaceId: string): Promise<void> => {
    const space = database.getSpace(spaceId);
    if (!space || space.holderId !== machineId || space.placementState !== 'open') throw new Error(`Space ${spaceId} is not held here`);
    await gitIdentity.apply(await settings.getUserSettings(), [space.rootPath]);
    const opened = await sessions.openSpace(spaceId);
    if (opened.status === 'error') throw opened.error;
    await spaces.release(space, space.generation);
    await spaces.open(space.id, space.generation + 1, { resumeOnMachineRestart: true });
    await canonicalSessionWriter.flush();
  };
  const projectLifecycle = new ProjectLifecycleManager(database, authority, machineId, managedSpaceRoot, checkpointSpace, (repositoryUrl) => gitIdentity.gitEnvironment(repositoryUrl));

  const handlers = new GitSpaceHandlers(database, artifacts, projectEventWriter);
  const terminals = new WorkspaceHubTerminalCoordinator(database, machineId);
  workspaceControls.resolve(createSpaceWorkspaceControls({
    database, authority, projects: projectLifecycle, spaces, sessions, machineId,
    stopTerminals: (spaceId) => terminals.stopOwned(spaceId),
  }));
  const serviceManager = new WorkspaceServiceManager(
    database,
    terminals,
    machineId,
    environmentRoot,
    process.env.GITSPACE_SERVICE_DOMAIN ?? null,
    process.env.GITSPACE_SERVICE_NAMESPACE ?? null,
    authority,
  );
  await serviceManager.rehydrate();
  // Pinned at enrollment, never fetched from the worker: every device grant is
  // verified against this key locally, so the control plane cannot mint callers.
  const devices = new DeviceRegistry({
    database,
    authority,
    rootSigningPublicKey: credentialProtocolBase64.decode(requiredEnvironment('GITSPACE_ROOT_PUBLIC_KEY')),
    onError: (error) => console.error('[gitspace-devices]', error),
  });
  await devices.start();
  // Account-owned releases are built here; machine and OMP identities converge independently.
  const machineReleaseSha = process.env.GITSPACE_MACHINE_RELEASE_SHA || null;
  const launcher = new DeploymentLauncher({
    database,
    machineId,
    authority,
    blobs: checkpointBlobs,
    events: projectEventWriter,
    buildRoot: join(environmentRoot, 'builds'),
  });
  const releases = new ReleaseFollower({
    authority,
    blobs: checkpointBlobs,
    machineId,
    environmentRoot,
    hostUrl: process.env.GITSPACE_HOST_URL ?? null,
    controlToken: process.env.GITSPACE_CONTROL_TOKEN ?? null,
    runningMachineSha: machineReleaseSha,
    omp,
    generation: process.env.GITSPACE_GENERATION_HASH ?? null,
    onError: (error) => console.error('[gitspace-deploy]', error),
  });
  const rpc = createGitSpaceRpcHandler({
    database,
    handlers,
    artifacts,
    sessions,
    machineId,
    spaces,
    terminals,
    serviceManager,
    secrets: authority,
    mcp,
    browserRelay,
    crons: authority,
    skills: authority,
    inspector: authority,
    projectEvents: authority,
    projects: projectLifecycle,
    machines: () => authority.listMachineDefinitions(),
    spacePlacements: async () => {
      const definitions = await authority.listSpaceDefinitions();
      const directory = await Promise.all(definitions.map(async (definition) => {
        const state = await authority.getSpace(definition.projectId, definition.spaceId);
        return state ? {
          spaceId: definition.spaceId,
          projectId: definition.projectId,
          kind: definition.kind,
          holderId: state.machineId ?? 'unassigned',
          state: state.state,
        } : null;
      }));
      return directory.filter((space) => space !== null);
    },
    canonicalSessions: (projectId) => authority.listCanonicalSessions(projectId),
    checkpointTranscript: (projectId, spaceId) => closedSpaceTranscripts.read(projectId, spaceId),
    updateMachine: async (targetMachineId, notes) => {
      const current = (await authority.listMachineDefinitions()).find((machine) => machine.id === targetMachineId);
      if (!current) throw new Error(`Machine ${targetMachineId} does not exist`);
      return authority.putMachineDefinition({ ...current, notes });
    },
    createSandbox: () => authority.createSandboxMachine(),
    controlMachine: (action, targetMachineId) => action === 'sleep' ? authority.sleepMachine(targetMachineId) : authority.resumeMachine(targetMachineId),
    destroyMachine: (targetMachineId) => authority.destroyMachine(targetMachineId),
    settings,
    providers,
    devices,
    gitIdentity,
    deployment: {
      status: () => authority.deploymentStatus(),
      launch: (input) => launcher.launch(input),
      launchProgress: () => launcher.status(),
      revert: async () => {
        const status = await authority.revertRelease();
        void releases.nudge();
        return status;
      },
      get thisMachine() { const status = omp.status(); return { sha: machineReleaseSha, ompSha: status.sha, ompDraining: status.draining, generation: process.env.GITSPACE_GENERATION_HASH ?? null }; },
    },
    onInternalError: ({ incidentId, phase, cause, procedurePath }) => {
      console.error('[gitspace-rpc]', { incidentId, phase, procedurePath, cause });
    },
    watchMachines: (listener) => authority.subscribeMachines(listener),
  });
  let preparingReplacement = false;
  let activeRpcRequests = 0;
  let cronDrainActive = false;
  let replacementControl: Promise<unknown> = Promise.resolve();
  const prepareReplacement = async () => {
    preparingReplacement = true;
    releases.stop();
    while (activeRpcRequests > 0 || cronDrainActive) await Bun.sleep(25);
    const held = [];
    for (const project of database.listProjects()) {
      for (const space of database.listSpaces(project.id)) {
        const cloud = await authority.getSpace(project.id, space.id);
        if (cloud?.machineId !== machineId) {
          if (space.holderId === machineId && space.placementState !== 'closed') throw new Error(`Space ${space.id} local ownership is not current in the cloud`);
          continue;
        }
        if (cloud.state !== 'open' || space.holderId !== machineId || space.placementState !== 'open'
          || space.generation !== cloud.generation || !existsSync(join(space.rootPath, '.git'))) {
          throw new Error(`Space ${space.id} has uncheckpointed or stale local state; provider replacement is unsafe. Restore the intact machine or explicitly reset legacy rehearsal data.`);
        }
        held.push(space);
      }
    }
    for (const space of held) {
      const opened = await sessions.openSpace(space.id);
      if (opened.status === 'error') throw opened.error;
      await sessions.quiesceSpace(space.id, true);
      await terminals.stopOwned(space.id);
    }
    await serviceManager.dispose();
    for (const space of held) await spaces.release(space, space.generation);
    await canonicalSessionWriter.flush();
    await projectEventWriter.flush();
    const checkpoints = [];
    for (const project of database.listProjects()) {
      for (const space of database.listSpaces(project.id)) {
        const cloud = await authority.getSpace(project.id, space.id);
        if (cloud?.machineId === machineId) throw new Error(`Space ${space.id} was not released`);
        if (cloud?.resumeMachineId !== machineId) continue;
        if (cloud.state !== 'closed' || !cloud.manifestKey || !cloud.manifestHash) throw new Error(`Space ${space.id} has no complete replacement checkpoint`);
        checkpoints.push({ spaceId: space.id, generation: cloud.generation, checkpointRevision: cloud.checkpointRevision });
      }
    }
    return { prepared: true, machineId, spaces: checkpoints };
  };
  const cancelReplacement = async () => {
    if (!preparingReplacement) return { prepared: false, machineId };
    for (const project of database.listProjects()) {
      for (const space of database.listSpaces(project.id)) {
        const cloud = await authority.getSpace(project.id, space.id);
        if (cloud?.state === 'closed' && cloud.resumeMachineId === machineId) await spaces.open(space.id, cloud.generation, { resumeOnMachineRestart: true });
        else if (cloud?.state === 'open' && cloud.machineId === machineId && cloud.generation === space.generation) sessions.resumeSpace(space.id);
      }
    }
    await serviceManager.rehydrate();
    await releases.start();
    preparingReplacement = false;
    return { prepared: false, machineId };
  };
  const rpcHandler = createSignedRpcHandler({
    handler: rpc.handler,
    lookupDevice: (deviceId) => devices.lookup(deviceId),
    procedureKind: rpc.procedureKind,
    workspaceProject: (workspaceId) => database.getSpace(workspaceId)?.projectId ?? null,
  });
  // A bare stop releases held spaces (files kept, reclaimed on the next start);
  // a replacement successor retires this generation first so possession carries over untouched.
  let stopMode: 'release' | 'replace' = 'release';
  const http = startGitSpaceRpcHttpServer({
    handler: async (request) => {
      if (preparingReplacement) return Response.json({ error: 'Machine is checkpointed for provider replacement' }, { status: 503 });
      activeRpcRequests += 1;
      try { return await rpcHandler(request); }
      finally { activeRpcRequests -= 1; }
    },
    hostname: process.env.GITSPACE_RPC_HOST ?? '127.0.0.1',
    releaseStatus: () => { const status = omp.status(); return { machineRelease: machineReleaseSha, ompRelease: status.sha, ompDraining: status.draining }; },
    port: Number(process.env.GITSPACE_RPC_PORT ?? 0),
    additionalFetch: async (request) => {
      const service = preparingReplacement ? null : await serviceManager.proxy(request);
      if (service) return service;
      const url = new URL(request.url);
      if (!url.pathname.startsWith('/__control/') || request.method !== 'POST') return null;
      const token = process.env.GITSPACE_CONTROL_TOKEN;
      if (!token || request.headers.get('authorization') !== `Bearer ${token}`) {
        return Response.json({ error: 'unauthorized' }, { status: 401 });
      }
      if (url.pathname === '/__control/prepare-replacement' || url.pathname === '/__control/cancel-replacement') {
        const operation = replacementControl.then(async () => url.pathname === '/__control/prepare-replacement' ? prepareReplacement() : cancelReplacement());
        replacementControl = operation.catch(() => undefined);
        try { return Response.json(await operation); }
        catch (error) { return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 409 }); }
      }
      if (preparingReplacement) return Response.json({ error: 'Provider replacement preparation is active' }, { status: 409 });
      if (url.pathname === '/__control/omp-activate') {
        const input = ompGenerationSelectionSchema.safeParse(await request.json());
        if (!input.success) return Response.json({ error: input.error.message }, { status: 400 });
        try { return Response.json(await omp.activate(input.data)); }
        catch (error) { return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 409 }); }
      }
      if (url.pathname === '/__control/retire') {
        stopMode = 'replace';
        return Response.json({ stopMode });
      }
      if (url.pathname !== '/__control/code-version') return null;
      const input = await request.json() as { hash?: unknown };
      const hash = typeof input.hash === 'string' ? input.hash : 'unknown';
      if (!bootstrapProjectId) return Response.json({ offset: null });
      const event = await authority.appendProjectEvent({
        projectId: bootstrapProjectId,
        scope: 'code',
        entity: 'frontend-generation',
        entityId: hash,
        revision: Date.now(),
        operation: 'code-version',
        payload: { hash, replacing: false },
      });
      return Response.json({ offset: event.offset });
    },
  });

  const cronAdapter = {
    // Only runs whose target is open here are claimed; the rest wait for their holder.
    claimNext: ({ projectId }: { projectId: string; claimedBy: string }) => authority.claimNextProjectCron(
      projectId,
      database.listSpaces(projectId).filter((space) => space.holderId === machineId && space.placementState !== 'closed').map((space) => space.id),
    ),
    resolveCanonicalAgent: async (target: { scope: 'project'; projectId: string } | { scope: 'workspace'; projectId: string; spaceId: string }) => {
      const space = target.scope === 'project'
        ? database.getBaseSpace(target.projectId)
        : database.getSpace(target.spaceId);
      if (!space || space.projectId !== target.projectId || (target.scope === 'workspace' && space.kind !== 'worktree')) {
        return { status: 'blocked' as const, message: 'The stable cron target no longer exists in this project' };
      }
      if (space.placementState === 'closed' || space.holderId !== machineId || space.generation < 1) {
        return { status: 'blocked' as const, message: 'The stable cron target is not open on this machine' };
      }
      const opened = await sessions.openSpace(space.id);
      if (opened.status === 'error') {
        return { status: 'blocked' as const, message: `The canonical agent could not be opened: ${opened.error.message}` };
      }
      return { status: 'ready' as const, agent: opened.value, spaceId: space.id, generation: space.generation };
    },
    promptCanonicalAgent: async (input: {
      agent: NonNullable<ReturnType<typeof sessions.get>>;
      spaceId: string;
      generation: number;
      runId: string;
      prompt: string;
      readScopes: readonly string[];
      writeScopes: readonly string[];
    }) => {
      const current = database.getSpace(input.spaceId);
      if (!current || current.generation !== input.generation || current.holderId !== machineId || current.placementState === 'closed') {
        return { status: 'blocked' as const, message: 'The cron target moved before its canonical agent could be prompted' };
      }
      if (input.agent.spaceId !== input.spaceId) {
        return { status: 'failed' as const, message: 'Canonical session identity does not match the resolved cron target' };
      }
      const prompted = await sessions.prompt(input.agent.id, input.prompt, { streamingBehavior: 'followUp' });
      if (prompted.status === 'error') return { status: 'failed' as const, message: prompted.error.message };
      return prompted.value
        ? { status: 'accepted' as const, message: `Queued unattended run ${input.runId} with ${input.readScopes.length} read and ${input.writeScopes.length} write scopes` }
        : { status: 'blocked' as const, message: 'The canonical agent could not accept the unattended prompt' };
    },
    completeRun: (input: {
      projectId: string;
      runId: string;
      claimToken: string;
      state: 'succeeded' | 'blocked' | 'failed';
      message: string | null;
      resolvedSpaceId: string | null;
      resolvedGeneration: number | null;
    }) => authority.completeProjectCronRun(input),
  };
  const drainProjectCrons = async (): Promise<void> => {
    if (cronDrainActive || preparingReplacement) return;
    cronDrainActive = true;
    try {
      for (const project of database.listProjects()) {
        await authority.processDueProjectCrons(project.id);
        while (!preparingReplacement && await runNextProjectCron(project.id, machineId, cronAdapter)) {
          // Drain the durable authority queue serially so canonical sessions are never prompted concurrently.
        }
      }
    } finally {
      cronDrainActive = false;
    }
  };
  const cronDrainTimer = setInterval(() => {
    void drainProjectCrons().catch((error: unknown) => console.error('[gitspace-crons]', error));
  }, 5_000);

  const existingMachine = (await authority.listMachineDefinitions()).find((machine) => machine.id === machineId);
  await authority.putMachineDefinition({
    id: machineId,
    label: process.env.GITSPACE_MACHINE_LABEL ?? machineId,
    state: 'online',
    rpcEndpoint: process.env.GITSPACE_PUBLIC_RPC_URL ?? `${http.url}/rpc`,
    kind: existingMachine?.kind ?? 'physical',
    provider: existingMachine?.provider ?? 'physical',
    notes: existingMachine?.notes ?? '',
    desiredState: existingMachine?.desiredState ?? 'online',
    lifecycleRevision: existingMachine?.lifecycleRevision ?? 0,
    operationId: existingMachine?.operationId ?? null,
    error: existingMachine?.error ?? null,
  });
  void drainProjectCrons().catch((error: unknown) => console.error('[gitspace-crons]', error));
  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    preparingReplacement = true;
    clearInterval(cronDrainTimer);
    if (bootstrapProjectId) {
      await authority.appendProjectEvent({
        projectId: bootstrapProjectId,
        scope: 'code',
        entity: 'machine-generation',
        entityId: process.env.GITSPACE_GENERATION_HASH ?? 'unknown',
        revision: Date.now(),
        operation: 'code-version',
        payload: { replacing: true },
      });
      await Bun.sleep(150);
    }
    devices.stop();
    releases.stop();
    await serviceManager.dispose();
    await projectEventWriter.flush();
    const stopLog = (line: string): void => {
      console.log(line);
      try { appendFileSync(join(environmentRoot, 'stop.log'), `${new Date().toISOString()} ${line}\n`); } catch { /* diagnostics only */ }
    };
    stopLog(`[gitspace-stop] mode=${stopMode}`);
    if (stopMode === 'release') {
      // Durable preparation is the supported disk-replacement boundary. Bare shutdown also
      // checkpoints dormant/absent agents, but cannot acknowledge success to an external killer.
      for (const project of database.listProjects()) {
        for (const space of database.listSpaces(project.id)) {
          if (space.holderId !== machineId || space.placementState !== 'open') continue;
          const startedAt = Date.now();
          try {
            const opened = await sessions.openSpace(space.id);
            if (opened.status === 'error') throw opened.error;
            await sessions.quiesceSpace(space.id);
            await terminals.stopOwned(space.id);
            await spaces.release(space, space.generation);
            stopLog(`[gitspace-release] ${space.id} released in ${Date.now() - startedAt}ms`);
          } catch (error) {
            stopLog(`[gitspace-release] ${space.id} failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
          }
        }
      }
    }
    await sessions.stopForRestart();
    await omp.dispose();
    await settings.stop();
    await walgit.dispose();
    await http.stop();
    await canonicalSessionWriter.flush();
    database.close();
  };
  // OMP's postmortem module installs its own SIGINT/SIGTERM handlers at import
  // time and hard-exits after a 10s cleanup deadline, which would race the
  // release checkpoints. The daemon owns its lifetime: drop those listeners,
  // run our stop, then let OMP's registered cleanups run before exiting.
  process.removeAllListeners('SIGINT');
  process.removeAllListeners('SIGTERM');
  const shutdown = (): void => {
    void stop()
      .catch((error) => {
        try { appendFileSync(join(environmentRoot, 'stop.log'), `${new Date().toISOString()} [gitspace-stop] failed ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`); } catch { /* diagnostics only */ }
      })
      .then(() => postmortem.cleanup())
      .finally(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  console.log(`GitSpace RPC ready at ${http.url}/rpc generation=${process.env.GITSPACE_GENERATION_HASH ?? 'unknown'} machine=${machineReleaseSha ?? 'local'} omp=${omp.status().sha ?? 'local'}`);
  await releases.start();
  return { environmentRoot, database, artifacts, sessions, settings, handlers, http, stop };
}

if (import.meta.main) await startMachineRuntime();
