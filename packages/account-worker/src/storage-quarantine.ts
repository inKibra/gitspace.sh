import { DurableObject } from 'cloudflare:workers';
import { z } from 'zod';
import { installDurableObjectBreaker, type StorageBreaker, type StorageBreakerStatus } from '@gitspace/protocol/storage-breaker';
import type { GitSpaceRpcContext, VerifiedDevice } from '@gitspace/protocol';
import { storageIncidentsInspectContract, storageIncidentsListContract, storageIncidentsPauseContract, storageIncidentsResumeContract, type StorageInspectionView } from '@gitspace/protocol/rpc-contract';
import { err, ok } from 'result-rpc';
import { serverRpc } from 'result-rpc/server';

/** Something the account should know about one Durable Object's storage: it quarantined itself or was quarantined
 * (`quarantine`), or the platform's watchdog found it past one of its alert thresholds (`alert`). */
export const StorageIncidentReportSchema = z.object({
  objectId: z.string().regex(/^[0-9a-f]{64}$/u),
  className: z.string(),
  name: z.string().nullable(),
  kind: z.enum(['quarantine', 'alert']),
  reason: z.string(),
  at: z.string(),
});
export type StorageIncidentReport = z.infer<typeof StorageIncidentReportSchema>;
/** A recorded storage incident; `resolvedAt` is null while it is active. */
export const StorageIncidentSchema = StorageIncidentReportSchema.extend({ resolvedAt: z.string().nullable().default(null) });
export type StorageIncident = z.infer<typeof StorageIncidentSchema>;

/** Tables an inspection shows the newest rows of (the largest), and how many rows of each; values are cut to `INSPECT_VALUE_CHARACTERS`. */
const INSPECT_TABLES = 8;
const INSPECT_ROWS = 20;
const INSPECT_VALUE_CHARACTERS = 300;

/** A stored value as inspection text: long text cut short, binary as its size. */
function inspectValue(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (value instanceof ArrayBuffer) return `<${value.byteLength} bytes>`;
  const text = String(value);
  return text.length > INSPECT_VALUE_CHARACTERS ? `${text.slice(0, INSPECT_VALUE_CHARACTERS)}… (${text.length} characters)` : text;
}

/** Every Durable Object class of the account. The storage breaker is installed before the class touches its storage;
 * the object can be inspected, quarantined and resumed by its id. */
