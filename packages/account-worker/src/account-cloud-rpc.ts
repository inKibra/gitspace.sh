import { isAccountCloudRpcPath, isTerminalRpcPath, rpcCallTarget, spaceCloudRpcSpaceId, isSpaceCloudRpcPath } from '@gitspace/protocol/account-rpc';
import { consumeDurableStream } from './durable-stream.js';
import { activeAccount } from './account-access.js';
import { AgentIncidentChangeSchema } from '@gitspace/protocol-agent';
import type { LifecycleState } from '@gitspace/protocol-environment';
import type { CloudImageState } from '@gitspace/protocol/cloud-image';
import { MachineDiscardRequired } from '@gitspace/protocol/machine-discard';
import {
  credentialProtocolBase64, deviceCanAdminister, requiredCapability, requiresImageSelectionControl, RPC_DEVICE_HEADER, verifyDeviceGrantRecord,
  parseRuntimeSettings, runtimeSettingsView, type RuntimeConfigDocument,
  type DeviceCapability, type GitSpaceRpcContext, type CloudProjectSummary,
} from '@gitspace/protocol';
import {
  gitspaceContract, getUserSettingsContract, updateUserSettingsContract, reserveUserHandleContract,
  getGitIdentityContract, getRuntimeSettingsContract, setRuntimeSettingContract, settingsEventsContract, listMachinesContract,
  machineLifecycleEventsContract, createSandboxMachineContract, updateMachineNotesContract,
  sleepMachineContract, resumeMachineContract, destroyMachineContract,
  listCloudImagesContract, cloudImageEventsContract, getCloudImageDefaultContract, setCloudImageDefaultContract,
  setCloudImageContract, retryCloudImageContract, cancelCloudImageContract, recoverCloudImageContract,
  listProjectsContract, listDevicesContract, revokeDeviceContract,
  getComposioSetupContract, putComposioSetupContract, deleteComposioSetupContract,
  ensureGitSpaceProjectContract, placementsContract, locateSessionContract, type SpacePlacementView,
  projectEventsContract, projectDirectoryEventsContract, environmentEventsContract, spaceEventsContract, recordIncidentContract,
} from '@gitspace/protocol/rpc-contract';
import { inferenceListContract, inferenceCreateContract, inferenceUpdateContract, inferenceDeleteContract, inferenceAssignContract, inferenceEventsContract } from '@gitspace/protocol/rpc-contract';
import type { InferenceState } from '@gitspace/protocol/inference';
import { parse } from 'devalue';
import { contractDigest, err, ok } from 'result-rpc';
import { createFetchHandler, serverRpc } from 'result-rpc/server';
import { z } from 'zod';
import { ComposioPluginGateway } from './composio-plugins.js';
import type { FleetCatalogDO, FleetMachineDefinition } from './fleet-catalog.js';
import { controlFleetMachine, provisionManagedSandbox, reconcileFleetMachines, type CredentialVaultDO } from './application.js';
import type { ProjectAuthorityDO, UserProjectIndexDO } from './project-authority.js';
import type { UserSettingsDO, SettingsSnapshot } from './user-settings.js';
import type { SpaceAuthorityDO } from './space-authority.js';
import type { SpaceAuthorityRecord } from '@gitspace/protocol-workspace';
import { inspectorCloudProcedures } from './account-inspector-rpc.js';
import { ensureAccountGitSpaceProject } from './gitspace-project.js';
import { environmentCloudProcedures } from './account-environment-rpc.js';
import { configurationCloudProcedures } from './account-configuration-rpc.js';
import { runtimeCloudProcedures } from './account-runtime-rpc.js';
import { providerCloudProcedures } from './account-provider-rpc.js';

const MAX_REQUEST_BYTES = 512 * 1024;
const MAX_BATCH_ITEMS = 32;
const CONTRACT_VERSION = contractDigest(gitspaceContract);
const itemSchema = z.object({ path: z.string().min(1), input: z.unknown() });
const envelopeSchema = z.union([
  itemSchema.extend({ v: z.literal(1) }).transform((item) => [item]),
  z.object({ v: z.literal(1), batch: z.array(itemSchema.extend({ id: z.string() })).min(1).max(MAX_BATCH_ITEMS) }).transform((envelope) => envelope.batch),
]);
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

function transportError(status: number, code: string, text: string): Response {
  return Response.json({ error: { code, message: text } }, { status, headers: { 'cache-control': 'private, no-store' } });
}

async function readBody(request: Pick<Request, 'body'>): Promise<Uint8Array | null> {
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_REQUEST_BYTES) return null;
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  if (chunks.length === 1) return chunks[0]!;
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return body;
}

/** The canonical workspace of a session, from whichever account project owns it. */
async function sessionSpaceId(env: Env, userId: string, sessionId: string): Promise<string | null> {
  const projects = await env.USER_PROJECTS.getByName(userId).list();
  const sessions = await Promise.all(projects.map((project) => env.PROJECT_AUTHORITY.getByName(`${userId}:${project.id}`).getCanonicalSession(sessionId)));
  return sessions.find((session) => session !== null)?.workspaceId ?? null;
}

