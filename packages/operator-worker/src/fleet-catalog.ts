import { DurableObject } from 'cloudflare:workers';
import { subscriptionIdentity, subscriptionActive } from './account-access.js';

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

export class FleetCatalogDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
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
      `);
    });
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
    validateId(input.id);
    if (!input.label || !['provisioning', 'online', 'sleeping', 'offline', 'resuming', 'deleting', 'error'].includes(input.state) || !['online', 'offline', 'removed'].includes(input.desiredState) || !Number.isInteger(input.lifecycleRevision) || input.lifecycleRevision < 0 || !['physical', 'sandbox'].includes(input.kind) || !['physical', 'cloudflare-sandbox'].includes(input.provider) || input.notes.length > 4_000) throw new Error('Machine definition is invalid');
    if (input.rpcEndpoint !== null && !input.rpcEndpoint.startsWith('/')) new URL(input.rpcEndpoint);
    this.ctx.storage.sql.exec(`
      INSERT INTO fleet_machines(machine_id, definition_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(machine_id) DO UPDATE SET definition_json = excluded.definition_json, updated_at = excluded.updated_at
    `, input.id, JSON.stringify(input), new Date().toISOString());
    this.ctx.storage.sql.exec('DELETE FROM destroyed_machines WHERE machine_id=?', input.id);
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
    if (destroyed) this.ctx.storage.sql.exec('INSERT OR REPLACE INTO destroyed_machines(machine_id,destroyed_at) VALUES(?,?)', machineId, new Date().toISOString());
    const removed = this.ctx.storage.sql.exec('DELETE FROM fleet_machines WHERE machine_id = ?', machineId).rowsWritten > 0;
    if (removed) this.ctx.waitUntil(this.broadcast({ type: 'remove', machineId, machine: null }));
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