export abstract class BudgetedDurableObject extends DurableObject<Env> {
  readonly #breaker: StorageBreaker;
  readonly #identity: { objectId: string; className: string; name: string | null };

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const object = { objectId: ctx.id.toString(), className: new.target.name, name: ctx.id.name ?? null };
    this.#identity = object;
    this.#breaker = installDurableObjectBreaker(ctx, {
      onTrip: status => {
        console.error(JSON.stringify({ event: 'storage_quarantined', ...object, ...status }));
        this.#recordQuarantine(status);
      },
    });
  }

  #recordQuarantine(status: StorageBreakerStatus): void {
    const object = this.#identity;
    this.ctx.waitUntil(this.env.ACCOUNT_STATE.getByName('account').recordStorageIncident({ ...object, kind: 'quarantine', reason: status.reason ?? '', at: status.since ?? new Date().toISOString() })
      .catch((error: unknown) => console.error(JSON.stringify({ event: 'storage_incident_unrecorded', ...object, error: error instanceof Error ? error.message : String(error) }))));
  }

  storageBreakerStatus(): StorageBreakerStatus { return this.#breaker.status(); }
  quarantineStorage(reason: string): StorageBreakerStatus { return this.#breaker.quarantine(reason); }
  resumeStorage(): StorageBreakerStatus { return this.#breaker.resume(); }

  /** Pauses this object and lists it on the account's Monitoring page: the object's own decision, or an operator's. */
  pauseStorage(reason: string): StorageBreakerStatus {
    const already = this.#breaker.status().quarantined;
    const status = this.#breaker.quarantine(reason);
    if (!already) {
      console.error(JSON.stringify({ event: 'storage_paused', ...this.#identity, reason }));
      this.#recordQuarantine(status);
    }
    return status;
  }

  /** A few synchronous reads or writes a paused object still needs (an archive's own rows). */
  protected unguardedStorage<T>(work: () => T): T { return this.#breaker.unguarded(work); }

  /** What this object stores, read even while it is paused and without running any of its own code: each table's row
   * count (largest first), and the newest rows of the largest tables with every value cut short. */
  inspectStorage(): StorageInspectionView {
    return this.#breaker.unguarded(() => {
      const sql = this.ctx.storage.sql;
      const quoted = (name: string) => `"${name.replaceAll('"', '""')}"`;
      const names = sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").toArray().map(row => row.name);
      const tables = names.map(name => ({ name, rows: sql.exec<{ count: number }>(`SELECT COUNT(*) AS count FROM ${quoted(name)}`).one().count })).sort((left, right) => right.rows - left.rows);
      const newest = tables.slice(0, INSPECT_TABLES).filter(table => table.rows > 0).map(table => {
        // A table without a rowid keeps no insertion order: its first rows stand in for its newest.
        let rows: Record<string, SqlStorageValue>[];
        try { rows = sql.exec<Record<string, SqlStorageValue>>(`SELECT * FROM ${quoted(table.name)} ORDER BY rowid DESC LIMIT ${INSPECT_ROWS}`).toArray(); }
        catch { rows = sql.exec<Record<string, SqlStorageValue>>(`SELECT * FROM ${quoted(table.name)} LIMIT ${INSPECT_ROWS}`).toArray(); }
        return { table: table.name, rows: rows.map(row => Object.fromEntries(Object.entries(row).map(([column, value]) => [column, inspectValue(value)]))) };
      });
      const status = this.#breaker.status();
      return { ...this.#identity, databaseBytes: sql.databaseSize, quarantined: status.quarantined, reason: status.reason, tables, newest };
    });
  }
}

/** The stub of the object `objectId` names, in whichever of the account's namespaces issued it. */
export function budgetedObject(env: Env, objectId: string): DurableObjectStub<BudgetedDurableObject> | null {
  const namespaces: DurableObjectNamespace<BudgetedDurableObject>[] = [env.RELAY, env.CREDENTIALS, env.USER_STORAGE, env.SPACE_AUTHORITY, env.FLEET_CATALOG, env.USER_SETTINGS, env.PROJECT_SECRETS, env.PROJECT_AUTOMATIONS, env.SPACE_CONTEXT, env.USER_SKILLS, env.USER_PROJECTS, env.PROJECT_AUTHORITY, env.USER_MCP_CONNECTIONS, env.TENANT_RELEASES, env.HOSTED_ROUTES, env.ACCOUNT_STATE, env.GITHUB_APP, env.BROWSER_SESSION, env.STORAGE_MIGRATION];
  for (const namespace of namespaces) {
    try { return namespace.get(namespace.idFromString(objectId)); }
    catch { /* Another namespace's id. */ }
  }
  return null;
}

const PlatformStorageRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('status'), objectId: z.string() }),
  z.object({ action: z.literal('quarantine'), objectId: z.string(), reason: z.string().min(1).max(500), className: z.string().max(100) }),
  z.object({ action: z.literal('resume'), objectId: z.string() }),
  z.object({ action: z.literal('alert'), objectId: z.string(), reason: z.string().min(1).max(500), className: z.string().max(100) }),
  z.object({ action: z.literal('healthy'), objectId: z.string() }),
]);

/**
 * The platform's control of this account's Durable Objects (`POST /__platform/storage`, platform token): its usage
 * watchdog alerts on and quarantines objects by id, and reports an alerted object `healthy` once it is back under
 * every alert threshold. It answers without the account's own authority object, so a quarantined `AccountStateDO`
 * can still be resumed here.
 */
export async function platformStorageControl(request: Request, env: Env): Promise<Response> {
  const parsed = PlatformStorageRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: 'Invalid storage control request' }, { status: 400 });
  const input = parsed.data;
  const object = budgetedObject(env, input.objectId);
  if (!object) return Response.json({ error: 'No Durable Object of this account has that id' }, { status: 404 });
  const incident = (kind: StorageIncidentReport['kind'], reason: string, className: string) => env.ACCOUNT_STATE.getByName('account')
    .recordStorageIncident({ objectId: input.objectId, className, name: null, kind, reason, at: new Date().toISOString() })
    .catch((error: unknown) => console.error(JSON.stringify({ event: 'storage_incident_unrecorded', objectId: input.objectId, error: error instanceof Error ? error.message : String(error) })));
  switch (input.action) {
    case 'status': return Response.json(await object.storageBreakerStatus());
    case 'quarantine': {
      const status = await object.quarantineStorage(input.reason);
      await incident('quarantine', input.reason, input.className);
      return Response.json(status);
    }
    case 'alert': {
      await incident('alert', input.reason, input.className);
      return Response.json(await object.storageBreakerStatus());
    }
    case 'resume': {
      const status = await object.resumeStorage();
      await env.ACCOUNT_STATE.getByName('account').resolveStorageIncident(input.objectId, 'cleared').catch(() => {});
      return Response.json(status);
    }
    // A failure answers 500: the watchdog keeps the alert open and reports it healthy again on its next run.
    case 'healthy': {
      await env.ACCOUNT_STATE.getByName('account').resolveStorageIncident(input.objectId, 'healthy');
      return new Response(null, { status: 204 });
    }
  }
}