/** Machines currently holding the spaces and sessions a batch names. A target
 * without a live holder can run on any machine, so it never selects one. */
async function liveHolders(env: Env, userId: string, items: readonly { path: string; input: unknown }[]): Promise<FleetMachineDefinition[]> {
  const spaceIds = new Set<string>();
  const sessionIds = new Set<string>();
  for (const item of items) {
    const target = rpcCallTarget(item.path, item.input);
    if (target?.kind === 'space') spaceIds.add(target.spaceId);
    else if (target?.kind === 'session') sessionIds.add(target.sessionId);
  }
  for (const spaceId of await Promise.all([...sessionIds].map((sessionId) => sessionSpaceId(env, userId, sessionId)))) {
    if (spaceId) spaceIds.add(spaceId);
  }
  const placements = await Promise.all([...spaceIds].map((spaceId) => env.SPACE_AUTHORITY.getByName(`${userId}:${spaceId}`).get()));
  const machineIds = new Set(placements.flatMap((placement) => placement?.state === 'open' && placement.machineId ? [placement.machineId] : []));
  if (machineIds.size === 0) return [];
  const catalog = env.FLEET_CATALOG.getByName(userId);
  const machines = await Promise.all([...machineIds].map((machineId) => catalog.getMachine(machineId)));
  return machines.flatMap((machine) => machine?.state === 'online' && machine.desiredState === 'online' && machine.rpcEndpoint ? [machine] : []);
}

