import { DurableObject } from 'cloudflare:workers';
import { subscriptionIdentity, subscriptionActive } from './account-access.js';
import { DurableChangeLog } from './durable-stream.js';
import { z } from 'zod';
import { cloudImageChoiceSchema, cloudImageOperationActive, cloudImageOperationCancellable, cloudImageProviderStatusSchema, cloudImageSelectionSchema, cloudImageStateSchema, type CloudImageChoice, type CloudImageSelection, type CloudImageState } from '@gitspace/protocol/cloud-image';
import { cloudImageProviderCall, prepareCloudImage, resolveCloudImage, runCloudImageOperation } from './sandbox-rollout.js';
import { controlCloudflareSandboxMachine, createCloudflareSandboxMachine } from './sandbox-provisioner.js';

export interface PortableSpaceDefinition {
  projectId: string;
  projectName: string;
  repositoryReference: string | null;
  baseBranch: string;
  spaceId: string;
  kind: 'base' | 'worktree';
  name: string;
  branch: string;
  phase: 'plan' | 'code' | 'review' | 'ship' | null;
}

export interface FleetMachineDefinition {
  id: string;
  label: string;
  state: 'provisioning' | 'online' | 'sleeping' | 'offline' | 'resuming' | 'deleting' | 'error';
  rpcEndpoint: string | null;
  kind: 'physical' | 'sandbox';
  notes: string;
  provider: 'physical' | 'cloudflare-sandbox';
  desiredState: 'online' | 'offline' | 'removed';
  lifecycleRevision: number;
  operationId: string | null;
  error: string | null;
}

interface SandboxEnrollment {
  userId: string;
  machineId: string;
  choice: CloudImageChoice;
  environment: Record<string, string>;
}

