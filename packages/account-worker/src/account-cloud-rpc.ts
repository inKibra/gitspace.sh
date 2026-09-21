import { authPolicyFor, authProviders } from '@oh-my-pi/pi-catalog/compat/auth';
import { ACCOUNT_CLOUD_RPC_PATHS, ACCOUNT_RUNTIME_RPC_PATHS, spaceCloudRpcSpaceId, isSpaceCloudRpcPath } from '@gitspace/protocol/account-rpc';
import { consumeDurableStream } from './durable-stream.js';
import { AgentIncidentChangeSchema } from '@gitspace/protocol-agent';
import type { LifecycleState } from '@gitspace/protocol-environment';
import type { CloudImageState } from '@gitspace/protocol/cloud-image';
import {
  credentialProtocolBase64, requiredCapability, requiresImageSelectionControl, RPC_DEVICE_HEADER, verifyDeviceGrantRecord,
  type DeviceCapability, type GitSpaceRpcContext, type ProviderView, type CloudProjectSummary,
} from '@gitspace/protocol';
import {
  gitspaceContract, getUserSettingsContract, updateUserSettingsContract, reserveUserHandleContract,
  getGitIdentityContract, getOmpSettingsContract, settingsEventsContract, listMachinesContract,
  machineLifecycleEventsContract, createSandboxMachineContract, updateMachineNotesContract,
  sleepMachineContract, resumeMachineContract, destroyMachineContract,
  listCloudImagesContract, cloudImageEventsContract, getCloudImageDefaultContract, setCloudImageDefaultContract,
  setCloudImageContract, retryCloudImageContract, cancelCloudImageContract, recoverCloudImageContract,
  listProjectsContract, listDevicesContract, revokeDeviceContract, listProvidersContract,
  setProviderApiKeyContract, logoutProviderContract, getComposioSetupContract,
  putComposioSetupContract, deleteComposioSetupContract,
  ensureGitSpaceProjectContract, placementsContract, locateSessionContract, type SpacePlacementView,
  projectEventsContract, projectDirectoryEventsContract, environmentEventsContract, spaceEventsContract, recordIncidentContract,
} from '@gitspace/protocol/rpc-contract';
import { parse } from 'devalue';
import { contractDigest, err, ok } from 'result-rpc';
import { createFetchHandler, serverRpc } from 'result-rpc/server';
import { z } from 'zod';
import { ComposioPluginGateway } from './composio-plugins.js';
import type { FleetCatalogDO, FleetMachineDefinition } from './fleet-catalog.js';
import { controlFleetMachine, provisionManagedSandbox, proxyAccountMachineRpc, reconcileFleetMachines, type CredentialVaultDO } from './application.js';
import type { ProjectAuthorityDO, UserProjectIndexDO } from './project-authority.js';
import type { UserSettingsDO, SettingsSnapshot } from './user-settings.js';
import type { SpaceAuthorityDO } from './space-authority.js';
import type { SpaceAuthorityRecord } from '@gitspace/protocol-workspace';
import { inspectorCloudProcedures } from './account-inspector-rpc.js';
import { ensureAccountGitSpaceProject } from './gitspace-project.js';
import { environmentCloudProcedures } from './account-environment-rpc.js';
import { configurationCloudProcedures } from './account-configuration-rpc.js';

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
  const requireHuman = async () => {
    const device = (await deviceRecords()).find(({ record }) => record.binding.deviceId === deviceId)?.verified;
    if (!device || device.kind !== 'browser' || device.scope.kind !== 'user' || !device.capabilities.includes('rpc.write')) {
      throw new Error('Lifecycle approval and recovery require an authenticated human browser');
    }
  };
  // Account dispatch authorizes the tenant once. Long-lived delivery checks the
  // tenant-local grant chain and revocation, not a shared application policy.
  const requireSubscription = async () => {
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
      const { spaces, projects } = await readDirectory();
      for (const project of projects) {
        const session = await (env.PROJECT_AUTHORITY as DurableObjectNamespace<ProjectAuthorityDO>).getByName(`${userId}:${project.id}`).getCanonicalSession(input.sessionId);
        if (session) return ok(spaces.find((space) => space.spaceId === session.workspaceId) ?? null);
      }
      return ok(null);
    } catch (error) { return err(errors.OperationFailed({ operation: 'locate session', message: message(error) })); }
  });
  const providers = async (): Promise<ProviderView[]> => {
    const [snapshot, machines] = await Promise.all([vault.ompSnapshot(), catalog.listMachines()]);
    const online = machines.some((machine) => machine.state === 'online' && machine.desiredState === 'online' && machine.rpcEndpoint);
    return authProviders().map((policy) => {
      const credentialProvider = policy.storeAs ?? policy.id;
      const stored = snapshot.credentials.filter((entry) => entry.provider === credentialProvider);
      const oauth = stored.some((entry) => entry.credential.type === 'oauth');
      const apiKey = policy.apiKeyFormat === 'bearer' && (!policy.login || policy.login.kind === 'api-key' || policy.env !== undefined);
      return {
        id: policy.id, credentialProvider, name: policy.name, available: policy.available ?? true,
        // Interactive OAuth still routes to a machine, when one is available.
        loginable: online && policy.login !== undefined,
        authKind: !online && apiKey && !oauth ? 'api_key' : oauth || policy.refresh !== undefined || policy.callbackPort !== undefined || policy.pasteCode === true ? 'oauth' : apiKey ? 'api_key' : 'none',
        hasAuth: stored.length > 0, source: stored.length ? oauth ? 'oauth' : 'api_key' : null,
        accounts: stored.map(({ id, credential }) => {
          const base = credential.type === 'oauth' ? credential.email ?? credential.accountId ?? 'OAuth account' : 'API key';
          const org = credential.type === 'oauth' ? credential.orgName ?? credential.orgId : null;
          return {
            id: String(id), type: credential.type, disabled: false,
            label: org && org !== base ? `${base} · ${org}` : base,
            email: credential.type === 'oauth' ? credential.email ?? null : null,
          };
        }),
        hasUsage: false,
      };
    });
  };
  const provider = async (id: string) => {
    const value = (await providers()).find((item) => item.id === id);
    if (!value) throw new Error(`Unknown provider: ${id}`);
    return value;
  };
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
  const getOmp = server.implement(getOmpSettingsContract).handler(async ({ errors }) => {
    try {
      // The cloud owns this document, not a machine's installed OMP schema or
      // runtime defaults. Schema-driven editing stays on the machine runtime.
      return ok({ document: await settings.getOmp(), schema: [], sync: { status: 'offline' as const, message: 'No online machine is available to provide the OMP settings schema.' } });
    } catch (error) { return err(errors.OperationFailed({ operation: 'get OMP settings', message: message(error) })); }
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
    try { return ok(await controlFleetMachine(env, userId, input.machineId, 'sleep')); }
    catch (error) { return err(errors.OperationFailed({ operation: 'sleep machine', message: message(error) })); }
  });
  const resume = server.implement(resumeMachineContract).handler(async ({ input, errors }) => {
    try { return ok(await controlFleetMachine(env, userId, input.machineId, 'resume')); }
    catch (error) { return err(errors.OperationFailed({ operation: 'resume machine', message: message(error) })); }
  });
  const destroy = server.implement(destroyMachineContract).handler(async ({ input, errors }) => {
    try { return ok(await controlFleetMachine(env, userId, input.machineId, 'destroy')); }
    catch (error) { return err(errors.OperationFailed({ operation: 'destroy machine', message: message(error) })); }
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
  const listProviders = server.implement(listProvidersContract).handler(async ({ errors }) => {
    try { return ok({ providers: await providers() }); }
    catch (error) { return err(errors.OperationFailed({ operation: 'list providers', message: message(error) })); }
  });
  const setApiKey = server.implement(setProviderApiKeyContract).handler(async ({ input, errors }) => {
    try {
      const policy = authPolicyFor(input.providerId);
      if (!policy || policy.apiKeyFormat !== 'bearer' || (policy.login && policy.login.kind !== 'api-key' && !policy.env)) throw new Error('This provider requires machine-based sign-in');
      await vault.putBrowserApiKey(policy.storeAs ?? policy.id, input.key);
      return ok({ provider: await provider(input.providerId) });
    } catch (error) { return err(errors.OperationFailed({ operation: 'set provider API key', message: message(error) })); }
  });
  const logout = server.implement(logoutProviderContract).handler(async ({ input, errors }) => {
    try {
      const policy = authPolicyFor(input.providerId);
      if (!policy) throw new Error(`Unknown provider: ${input.providerId}`);
      await vault.disableBrowserCredentials(policy.storeAs ?? policy.id, input.credentialId);
      return ok({ provider: await provider(input.providerId) });
    } catch (error) { return err(errors.OperationFailed({ operation: 'sign out provider', message: message(error) })); }
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
  const configuration = configurationCloudProcedures(env, userId, deviceId, origin);
  return server.router({
    placements, session: { locate: locateSession },
    secrets: configuration.secrets, configuration: configuration.configuration, skills: configuration.skills, crons: configuration.crons,
    settings: { get: getSettings, update: updateSettings, reserveHandle, git: { get: getGit }, omp: { get: getOmp }, events: settingsEvents },
    machines, machine: { events: machineEvents, createSandbox, updateNotes, sleep, resume, destroy, image: { list: images, events: imageEvents, set: setImage, retry: retryImage, cancel: cancelImage, recover: recoverImage, defaults: { get: imageDefault, set: setImageDefault } } }, project: { list: projects, ensureGitSpace, events: projectEvents, directoryEvents },
    space: { events: spaceEvents }, incidents: { record: recordIncident },
    devices: { list: devices, revoke }, providers: { list: listProviders, apiKey: { set: setApiKey }, logout },
    mcp: { ...configuration.mcp, composio: { ...configuration.mcp.composio, setup: { get: getComposio, put: setComposio, delete: deleteComposio } } },
    inspector: inspectorCloudProcedures(env, userId, requireSubscription),
    environment: { ...environmentCloudProcedures(env, userId, deviceId, requireHuman), events: environmentEvents },
  });
}

/** Called after the account's active-state and tenant-hostname checks.
 * Null leaves an untouched request for the existing machine proxy. */
export async function handleAccountCloudRpc(request: Request, env: Env, userId: string): Promise<Response | null> {
  if (request.method !== 'POST') return transportError(405, 'RPC_METHOD_INVALID', 'RPC requests must use POST');
  const copy = request.clone();
  const body = await readBody(copy);
  if (!body) {
    // A tee branch's cancellation waits for its sibling; cancel both together.
    await Promise.all([copy.body?.cancel(), request.body?.cancel()]);
    return transportError(413, 'RPC_REQUEST_TOO_LARGE', 'RPC request exceeds the account limit');
  }
  let items: z.infer<typeof envelopeSchema>;
  try { items = envelopeSchema.parse(parse(new TextDecoder().decode(body))); }
  catch { return transportError(400, 'RPC_ENVELOPE_INVALID', 'RPC request envelope is invalid'); }
  const spaceReads = items.filter((item) => isSpaceCloudRpcPath(item.path));
  if (spaceReads.length > 0) {
    if (spaceReads.length !== items.length) return transportError(400, 'RPC_MIXED_AUTHORITY_BATCH', 'Workspace reads and other operations require separate signed batches');
    const spaceId = spaceCloudRpcSpaceId(spaceReads[0]!.input);
    if (spaceReads.some((item) => spaceCloudRpcSpaceId(item.input) !== spaceId)) return transportError(400, 'RPC_MIXED_AUTHORITY_BATCH', 'Workspace reads require separate signed batches');
    if (spaceId) {
      const placement = await (env.SPACE_AUTHORITY as DurableObjectNamespace<SpaceAuthorityDO>).getByName(`${userId}:${spaceId}`).get();
      if (placement?.state === 'open' && placement.machineId) {
        const machine = await (env.FLEET_CATALOG as DurableObjectNamespace<FleetCatalogDO>).getByName(userId).getMachine(placement.machineId);
        if (machine?.state === 'online' && machine.desiredState === 'online' && machine.rpcEndpoint) {
          return proxyAccountMachineRpc(request, env, userId, machine);
        }
      }
    }
  }
  const cloud = items.filter((item) => Object.hasOwn(ACCOUNT_CLOUD_RPC_PATHS, item.path) || isSpaceCloudRpcPath(item.path));
  if (cloud.length === 0) return null;
  if (cloud.length !== items.length) return transportError(400, 'RPC_MIXED_AUTHORITY_BATCH', 'Cloud and machine operations must use separate signed batches');
  if (items.some((item) => Object.hasOwn(ACCOUNT_RUNTIME_RPC_PATHS, item.path))) {
    if (items.some((item) => !Object.hasOwn(ACCOUNT_RUNTIME_RPC_PATHS, item.path))) return transportError(400, 'RPC_MIXED_AUTHORITY_BATCH', 'Runtime metadata requires a separate signed batch');
    const machines = await (env.FLEET_CATALOG as DurableObjectNamespace<FleetCatalogDO>).getByName(userId).listMachines();
    if (machines.some((machine) => machine.state === 'online' && machine.desiredState === 'online' && machine.rpcEndpoint)) return null;
  }
  const capabilities: DeviceCapability[] = [];
  for (const item of items) {
    const procedure = gitspaceContract.procedures.get(item.path);
    if (!procedure) return transportError(404, 'RPC_PROCEDURE_UNKNOWN', `Unknown procedure ${item.path}`);
    const capability = requiredCapability(item.path, procedure._def.kind);
    if (!capabilities.includes(capability)) capabilities.push(capability);
    if (requiresImageSelectionControl(item.path, item.input) && !capabilities.includes('deployment.control')) capabilities.push('deployment.control');
  }
  const url = new URL(request.url);
  const vault = (env.CREDENTIALS as DurableObjectNamespace<CredentialVaultDO>).getByName(userId);
  const authorized = await vault.authorizeAccountDeviceRequest({ header: request.headers.get(RPC_DEVICE_HEADER), target: `${url.pathname}${url.search}`, body, capabilities });
  if (authorized.status === 'error') return transportError(authorized.error.code === 'REQUEST_REPLAY' ? 409 : authorized.error.code === 'RPC_FORBIDDEN' ? 403 : 401, authorized.error.code, authorized.error.message);
  const handler = createFetchHandler({ router: accountRouter(env, userId, authorized.value.deviceId, env.ACCOUNT_URL), endpoint: url.pathname, maxBatchItems: MAX_BATCH_ITEMS, maxRequestBytes: MAX_REQUEST_BYTES, contractVersion: CONTRACT_VERSION, createContext: () => ({}) });
  const response = await handler(request);
  response.headers.set('cache-control', 'private, no-store');
  return response;
}