/** The account's storage incidents, and pausing, inspecting and resuming an object (account administration). */
export function storageIncidentProcedures(env: Env, requireAdministration: () => Promise<VerifiedDevice>) {
  const server = serverRpc.context<GitSpaceRpcContext>();
  const account = env.ACCOUNT_STATE.getByName('account');
  const list = server.implement(storageIncidentsListContract).handler(async ({ errors }) => {
    try { return ok(await account.listStorageIncidents()); }
    catch (error) { return err(errors.OperationFailed({ operation: 'read storage incidents', message: error instanceof Error ? error.message : String(error) })); }
  });
  const resume = server.implement(storageIncidentsResumeContract).handler(async ({ input, errors }) => {
    try {
      await requireAdministration();
      const object = budgetedObject(env, input.objectId);
      const resumed = object ? !(await object.resumeStorage()).quarantined : false;
      await account.resolveStorageIncident(input.objectId, 'cleared');
      return ok({ resumed });
    } catch (error) { return err(errors.OperationFailed({ operation: 'resume storage', message: error instanceof Error ? error.message : String(error) })); }
  });
  const pause = server.implement(storageIncidentsPauseContract).handler(async ({ input, errors }) => {
    try {
      await requireAdministration();
      const object = budgetedObject(env, input.objectId);
      if (!object) throw new Error('No Durable Object of this account has that id');
      return ok({ quarantined: (await object.pauseStorage(input.reason)).quarantined });
    } catch (error) { return err(errors.OperationFailed({ operation: 'pause storage', message: error instanceof Error ? error.message : String(error) })); }
  });
  const inspect = server.implement(storageIncidentsInspectContract).handler(async ({ input, errors }) => {
    try {
      await requireAdministration();
      const object = budgetedObject(env, input.objectId);
      if (!object) throw new Error('No Durable Object of this account has that id');
      return ok(await object.inspectStorage());
    } catch (error) { return err(errors.OperationFailed({ operation: 'inspect storage', message: error instanceof Error ? error.message : String(error) })); }
  });
  return { list, resume, pause, inspect };
}