export class FleetCatalogDO extends DurableObject<Env> {
  private readonly changes: DurableChangeLog;
  private readonly imageRuns = new Map<string, Promise<void>>();
  private readonly provisioningRuns = new Map<string, Promise<void>>();
  private imageDefaultRun: Promise<CloudImageChoice> | null = null;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.changes = new DurableChangeLog(ctx.storage);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS space_definitions (
          space_id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          definition_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS fleet_machines (
          machine_id TEXT PRIMARY KEY,
          definition_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS destroyed_machines(machine_id TEXT PRIMARY KEY,destroyed_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS cloud_images(machine_id TEXT PRIMARY KEY,state_json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS cloud_image_default(singleton INTEGER PRIMARY KEY CHECK(singleton=1),choice_json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS cloud_image_operation_ids(operation_id TEXT PRIMARY KEY,machine_id TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS sandbox_enrollments(machine_id TEXT PRIMARY KEY,enrollment_json TEXT NOT NULL);
      `);
      for (const row of this.ctx.storage.sql.exec<{ machine_id: string }>('SELECT machine_id FROM sandbox_enrollments').toArray()) {
        const machine = this.getMachine(row.machine_id);
        if (machine?.state === 'provisioning') this.saveMachine({
          ...machine, state: 'error', operationId: null, lifecycleRevision: machine.lifecycleRevision + 1,
          error: 'Sandbox provisioning was interrupted. Start the machine to resume.',
        });
      }
    });
  }

  cloudImage(machineId: string): CloudImageState | null {
    const row = this.ctx.storage.sql.exec<{ state_json: string }>('SELECT state_json FROM cloud_images WHERE machine_id=?', machineId).toArray()[0];
    return row ? cloudImageStateSchema.parse(JSON.parse(row.state_json)) : null;
  }

  listCloudImages(): CloudImageState[] {
    return this.ctx.storage.sql.exec<{ state_json: string }>('SELECT state_json FROM cloud_images ORDER BY machine_id').toArray().map(row => cloudImageStateSchema.parse(JSON.parse(row.state_json)));
  }

  watchCloudImages(after: number | null): ReadableStream<Uint8Array> {
    return this.changes.watch('cloud-images', after, () => this.listCloudImages());
  }

  saveCloudImage(input: CloudImageState): CloudImageState {
    if (this.hasPendingSandbox(input.machineId)) throw new Error('Finish sandbox provisioning before changing its image');
    return this.writeCloudImage(input);
  }

  private writeCloudImage(input: CloudImageState): CloudImageState {
    const state = cloudImageStateSchema.parse(input);
    this.ctx.storage.transactionSync(() => {
      if (state.operation) this.ctx.storage.sql.exec('INSERT OR IGNORE INTO cloud_image_operation_ids(operation_id,machine_id) VALUES(?,?)', state.operation.id, state.machineId);
      this.ctx.storage.sql.exec('INSERT INTO cloud_images(machine_id,state_json) VALUES(?,?) ON CONFLICT(machine_id) DO UPDATE SET state_json=excluded.state_json', state.machineId, JSON.stringify(state));
      this.changes.append('cloud-images', this.listCloudImages());
    });
    this.changes.wake();
    return state;
  }

  async cloudImageDefault(): Promise<CloudImageChoice> {
    const row = this.ctx.storage.sql.exec<{ choice_json: string }>('SELECT choice_json FROM cloud_image_default WHERE singleton=1').toArray()[0];
    if (row) return cloudImageChoiceSchema.parse(JSON.parse(row.choice_json));
    if (this.imageDefaultRun) return this.imageDefaultRun;
    const run = (async () => {
      const choice = await resolveCloudImage(this.env, { kind: 'platform-default' });
      this.ctx.storage.sql.exec('INSERT OR IGNORE INTO cloud_image_default(singleton,choice_json) VALUES(1,?)', JSON.stringify(choice));
      const pinned = this.ctx.storage.sql.exec<{ choice_json: string }>('SELECT choice_json FROM cloud_image_default WHERE singleton=1').toArray()[0]!;
      return cloudImageChoiceSchema.parse(JSON.parse(pinned.choice_json));
    })();
    this.imageDefaultRun = run;
    try { return await run; } finally { this.imageDefaultRun = null; }
  }

  async setCloudImageDefault(input: CloudImageSelection): Promise<CloudImageChoice> {
    if (this.imageDefaultRun) throw new Error('An account image default update is already in progress');
    const selection = cloudImageSelectionSchema.parse(input);
    const run = (async () => {
      const choice = await resolveCloudImage(this.env, selection);
      await prepareCloudImage(this.env, choice.image);
      this.ctx.storage.sql.exec('INSERT INTO cloud_image_default(singleton,choice_json) VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET choice_json=excluded.choice_json', JSON.stringify(choice));
      return choice;
    })();
    this.imageDefaultRun = run;
    try { return await run; } finally { this.imageDefaultRun = null; }
  }

  startCloudImage(input: { userId: string; machineId: string; operationId: string; selection: CloudImageSelection }): CloudImageState {
    if (input.userId !== this.env.ACCOUNT_ID) throw new Error('Cloud image operation belongs to another account');
    const operationId = z.string().uuid().parse(input.operationId);
    const selection = cloudImageSelectionSchema.parse(input.selection);
    const machine = this.getMachine(input.machineId);
    if (!machine || machine.provider !== 'cloudflare-sandbox') throw new Error('Account cloud machine does not exist');
    if (this.hasPendingSandbox(machine.id)) throw new Error('Finish sandbox provisioning before changing its image');
    const existing = this.cloudImage(machine.id);
    if (existing?.operation?.id === operationId) {
      if (JSON.stringify(existing.selection) !== JSON.stringify(selection)) throw new Error('Operation id is already bound to another image');
      return existing;
    }
    if (this.ctx.storage.sql.exec('SELECT operation_id FROM cloud_image_operation_ids WHERE operation_id=?', operationId).toArray().length) throw new Error('Image operation id has already been used; it cannot select another machine or supersede a newer operation');
    if (cloudImageOperationActive(existing)) throw new Error('Recover or cancel the active image operation first');
    if (machine.operationId || machine.desiredState !== 'online' || machine.state !== 'online') throw new Error('Start the cloud machine and finish its lifecycle operation before changing its image');
    const now = Date.now();
    const state = this.saveCloudImage({ machineId: machine.id, currentImage: existing?.currentImage ?? null, desiredImage: selection.kind === 'custom' ? selection.image : null, selection, operation: { id: operationId, phase: 'staging', barrier: false, error: null, startedAt: now, updatedAt: now, resumeSpaceIds: [] } });
    this.launchCloudImage(state);
    return state;
  }

  retryCloudImage(input: { userId: string; machineId: string; operationId: string; cancel?: boolean }): CloudImageState {
    if (input.userId !== this.env.ACCOUNT_ID) throw new Error('Cloud image operation belongs to another account');
    const state = this.cloudImage(input.machineId);
    if (!this.getMachine(input.machineId) || !state?.operation || state.operation.id !== input.operationId) throw new Error('Cloud image operation identity does not match this account machine');
    if (!cloudImageOperationActive(state)) return state;
    if (this.imageRuns.has(input.machineId)) {
      if (input.cancel) throw new Error('Image operation is running; wait for it to settle before cancelling');
      return state;
    }
    if (input.cancel) {
      if (!cloudImageOperationCancellable(state)) throw new Error('Image selection may already have changed; retry recovery instead of cancelling');
      if (state.operation.phase === 'staging') {
        state.operation.phase = 'cancelled';
        state.desiredImage = state.currentImage;
      } else state.operation.phase = 'cancelling';
    }
    state.operation.error = null;
    state.operation.updatedAt = Date.now();
    this.saveCloudImage(state);
    if (cloudImageOperationActive(state)) this.launchCloudImage(state);
    return state;
  }

  recoverCloudImage(input: { userId: string; machineId: string; operationId: string; recoveryOperationId: string; selection: CloudImageSelection; discardUncheckpointedCandidate?: boolean; approvedBy: string }): CloudImageState {
    if (input.userId !== this.env.ACCOUNT_ID) throw new Error('Cloud image operation belongs to another account');
    const recoveryId = z.string().uuid().parse(input.recoveryOperationId);
    const selection = cloudImageSelectionSchema.parse(input.selection);
    const discardApproval = input.discardUncheckpointedCandidate ? { deviceId: z.string().min(1).parse(input.approvedBy), at: Date.now() } : undefined;
    const state = this.cloudImage(input.machineId);
    if (!this.getMachine(input.machineId) || !state?.operation) throw new Error('Account cloud machine image operation does not exist');
    if (state.operation.id === recoveryId) {
      if (state.operation.recoveryOf !== input.operationId || JSON.stringify(state.selection) !== JSON.stringify(selection) || !!state.operation.discardApproval !== !!discardApproval) throw new Error('Recovery id is already bound to another operation, image or consent');
      return state;
    }
    if (state.operation.id !== input.operationId || !cloudImageOperationActive(state) || cloudImageOperationCancellable(state)) throw new Error('This operation does not require alternate-image recovery');
    if (this.imageRuns.has(input.machineId)) throw new Error('Wait for the current image operation to settle before selecting a recovery image');
    if (this.ctx.storage.sql.exec('SELECT operation_id FROM cloud_image_operation_ids WHERE operation_id=?', recoveryId).toArray().length) throw new Error('Recovery operation id has already been used');
    const now = Date.now();
    const recovering = this.saveCloudImage({ ...state, selection, desiredImage: selection.kind === 'custom' ? selection.image : null, operation: { id: recoveryId, recoveryOf: input.operationId, discardApproval, phase: 'staging', barrier: true, error: null, startedAt: now, updatedAt: now, resumeSpaceIds: state.operation.resumeSpaceIds } });
    this.launchCloudImage(recovering);
    return recovering;
  }

  private launchCloudImage(state: CloudImageState): void {
    if (this.imageRuns.has(state.machineId)) return;
    const run = runCloudImageOperation(this.env, this, state).finally(() => this.imageRuns.delete(state.machineId));
    this.imageRuns.set(state.machineId, run);
    this.ctx.waitUntil(run);
  }

  hasPendingSandbox(machineId: string): boolean {
    validateId(machineId);
    return this.ctx.storage.sql.exec('SELECT machine_id FROM sandbox_enrollments WHERE machine_id=?', machineId).toArray().length > 0;
  }

  beginSandboxProvisioning(input: SandboxEnrollment): FleetMachineDefinition {
    if (input.userId !== this.env.ACCOUNT_ID) throw new Error('Machine belongs to another account');
    if (!/^sandbox-[a-z0-9-]{1,64}$/u.test(input.machineId) || input.environment.GITSPACE_MACHINE_ID !== input.machineId || input.environment.GITSPACE_USER_ID !== input.userId) throw new Error('Sandbox enrollment identity is invalid');
    if (this.getMachine(input.machineId) || this.wasMachineDestroyed(input.machineId)) throw new Error('Sandbox identity has already been allocated');
    const choice = cloudImageChoiceSchema.parse(input.choice);
    const machine: FleetMachineDefinition = {
      id: input.machineId, label: `Cloudflare ${input.machineId.slice('sandbox-'.length)}`,
      state: 'provisioning', rpcEndpoint: null, kind: 'sandbox', provider: 'cloudflare-sandbox',
      notes: 'Provisioning Cloudflare Sandbox machine runtime.', desiredState: 'online',
      lifecycleRevision: 1, operationId: crypto.randomUUID(), error: null,
    };
    this.ctx.storage.transactionSync(() => {
      // The only durable copy of private enrollment belongs to this tenant, never
      // a fleet snapshot, event, image record, or platform resource definition.
      this.ctx.storage.sql.exec('INSERT INTO sandbox_enrollments(machine_id,enrollment_json) VALUES(?,?)', machine.id, JSON.stringify({ ...input, choice }));
      this.writeCloudImage({ machineId: machine.id, selection: choice.kind === 'custom' ? choice : { kind: 'platform-default' }, currentImage: null, desiredImage: choice.image, operation: null });
      this.saveMachine(machine);
    });
    this.launchSandboxProvisioning(machine.id);
    return machine;
  }

  resumeSandboxProvisioning(userId: string, machineId: string): FleetMachineDefinition | null {
    if (userId !== this.env.ACCOUNT_ID) throw new Error('Machine belongs to another account');
    if (!this.hasPendingSandbox(machineId)) return null;
    const current = this.getMachine(machineId);
    if (!current || current.desiredState !== 'online') throw new Error('Sandbox provisioning is no longer active');
    if (this.provisioningRuns.has(machineId)) return current;
    const machine = this.saveMachine({ ...current, state: 'provisioning', lifecycleRevision: current.lifecycleRevision + 1, operationId: crypto.randomUUID(), error: null });
    this.launchSandboxProvisioning(machineId);
    return machine;
  }

  private launchSandboxProvisioning(machineId: string): void {
    if (this.provisioningRuns.has(machineId)) return;
    const run = this.runSandboxProvisioning(machineId).finally(() => this.provisioningRuns.delete(machineId));
    this.provisioningRuns.set(machineId, run);
    this.ctx.waitUntil(run);
  }

  private async runSandboxProvisioning(machineId: string): Promise<void> {
    const row = this.ctx.storage.sql.exec<{ enrollment_json: string }>('SELECT enrollment_json FROM sandbox_enrollments WHERE machine_id=?', machineId).toArray()[0];
    if (!row) return;
    const enrollment = JSON.parse(row.enrollment_json) as SandboxEnrollment;
    const operationId = this.getMachine(machineId)?.operationId;
    const active = () => this.hasPendingSandbox(machineId) && this.getMachine(machineId)?.operationId === operationId;
    try {
      await prepareCloudImage(this.env, enrollment.choice.image);
      if (!active()) return;
      let machine: FleetMachineDefinition | null;
      try {
        machine = await createCloudflareSandboxMachine({ env: this.env, userId: enrollment.userId, machineId, image: enrollment.choice.image, environment: enrollment.environment });
      } catch {
        if (!active()) return;
        // Creation may have been accepted even though its response was lost.
        // Observe once; an unready/unenrolled machine remains explicitly retryable.
        machine = await controlCloudflareSandboxMachine({ env: this.env, userId: enrollment.userId, machineId, action: 'status' });
      }
      if (!active()) return;
      const provider = cloudImageProviderStatusSchema.parse(await cloudImageProviderCall(this.env, `/v1/sandboxes/${encodeURIComponent(machineId)}/image/status`));
      if (!active()) return;
      if (!machine || machine.state !== 'online' || provider.image !== enrollment.choice.image || provider.prepared) throw new Error('Sandbox is not ready');
      const current = this.getMachine(machineId)!;
      const rpcEndpoint = new URL(`/__sandbox/${encodeURIComponent(enrollment.userId)}/${encodeURIComponent(machineId)}/rpc`, enrollment.environment.GITSPACE_CONTROL_URL).toString();
      const lifecycleRevision = Math.max(current.lifecycleRevision, machine.lifecycleRevision) + 1;
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec('DELETE FROM sandbox_enrollments WHERE machine_id=?', machineId);
        this.writeCloudImage({ ...this.cloudImage(machineId)!, currentImage: enrollment.choice.image });
        // Provider error/notes/labels are untrusted and may echo enrollment.
        this.saveMachine({ ...current, state: 'online', rpcEndpoint, notes: 'Managed Cloudflare Sandbox. Machine runtime ready.', lifecycleRevision, operationId: null, error: null });
      });
    } catch {
      if (!active()) return;
      const current = this.getMachine(machineId)!;
      this.saveMachine({ ...current, state: 'error', lifecycleRevision: current.lifecycleRevision + 1, operationId: null, error: 'Sandbox provisioning failed. Start the machine to retry with its retained enrollment.' });
    }
  }

  putSpace(input: PortableSpaceDefinition): PortableSpaceDefinition {
    validateSpace(input);
    this.ctx.storage.sql.exec(`
      INSERT INTO space_definitions(space_id, project_id, definition_json, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(space_id) DO UPDATE SET
        project_id = excluded.project_id,
        definition_json = excluded.definition_json,
        updated_at = excluded.updated_at
    `, input.spaceId, input.projectId, JSON.stringify(input), new Date().toISOString());
    return input;
  }

  getSpace(spaceId: string): PortableSpaceDefinition | null {
    validateId(spaceId);
    const row = this.ctx.storage.sql.exec<{ definition_json: string }>('SELECT definition_json FROM space_definitions WHERE space_id = ?', spaceId).toArray()[0];
    return row ? JSON.parse(row.definition_json) as PortableSpaceDefinition : null;
  }

  listSpaces(): PortableSpaceDefinition[] {
    return this.ctx.storage.sql.exec<{ definition_json: string }>('SELECT definition_json FROM space_definitions ORDER BY project_id, space_id').toArray()
      .map((row) => JSON.parse(row.definition_json) as PortableSpaceDefinition);
  }

  putMachine(input: FleetMachineDefinition): FleetMachineDefinition {
    const current = this.getMachine(input.id);
    if (this.wasMachineDestroyed(input.id)) throw new Error('Machine has been destroyed');
    if (current?.desiredState === 'removed' && input.desiredState !== 'removed') throw new Error('Machine is being destroyed');
    if (this.hasPendingSandbox(input.id)) {
      if (input.desiredState === 'removed') {
        // Fence every suspended provisioning continuation before a provider
        // destroy can run; Start must never retrieve these credentials again.
        return this.ctx.storage.transactionSync(() => {
          this.ctx.storage.sql.exec('DELETE FROM sandbox_enrollments WHERE machine_id=?', input.id);
          return this.saveMachine(input);
        });
      }
      if (input.desiredState !== 'online' || input.operationId !== null && input.operationId !== current?.operationId) throw new Error('Finish sandbox provisioning before changing its lifecycle');
      // Runtime self-registration/status is not evidence that enrollment and its
      // selected image have been confirmed by the provisioning owner.
      return current!;
    }
    return this.saveMachine(input);
  }

  private saveMachine(input: FleetMachineDefinition): FleetMachineDefinition {
    validateId(input.id);
    if (!input.label || !['provisioning', 'online', 'sleeping', 'offline', 'resuming', 'deleting', 'error'].includes(input.state) || !['online', 'offline', 'removed'].includes(input.desiredState) || !Number.isInteger(input.lifecycleRevision) || input.lifecycleRevision < 0 || !['physical', 'sandbox'].includes(input.kind) || !['physical', 'cloudflare-sandbox'].includes(input.provider) || input.notes.length > 4_000) throw new Error('Machine definition is invalid');
    if (input.rpcEndpoint !== null && !input.rpcEndpoint.startsWith('/')) new URL(input.rpcEndpoint);
    const current = this.getMachine(input.id);
    if (cloudImageOperationActive(this.cloudImage(input.id)) && (input.operationId !== null || input.desiredState !== 'online')) throw new Error('Cloud image recovery has reserved this machine lifecycle');
    if (current && JSON.stringify(current) === JSON.stringify(input)) return current;
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(`
        INSERT INTO fleet_machines(machine_id, definition_json, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(machine_id) DO UPDATE SET definition_json = excluded.definition_json, updated_at = excluded.updated_at
      `, input.id, JSON.stringify(input), new Date().toISOString());
      this.ctx.storage.sql.exec('DELETE FROM destroyed_machines WHERE machine_id=?', input.id);
      this.changes.append('machines', this.listMachines());
    });
    this.changes.wake();
    this.ctx.waitUntil(this.broadcast({ type: 'upsert', machineId: input.id, machine: input }));
    return input;
  }

  getMachine(machineId: string): FleetMachineDefinition | null {
    validateId(machineId);
    const row = this.ctx.storage.sql.exec<{ definition_json: string }>('SELECT definition_json FROM fleet_machines WHERE machine_id = ?', machineId).toArray()[0];
    if (!row) return null;
    const value = JSON.parse(row.definition_json) as Partial<FleetMachineDefinition> & Pick<FleetMachineDefinition, 'id' | 'label' | 'state' | 'rpcEndpoint'>;
    return normalizeMachine(value);
  }

  removeMachine(machineId: string, destroyed = false): boolean {
    validateId(machineId);
    if (cloudImageOperationActive(this.cloudImage(machineId))) throw new Error('Cloud image recovery has reserved this machine');
    destroyed ||= this.hasPendingSandbox(machineId);
    const removed = this.ctx.storage.transactionSync(() => {
      if (destroyed) this.ctx.storage.sql.exec('INSERT OR REPLACE INTO destroyed_machines(machine_id,destroyed_at) VALUES(?,?)', machineId, new Date().toISOString());
      this.ctx.storage.sql.exec('DELETE FROM sandbox_enrollments WHERE machine_id=?', machineId);
      const removed = this.ctx.storage.sql.exec('DELETE FROM fleet_machines WHERE machine_id = ?', machineId).rowsWritten > 0;
      if (removed) this.changes.append('machines', this.listMachines());
      if (removed) {
        this.ctx.storage.sql.exec('DELETE FROM cloud_images WHERE machine_id=?', machineId);
        this.changes.append('cloud-images', this.listCloudImages());
      }
      return removed;
    });
    if (removed) {
      this.changes.wake();
      this.ctx.waitUntil(this.broadcast({ type: 'remove', machineId, machine: null }));
    }
    return removed;
  }

  wasMachineDestroyed(machineId: string): boolean {
    validateId(machineId);
    return this.ctx.storage.sql.exec('SELECT machine_id FROM destroyed_machines WHERE machine_id=?', machineId).toArray().length > 0;
  }

  listMachines(): FleetMachineDefinition[] {
    return this.ctx.storage.sql.exec<{ definition_json: string }>('SELECT definition_json FROM fleet_machines ORDER BY machine_id').toArray()
      .map((row) => {
        const value = JSON.parse(row.definition_json) as Partial<FleetMachineDefinition> & Pick<FleetMachineDefinition, 'id' | 'label' | 'state' | 'rpcEndpoint'>;
        return normalizeMachine(value);
      });
  }
  watch(after: number | null): ReadableStream<Uint8Array> {
    return this.changes.watch('machines', after, () => this.listMachines());
  }
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return new Response('Expected WebSocket', { status: 426 });
    const identity = await subscriptionIdentity(this.env, request, 'space.control');
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(identity);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (await subscriptionActive(this.env, socket, 'space.control') && message === 'ping') socket.send('pong');
  }

  private async broadcast(event: { type: 'upsert' | 'remove'; machineId: string; machine: FleetMachineDefinition | null }): Promise<void> {
    const encoded = JSON.stringify(event);
    await Promise.all(this.ctx.getWebSockets().map(async (socket) => {
      if (!await subscriptionActive(this.env, socket, 'space.control')) return;
      try { socket.send(encoded); } catch { socket.close(1011, 'Fleet event delivery failed'); }
    }));
  }
}

function normalizeMachine(value: Partial<FleetMachineDefinition> & Pick<FleetMachineDefinition, 'id' | 'label' | 'state' | 'rpcEndpoint'>): FleetMachineDefinition {
  const state = ['provisioning', 'online', 'sleeping', 'offline', 'resuming', 'deleting', 'error'].includes(value.state) ? value.state : 'offline';
  return {
    ...value,
    state,
    kind: value.kind ?? 'physical',
    provider: value.provider ?? (value.kind === 'sandbox' ? 'cloudflare-sandbox' : 'physical'),
    notes: value.notes ?? '',
    desiredState: value.desiredState ?? (state === 'offline' ? 'offline' : 'online'),
    lifecycleRevision: value.lifecycleRevision ?? 0,
    operationId: value.operationId ?? null,
    error: value.error ?? null,
  };
}

function validateSpace(input: PortableSpaceDefinition): void {
  validateId(input.projectId);
  validateId(input.spaceId);
  if (!input.projectName || !input.baseBranch || !input.name || !input.branch) throw new Error('Space definition is invalid');
  if (input.kind === 'base' && (input.spaceId !== input.projectId || input.phase !== null)) throw new Error('Base definition is invalid');
  if (input.kind === 'worktree' && !['plan', 'code', 'review', 'ship'].includes(input.phase ?? '')) throw new Error('Worktree definition is invalid');
}

function validateId(value: string): void {
  if (!/^[A-Za-z0-9._-]{1,128}$/u.test(value)) throw new Error('Catalog id is invalid');
}