function accountRouter(env: Env, userId: string, deviceId: string, origin: string) {
  const server = serverRpc.context<GitSpaceRpcContext>();
  const vault = (env.CREDENTIALS as DurableObjectNamespace<CredentialVaultDO>).getByName(userId);
  const settings = (env.USER_SETTINGS as DurableObjectNamespace<UserSettingsDO>).getByName(userId);
  const catalog = (env.FLEET_CATALOG as DurableObjectNamespace<FleetCatalogDO>).getByName(userId);
  const deviceRecords = async () => {
    const [root, records] = await Promise.all([vault.rootPublicKey(), vault.listDeviceGrants()]);
    if (!root) throw new Error('Account credential authority is not configured');
    const byId = Object.fromEntries(records.map((record) => [record.binding.deviceId, record]));
    const rootKey = credentialProtocolBase64.decode(root);
    const now = Date.now();
    return records.map((record) => ({ record, verified: verifyDeviceGrantRecord(record, rootKey, now, (id) => byId[id] ?? null) }));
  };
  const requireAdministration = async (capability: 'account.admin' | 'lifecycle.control' = 'account.admin') => {
    const device = await vault.currentDeviceGrant(deviceId);
    if (!deviceCanAdminister(device, capability)) throw new Error(`Account scope, rpc.write and ${capability} authorization are required`);
    return device!;
  };
  // Every delivery consumes the same bounded tenant authority as request admission.
  const requireSubscription = async () => {
    const account = await activeAccount(env, userId);
    if (account.status === 'error') throw new Error(account.error.message);
    const devices = await deviceRecords();
    const device = devices.find(({ record }) => record.binding.deviceId === deviceId)?.verified;
    if (!device || device.scope.kind !== 'user' || !device.capabilities.includes('rpc.read')) {
      throw new Error('Device subscription authorization ended');
    }
  };
  const fleet = async () => reconcileFleetMachines(env, userId, catalog);
  const readDirectory = async () => {
    const [projects, machines] = await Promise.all([
      (env.USER_PROJECTS as DurableObjectNamespace<UserProjectIndexDO>).getByName(userId).list(),
      catalog.listMachines(),
    ]);
    const definitions = (await Promise.all(projects.map((project) =>
      (env.PROJECT_AUTHORITY as DurableObjectNamespace<ProjectAuthorityDO>).getByName(`${userId}:${project.id}`).listWorkspaces(),
    ))).flat();
    const byMachine = new Map(machines.map((machine) => [machine.id, machine]));
    const spaces = await Promise.all(definitions.map(async (definition): Promise<SpacePlacementView | null> => {
      const state = await (env.SPACE_AUTHORITY as DurableObjectNamespace<SpaceAuthorityDO>).getByName(`${userId}:${definition.id}`).get();
      if (!state) return null;
      const machine = state.machineId ? byMachine.get(state.machineId) : undefined;
      return {
        spaceId: definition.id, projectId: definition.projectId, kind: definition.kind,
        holderId: state.machineId ?? 'unassigned', state: state.state,
        generation: state.generation,
        endpoint: machine?.state === 'online' && machine.desiredState === 'online' ? machine.rpcEndpoint : null,
      };
    }));
    return { projects, spaces: spaces.filter((space): space is SpacePlacementView => space !== null) };
  };
  const placements = server.implement(placementsContract).handler(async ({ errors }) => {
    try { return ok({ machineId: '', spaces: (await readDirectory()).spaces }); }
    catch (error) { return err(errors.OperationFailed({ operation: 'list placements', message: message(error) })); }
  });
  const locateSession = server.implement(locateSessionContract).handler(async ({ input, errors }) => {
    try {
      const spaceId = await sessionSpaceId(env, userId, input.sessionId);
      return ok(spaceId ? (await readDirectory()).spaces.find((space) => space.spaceId === spaceId) ?? null : null);
    } catch (error) { return err(errors.OperationFailed({ operation: 'locate session', message: message(error) })); }
  });
  const composioSetup = async () => {
    const metadata = await vault.providerSecretMetadata('composio');
    const platform = Boolean(env.COMPOSIO_API_KEY?.trim());
    return { configured: metadata.configured || platform, source: metadata.configured ? 'account' as const : platform ? 'platform' as const : null, updatedAt: metadata.updatedAt ? new Date(metadata.updatedAt) : null };
  };

  const getSettings = server.implement(getUserSettingsContract).handler(async ({ errors }) => {
    try { return ok(await settings.get(deviceId)); }
    catch (error) { return err(errors.OperationFailed({ operation: 'get user settings', message: message(error) })); }
  });
  const updateSettings = server.implement(updateUserSettingsContract).handler(async ({ input, errors }) => {
    try {
      const current = await settings.get(deviceId);
      if (input.profile.handle !== current.profile.handle) throw new Error('Handle changes require settings.reserveHandle');
      const result = await settings.update(deviceId, input);
      return result.status === 'conflict' ? err(errors.SettingsConflict(result)) : ok(result.value);
    } catch (error) { return err(errors.OperationFailed({ operation: 'update user settings', message: message(error) })); }
  });
  const reserveHandle = server.implement(reserveUserHandleContract).handler(async ({ input, errors }) => {
    try {
      const handle = input.handle.trim().toLowerCase();
      if (!/^[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?$/u.test(handle)) throw new Error('Handle must be 1 to 30 lowercase letters, numbers, or hyphens');
      const current = await settings.get(deviceId);
      if (current.profile.handle && current.profile.handle !== handle) throw new Error('GitSpace handles are permanent');
      if (handle !== env.TENANT_ID) throw new Error('Account handles are assigned by the platform and cannot be changed here');
      const result = await settings.setHandle(deviceId, input.expectedRevision, handle);
      if (result.status === 'conflict') {
        return err(errors.SettingsConflict(result));
      }
      return ok(result.value);
    } catch (error) { return err(errors.OperationFailed({ operation: 'reserve user handle', message: message(error) })); }
  });
  const getGit = server.implement(getGitIdentityContract).handler(async ({ errors }) => {
    try {
      const identity = await settings.getGitIdentity();
      if (!identity) return ok(null);
      const { privateKey: _privateKey, ...view } = identity;
      return ok(view);
    } catch (error) { return err(errors.OperationFailed({ operation: 'get Git identity', message: message(error) })); }
  });
  const runtimeView = (document: RuntimeConfigDocument) => ({
    document,
    schema: runtimeSettingsView(parseRuntimeSettings(JSON.parse(document.content || '{}'))).map(({ value, description, options, defaultJson, ...item }) => ({
      ...item, valueJson: JSON.stringify(value), description: description ?? null, options: options ?? [], ...(defaultJson === undefined ? {} : { defaultJson }),
    })),
    sync: { status: 'synced' as const, message: null },
  });
  const getRuntime = server.implement(getRuntimeSettingsContract).handler(async ({ errors }) => {
    try {
      return ok(runtimeView(await settings.getRuntime()));
    } catch (error) { return err(errors.OperationFailed({ operation: 'get runtime settings', message: message(error) })); }
  });
  const setRuntime = server.implement(setRuntimeSettingContract).handler(async ({ input, errors }) => {
    try {
      const result = await settings.setRuntime(deviceId, input);
      return result.status === 'conflict' ? err(errors.SettingsConflict(result)) : ok(runtimeView(result.value));
    } catch (error) { return err(errors.OperationFailed({ operation: 'set runtime setting', message: message(error) })); }
  });
  const settingsEvents = server.implement(settingsEventsContract).stream(async function* ({ input, signal, errors }) {
    try {
      await requireSubscription();
      for await (const event of consumeDurableStream<SettingsSnapshot>(await settings.watch(input.after), signal)) {
        await requireSubscription();
        yield ok(event);
      }
    } catch (error) { if (!signal.aborted) yield err(errors.OperationFailed({ operation: 'subscribe to settings', message: message(error) })); }
  });
  const machines = server.implement(listMachinesContract).handler(async ({ errors }) => {
    try { return ok(await fleet()); }
    catch (error) { return err(errors.OperationFailed({ operation: 'list machines', message: message(error) })); }
  });
  const machineEvents = server.implement(machineLifecycleEventsContract).stream(async function* ({ input, signal, errors }) {
    try {
      await requireSubscription();
      for await (const event of consumeDurableStream<FleetMachineDefinition[]>(await catalog.watch(input.after), signal)) {
        await requireSubscription();
        yield ok(event);
      }
    } catch (error) { if (!signal.aborted) yield err(errors.OperationFailed({ operation: 'subscribe to machines', message: message(error) })); }
  });
  const createSandbox = server.implement(createSandboxMachineContract).handler(async ({ input, errors }) => {
    try {
      return ok(await provisionManagedSandbox(env, userId, env.ACCOUNT_URL, input.image));
    } catch (error) { return err(errors.OperationFailed({ operation: 'create sandbox', message: message(error) })); }
  });
  const images = server.implement(listCloudImagesContract).handler(async ({ errors }) => {
    try { return ok(await catalog.listCloudImages()); }
    catch (error) { return err(errors.OperationFailed({ operation: 'list cloud images', message: message(error) })); }
  });
  const imageEvents = server.implement(cloudImageEventsContract).stream(async function* ({ input, signal, errors }) {
    try {
      await requireSubscription();
      for await (const event of consumeDurableStream<CloudImageState[]>(await catalog.watchCloudImages(input.after), signal)) {
        await requireSubscription();
        yield ok(event);
      }
    } catch (error) { if (!signal.aborted) yield err(errors.OperationFailed({ operation: 'subscribe to cloud images', message: message(error) })); }
  });
  const imageDefault = server.implement(getCloudImageDefaultContract).handler(async ({ errors }) => {
    try { return ok(await catalog.cloudImageDefault()); }
    catch (error) { return err(errors.OperationFailed({ operation: 'get cloud image default', message: message(error) })); }
  });
  const setImageDefault = server.implement(setCloudImageDefaultContract).handler(async ({ input, errors }) => {
    try { return ok(await catalog.setCloudImageDefault(input.selection)); }
    catch (error) { return err(errors.OperationFailed({ operation: 'set cloud image default', message: message(error) })); }
  });
  const setImage = server.implement(setCloudImageContract).handler(async ({ input, errors }) => {
    try { return ok(await catalog.startCloudImage({ ...input, userId })); }
    catch (error) { return err(errors.OperationFailed({ operation: 'change cloud image', message: message(error) })); }
  });
  const retryImage = server.implement(retryCloudImageContract).handler(async ({ input, errors }) => {
    try { return ok(await catalog.retryCloudImage({ ...input, userId })); }
    catch (error) { return err(errors.OperationFailed({ operation: 'retry cloud image', message: message(error) })); }
  });
  const cancelImage = server.implement(cancelCloudImageContract).handler(async ({ input, errors }) => {
    try { return ok(await catalog.retryCloudImage({ ...input, userId, cancel: true })); }
    catch (error) { return err(errors.OperationFailed({ operation: 'cancel cloud image', message: message(error) })); }
  });
  const recoverImage = server.implement(recoverCloudImageContract).handler(async ({ input, errors }) => {
    try { return ok(await catalog.recoverCloudImage({ ...input, userId, approvedBy: deviceId })); }
    catch (error) { return err(errors.OperationFailed({ operation: 'recover with another cloud image', message: message(error) })); }
  });
  const sleep = server.implement(sleepMachineContract).handler(async ({ input, errors }) => {
    try { return ok(await controlFleetMachine(env, userId, input.machineId, 'sleep', input.discardConfirmation)); }
    catch (error) {
      if (error instanceof MachineDiscardRequired) return err(errors.MachineDiscardRequired({ message: error.message, confirmation: error.confirmation, workspaces: error.workspaces }));
      return err(errors.OperationFailed({ operation: 'sleep machine', message: message(error) }));
    }
  });
  const resume = server.implement(resumeMachineContract).handler(async ({ input, errors }) => {
    try { return ok(await controlFleetMachine(env, userId, input.machineId, 'resume')); }
    catch (error) { return err(errors.OperationFailed({ operation: 'resume machine', message: message(error) })); }
  });
  const destroy = server.implement(destroyMachineContract).handler(async ({ input, errors }) => {
    try { return ok(await controlFleetMachine(env, userId, input.machineId, 'destroy', input.discardConfirmation)); }
    catch (error) {
      if (error instanceof MachineDiscardRequired) return err(errors.MachineDiscardRequired({ message: error.message, confirmation: error.confirmation, workspaces: error.workspaces }));
      return err(errors.OperationFailed({ operation: 'destroy machine', message: message(error) }));
    }
  });
  const updateNotes = server.implement(updateMachineNotesContract).handler(async ({ input, errors }) => {
    try {
      const machine = await catalog.getMachine(input.machineId);
      if (!machine) throw new Error('Machine does not exist');
      return ok(await catalog.putMachine({ ...machine, notes: input.notes }));
    } catch (error) { return err(errors.OperationFailed({ operation: 'update machine notes', message: message(error) })); }
  });
  const projects = server.implement(listProjectsContract).handler(async ({ input, errors }) => {
    try {
      await ensureAccountGitSpaceProject(env, userId);
      const index = (env.USER_PROJECTS as DurableObjectNamespace<UserProjectIndexDO>).getByName(userId);
      return ok((await index.list(input.lifecycle === 'all' ? undefined : input.lifecycle)).map((project) => ({ ...project, updatedAt: new Date(project.updatedAt), archivedAt: project.archivedAt ? new Date(project.archivedAt) : null })));
    } catch (error) { return err(errors.OperationFailed({ operation: 'list projects', message: message(error) })); }
  });
  const projectIndex = (env.USER_PROJECTS as DurableObjectNamespace<UserProjectIndexDO>).getByName(userId);
  const authorityFor = async (projectId: string) => {
    if (!(await projectIndex.list()).some((project) => project.id === projectId)) throw new Error('Project does not belong to this account');
    return (env.PROJECT_AUTHORITY as DurableObjectNamespace<ProjectAuthorityDO>).getByName(`${userId}:${projectId}`);
  };
  const directoryEvents = server.implement(projectDirectoryEventsContract).stream(async function* ({ input, signal, errors }) {
    try {
      await requireSubscription();
      for await (const event of consumeDurableStream<CloudProjectSummary[]>(await projectIndex.watch(input.after), signal)) {
        await requireSubscription();
        yield ok(event.type === 'resync' ? event : { ...event, value: event.value.map((project) => ({ ...project, updatedAt: new Date(project.updatedAt), archivedAt: project.archivedAt ? new Date(project.archivedAt) : null })) });
      }
    } catch (error) { if (!signal.aborted) yield err(errors.OperationFailed({ operation: 'subscribe to projects', message: message(error) })); }
  });
  const projectEvents = server.implement(projectEventsContract).stream(async function* ({ input, signal, errors }) {
    try {
      await requireSubscription();
      const authority = await authorityFor(input.projectId);
      for await (const event of consumeDurableStream<{ entity: string; entityId: string | null; eventOffset: number }>(await authority.watch(input.after), signal)) {
        await requireSubscription();
        yield ok(event);
      }
    } catch (error) { if (!signal.aborted) yield err(errors.OperationFailed({ operation: 'subscribe to project', message: message(error) })); }
  });
  const environmentEvents = server.implement(environmentEventsContract).stream(async function* ({ input, signal, errors }) {
    try {
      await requireSubscription();
      const projectId = await projectIndex.locateWorkspace(input.spaceId);
      if (!projectId) throw new Error('Workspace does not belong to this account');
      const authority = await authorityFor(projectId);
      for await (const event of consumeDurableStream<LifecycleState>(await authority.watchEnvironment(input.spaceId, input.after), signal)) {
        await requireSubscription();
        yield ok(event);
      }
    } catch (error) { if (!signal.aborted) yield err(errors.OperationFailed({ operation: 'subscribe to environment', message: message(error) })); }
  });
  const spaceEvents = server.implement(spaceEventsContract).stream(async function* ({ input, signal, errors }) {
    try {
      await requireSubscription();
      const projectId = await projectIndex.locateWorkspace(input.spaceId);
      if (!projectId) throw new Error('Workspace does not belong to this account');
      await authorityFor(projectId);
      const authority = (env.SPACE_AUTHORITY as DurableObjectNamespace<SpaceAuthorityDO>).getByName(`${userId}:${input.spaceId}`);
      for await (const event of consumeDurableStream<SpaceAuthorityRecord | null>(await authority.watch(input.spaceId, input.after), signal)) {
        await requireSubscription();
        yield ok(event);
      }
    } catch (error) { if (!signal.aborted) yield err(errors.OperationFailed({ operation: 'subscribe to workspace placement', message: message(error) })); }
  });
  const recordIncident = server.implement(recordIncidentContract).handler(async ({ input, errors }) => {
    try {
      const change = AgentIncidentChangeSchema.parse(input.change);
      const authority = await authorityFor(input.projectId);
      const spaceId = change.type === 'occurred' ? change.incident.spaceId : change.spaceId;
      if (!(await authority.listWorkspaces()).some((space) => space.id === spaceId)) throw new Error('Incident workspace does not belong to this project');
      const sessionId = change.type === 'occurred' ? change.incident.sessionId : change.sessionId;
      if (sessionId !== null) {
        const session = await authority.getCanonicalSession(sessionId);
        if (!session || session.workspaceId !== spaceId) throw new Error('Incident session does not belong to this workspace');
      }
      const incidentId = change.type === 'occurred' ? change.incident.id : change.incidentId;
      await authority.appendEvent({ eventId: input.eventId, scope: 'session', entity: 'agent-incident', entityId: incidentId, revision: change.type === 'occurred' ? change.incident.revision : change.revision, operation: 'append', payload: { change } });
      return ok({ eventId: input.eventId });
    } catch (error) { return err(errors.OperationFailed({ operation: 'save incident', message: message(error) })); }
  });
  const ensureGitSpace = server.implement(ensureGitSpaceProjectContract).handler(async ({ input, errors }) => {
    try {
      const project = await ensureAccountGitSpaceProject(env, userId, input);
      return ok({ ...project, updatedAt: new Date(project.updatedAt), archivedAt: project.archivedAt ? new Date(project.archivedAt) : null });
    } catch (error) { return err(errors.OperationFailed({ operation: 'ensure GitSpace project', message: message(error) })); }
  });
  const devices = server.implement(listDevicesContract).handler(async ({ errors }) => {
    try {
      return ok((await deviceRecords()).map(({ record, verified }) => ({
        deviceId: record.binding.deviceId, kind: record.invite.invite.kind, label: record.binding.label,
        scope: record.invite.invite.scope.kind === 'user' ? 'user' : record.invite.invite.scope.kind === 'project' ? `project:${record.invite.invite.scope.projectId}` : `workspace:${record.invite.invite.scope.workspaceId}`,
        capabilities: [...record.invite.invite.capabilities], boundAt: new Date(record.binding.boundAt).toISOString(),
        expiresAt: verified?.expiresAt ? new Date(verified.expiresAt).toISOString() : null,
        revokedAt: record.revokedAt === null ? null : new Date(record.revokedAt).toISOString(),
        active: verified !== null, current: record.binding.deviceId === deviceId,
      })));
    } catch (error) { return err(errors.OperationFailed({ operation: 'list devices', message: message(error) })); }
  });
  const revoke = server.implement(revokeDeviceContract).handler(async ({ input, errors }) => {
    try {
      const result = await vault.revokeDeviceGrant(input.deviceId);
      if (result.status === 'error') throw new Error(result.error.message);
      return ok({ deviceId: result.value.deviceId, revokedAt: new Date(result.value.revokedAt).toISOString() });
    } catch (error) { return err(errors.OperationFailed({ operation: 'revoke device', message: message(error) })); }
  });
  const getComposio = server.implement(getComposioSetupContract).handler(async ({ errors }) => {
    try { return ok(await composioSetup()); }
    catch (error) { return err(errors.OperationFailed({ operation: 'get Composio setup', message: message(error) })); }
  });
  const setComposio = server.implement(putComposioSetupContract).handler(async ({ input, errors }) => {
    try {
      await new ComposioPluginGateway(env, input.apiKey.trim()).catalog();
      await vault.putProviderSecret('composio', input.apiKey);
      return ok(await composioSetup());
    } catch (error) { return err(errors.OperationFailed({ operation: 'set Composio setup', message: message(error) })); }
  });
  const deleteComposio = server.implement(deleteComposioSetupContract).handler(async ({ errors }) => {
    try { await vault.deleteProviderSecret('composio'); return ok(await composioSetup()); }
    catch (error) { return err(errors.OperationFailed({ operation: 'delete Composio setup', message: message(error) })); }
  });
  const inferenceList = server.implement(inferenceListContract).handler(async ({ errors }) => {
    try {
      const readiness = await vault.inferenceReadiness();
      return readiness.status === 'waiting' ? err(errors.InferenceActivationPending({})) : ok(readiness.value);
    }
    catch (error) { return err(errors.OperationFailed({ operation: 'list inference profiles', message: message(error) })); }
  });
  const inferenceCreate = server.implement(inferenceCreateContract).handler(async ({ input, errors }) => {
    try { await requireAdministration(); return ok(await vault.createInferenceProfile(input)); }
    catch (error) { return err(errors.OperationFailed({ operation: 'create inference profile', message: message(error) })); }
  });
  const inferenceUpdate = server.implement(inferenceUpdateContract).handler(async ({ input, errors }) => {
    try {
      await requireAdministration();
      const result = await vault.updateInferenceProfile(input);
      if (result.status === 'conflict') return err(errors.SettingsConflict({ resource: result.resource, expected: result.expected, actual: result.actual }));
      return ok(result.value);
    } catch (error) { return err(errors.OperationFailed({ operation: 'update inference profile', message: message(error) })); }
  });
  const inferenceDelete = server.implement(inferenceDeleteContract).handler(async ({ input, errors }) => {
    try {
      await requireAdministration();
      const result = await vault.deleteInferenceProfile(input);
      if (result.status === 'conflict') return err(errors.SettingsConflict({ resource: result.resource, expected: result.expected, actual: result.actual }));
      return ok(result.value);
    } catch (error) { return err(errors.OperationFailed({ operation: 'delete inference profile', message: message(error) })); }
  });
  const inferenceAssign = server.implement(inferenceAssignContract).handler(async ({ input, errors }) => {
    try {
      await requireAdministration();
      const result = await vault.assignInferenceProfile(input);
      if (result.status === 'conflict') return err(errors.SettingsConflict({ resource: result.resource, expected: result.expected, actual: result.actual }));
      return ok(result.value);
    } catch (error) { return err(errors.OperationFailed({ operation: 'assign inference profile', message: message(error) })); }
  });
  const inferenceEvents = server.implement(inferenceEventsContract).stream(async function* ({ input, signal, errors }) {
    try {
      await requireSubscription();
      if ((await vault.inferenceReadiness()).status === 'waiting') {
        yield err(errors.InferenceActivationPending({}));
        return;
      }
      for await (const event of consumeDurableStream<InferenceState>(await vault.watchInference(input.after), signal)) {
        await requireSubscription();
        yield ok(event);
      }
    } catch (error) { if (!signal.aborted) yield err(errors.OperationFailed({ operation: 'subscribe to inference profiles', message: message(error) })); }
  });
  const configuration = configurationCloudProcedures(env, userId, deviceId, origin);
  return server.router({
    runtime: runtimeCloudProcedures(env, userId, deviceId),
    placements, session: { locate: locateSession },
    inference: { list: inferenceList, create: inferenceCreate, update: inferenceUpdate, delete: inferenceDelete, assign: inferenceAssign, events: inferenceEvents },
    secrets: configuration.secrets, configuration: configuration.configuration, skills: configuration.skills, crons: configuration.crons,
    settings: { get: getSettings, update: updateSettings, reserveHandle, git: { get: getGit }, runtime: { get: getRuntime, set: setRuntime }, events: settingsEvents },
    machines, machine: { events: machineEvents, createSandbox, updateNotes, sleep, resume, destroy, image: { list: images, events: imageEvents, set: setImage, retry: retryImage, cancel: cancelImage, recover: recoverImage, defaults: { get: imageDefault, set: setImageDefault } } }, project: { list: projects, ensureGitSpace, events: projectEvents, directoryEvents },
    space: { events: spaceEvents }, incidents: { record: recordIncident },
    devices: { list: devices, revoke }, providers: providerCloudProcedures(env, userId, requireAdministration),
    mcp: { ...configuration.mcp, composio: { ...configuration.mcp.composio, setup: { get: getComposio, put: setComposio, delete: deleteComposio } } },
    inspector: inspectorCloudProcedures(env, userId, requireSubscription, async () => {
      const device = await vault.currentDeviceGrant(deviceId);
      if (!device) throw new Error('Device authority has expired or been revoked');
      return device;
    }),
    environment: { ...environmentCloudProcedures(env, userId, deviceId, () => requireAdministration('lifecycle.control')), events: environmentEvents },
  });
}

/** Where the account sends a `/rpc` request: answered here (`target: 'cloud'`
 * when the account router served it), or forwarded untouched to one machine,
 * any online machine when `holder` is null. A signed batch is never split. */
export type AccountRpcRoute =
  | { kind: 'response'; response: Response; procedures?: readonly string[]; target?: 'cloud' }
  | { kind: 'machine'; procedures: readonly string[]; holder: FleetMachineDefinition | null };

/** Called after the account's active-state and tenant-hostname checks. */
export async function handleAccountCloudRpc(request: Request, env: Env, userId: string): Promise<AccountRpcRoute> {
  if (request.method !== 'POST') return { kind: 'response', response: transportError(405, 'RPC_METHOD_INVALID', 'RPC requests must use POST') };
  const copy = request.clone();
  const body = await readBody(copy);
  if (!body) {
    // A tee branch's cancellation waits for its sibling; cancel both together.
    await Promise.all([copy.body?.cancel(), request.body?.cancel()]);
    return { kind: 'response', response: transportError(413, 'RPC_REQUEST_TOO_LARGE', 'RPC request exceeds the account limit') };
  }
  let items: z.infer<typeof envelopeSchema>;
  try { items = envelopeSchema.parse(parse(new TextDecoder().decode(body))); }
  catch { return { kind: 'response', response: transportError(400, 'RPC_ENVELOPE_INVALID', 'RPC request envelope is invalid') }; }
  const procedures = [...new Set(items.map((item) => item.path))];
  const reject = (status: number, code: string, text: string): AccountRpcRoute => ({ kind: 'response', response: transportError(status, code, text), procedures });
  const terminals = items.filter((item) => isTerminalRpcPath(item.path));
  if (terminals.length > 0) {
    // A terminal runs where the caller chose; it never follows a placement holder or an arbitrary online machine.
    if (terminals.length !== items.length) return reject(400, 'RPC_MIXED_AUTHORITY_BATCH', 'Terminal operations require a separate signed batch');
    const targets = items.map((item) => rpcCallTarget(item.path, item.input));
    const target = targets[0];
    if (target?.kind !== 'terminal') return reject(400, 'TERMINAL_MACHINE_REQUIRED', 'Terminal operations must name the machine that runs the terminal');
    if (targets.some((other) => other?.kind !== 'terminal' || other.spaceId !== target.spaceId || other.machineId !== target.machineId)) {
      return reject(400, 'RPC_MIXED_TERMINAL_BATCH', 'Terminal operations for different workspaces or machines require separate signed batches');
    }
    const authority = (env.SPACE_AUTHORITY as DurableObjectNamespace<SpaceAuthorityDO>).getByName(`${userId}:${target.spaceId}`);
    if (!await authority.runtimeTerminalMachine(target.machineId)) {
      if (await authority.hasCloudRuntime()) return reject(409, 'TERMINAL_MACHINE_NOT_ATTACHED', `Machine ${target.machineId} is not a ready cache of this workspace; attach it to open terminals there`);
      const placement = await authority.get();
      if (placement?.state !== 'open' || placement.machineId !== target.machineId) return reject(409, 'TERMINAL_MACHINE_NOT_HOLDER', `Machine ${target.machineId} does not hold this workspace`);
    }
    const machine = await (env.FLEET_CATALOG as DurableObjectNamespace<FleetCatalogDO>).getByName(userId).getMachine(target.machineId);
    if (machine?.state !== 'online' || machine.desiredState !== 'online' || !machine.rpcEndpoint) return reject(503, 'TERMINAL_MACHINE_OFFLINE', `Machine ${target.machineId} is not online`);
    return { kind: 'machine', procedures, holder: machine };
  }
  const spaceReads = items.filter((item) => isSpaceCloudRpcPath(item.path));
  if (spaceReads.length > 0) {
    if (spaceReads.length !== items.length) return reject(400, 'RPC_MIXED_AUTHORITY_BATCH', 'Workspace reads and other operations require separate signed batches');
    const spaceId = spaceCloudRpcSpaceId(spaceReads[0]!.input);
    if (spaceReads.some((item) => spaceCloudRpcSpaceId(item.input) !== spaceId)) return reject(400, 'RPC_MIXED_AUTHORITY_BATCH', 'Workspace reads require separate signed batches');
    if (spaceId) {
      // A cloud workspace's checkout lives in the cloud: a legacy placement never answers for it.
      const authority = (env.SPACE_AUTHORITY as DurableObjectNamespace<SpaceAuthorityDO>).getByName(`${userId}:${spaceId}`);
      const placement = await authority.get();
      if (placement?.state === 'open' && placement.machineId && !await authority.hasCloudRuntime()) {
        const machine = await (env.FLEET_CATALOG as DurableObjectNamespace<FleetCatalogDO>).getByName(userId).getMachine(placement.machineId);
        if (machine?.state === 'online' && machine.desiredState === 'online' && machine.rpcEndpoint) {
          return { kind: 'machine', procedures, holder: machine };
        }
      }
    }
  }
  const cloud = items.filter((item) => isAccountCloudRpcPath(item.path) || isSpaceCloudRpcPath(item.path));
  if (cloud.length === 0) {
    const holders = await liveHolders(env, userId, items);
    if (holders.length > 1) return reject(400, 'RPC_MIXED_HOLDER_BATCH', `This batch names spaces held by different machines (${holders.map((machine) => machine.id).join(', ')}); send calls for each space or session in a separate signed batch`);
    return { kind: 'machine', procedures, holder: holders[0] ?? null };
  }
  if (cloud.length !== items.length) return reject(400, 'RPC_MIXED_AUTHORITY_BATCH', 'Cloud and machine operations must use separate signed batches');
  // A CPU-limit kill leaves no later log line; joining this line by request ID names the batch.
  console.log(JSON.stringify({ event: 'rpc_start', procedures, items: items.length, requestBytes: body.byteLength }));
  const capabilities: DeviceCapability[] = [];
  for (const item of items) {
    const procedure = gitspaceContract.procedures.get(item.path);
    if (!procedure) return reject(404, 'RPC_PROCEDURE_UNKNOWN', `Unknown procedure ${item.path}`);
    const capability = requiredCapability(item.path, procedure._def.kind);
    if (!capabilities.includes(capability)) capabilities.push(capability);
    if (requiresImageSelectionControl(item.path, item.input) && !capabilities.includes('deployment.control')) capabilities.push('deployment.control');
  }
  const url = new URL(request.url);
  const vault = (env.CREDENTIALS as DurableObjectNamespace<CredentialVaultDO>).getByName(userId);
  const proof = { header: request.headers.get(RPC_DEVICE_HEADER), target: `${url.pathname}${url.search}`, body, capabilities };
  const authorized = items.every(item => item.path.startsWith('runtime.'))
    ? await vault.authorizeWorkspaceRuntimeRequest(proof)
    : await vault.authorizeAccountDeviceRequest(proof);
  if (authorized.status === 'error') return reject(authorized.error.code === 'REQUEST_REPLAY' ? 409 : authorized.error.code === 'RPC_FORBIDDEN' ? 403 : 401, authorized.error.code, authorized.error.message);
  const handler = createFetchHandler({
    router: accountRouter(env, userId, authorized.value.deviceId, env.ACCOUNT_URL), endpoint: url.pathname, maxBatchItems: MAX_BATCH_ITEMS, maxRequestBytes: MAX_REQUEST_BYTES, contractVersion: CONTRACT_VERSION, createContext: () => ({}),
    // Incident IDs shown to users must lead somewhere: log the cause server-side, never in the response.
    onInternalError: ({ incidentId, phase, cause, procedurePath }) => {
      console.error(JSON.stringify({ event: 'rpc_internal_error', incidentId, phase, procedurePath, message: cause instanceof Error ? cause.message : String(cause), stack: cause instanceof Error ? cause.stack : undefined }));
    },
  });
  const response = await handler(request);
  response.headers.set('cache-control', 'private, no-store');
  return { kind: 'response', response, procedures, target: 'cloud' };
}
