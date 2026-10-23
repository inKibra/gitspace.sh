import { DurableObject } from 'cloudflare:workers';
import { z } from 'zod';
import { installDurableObjectBreaker, type StorageBreaker, type StorageBreakerStatus } from '@gitspace/protocol/storage-breaker';
import type { GitSpaceRpcContext, VerifiedDevice } from '@gitspace/protocol';
import { storageIncidentsListContract, storageIncidentsResumeContract } from '@gitspace/protocol/rpc-contract';
import { err, ok } from 'result-rpc';
import { serverRpc } from 'result-rpc/server';

/** Something the account should know about one Durable Object's storage: it quarantined itself or was quarantined
 * (`quarantine`), or the platform saw it write past the alert threshold (`alert`). */
export const StorageIncidentSchema = z.object({
  objectId: z.string().regex(/^[0-9a-f]{64}$/u),
  className: z.string(),
  name: z.string().nullable(),
  kind: z.enum(['quarantine', 'alert']),
  reason: z.string(),
  at: z.string(),
});
export type StorageIncident = z.infer<typeof StorageIncidentSchema>;

/** Every Durable Object class of the account. The storage breaker is installed before the class touches its storage;
 * the object can be inspected, quarantined and resumed by its id. */
export abstract class BudgetedDurableObject extends DurableObject<Env> {
  readonly #breaker: StorageBreaker;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const object = { objectId: ctx.id.toString(), className: new.target.name, name: ctx.id.name ?? null };
    this.#breaker = installDurableObjectBreaker(ctx, {
      onTrip: status => {
        console.error(JSON.stringify({ event: 'storage_quarantined', ...object, ...status }));
        ctx.waitUntil(env.ACCOUNT_STATE.getByName('account').recordStorageIncident({ ...object, kind: 'quarantine', reason: status.reason ?? '', at: status.since ?? new Date().toISOString() })
          .catch((error: unknown) => console.error(JSON.stringify({ event: 'storage_incident_unrecorded', ...object, error: error instanceof Error ? error.message : String(error) }))));
      },
    });
  }

  storageBreakerStatus(): StorageBreakerStatus { return this.#breaker.status(); }
  quarantineStorage(reason: string): StorageBreakerStatus { return this.#breaker.quarantine(reason); }
  resumeStorage(): StorageBreakerStatus { return this.#breaker.resume(); }
}

/** The stub of the object `objectId` names, in whichever of the account's namespaces issued it. */
export function budgetedObject(env: Env, objectId: string): DurableObjectStub<BudgetedDurableObject> | null {
  const namespaces: DurableObjectNamespace<BudgetedDurableObject>[] = [env.RELAY, env.CREDENTIALS, env.USER_STORAGE, env.SPACE_AUTHORITY, env.FLEET_CATALOG, env.USER_SETTINGS, env.PROJECT_SECRETS, env.PROJECT_CRONS, env.SPACE_CONTEXT, env.USER_SKILLS, env.USER_PROJECTS, env.PROJECT_AUTHORITY, env.USER_MCP_CONNECTIONS, env.TENANT_RELEASES, env.HOSTED_ROUTES, env.ACCOUNT_STATE, env.GITHUB_APP, env.BROWSER_SESSION];
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
]);

/**
 * The platform's control of this account's Durable Objects (`POST /__platform/storage`, platform token): its usage
 * watchdog alerts on and quarantines objects by id. It answers without the account's own authority object, so a
 * quarantined `AccountStateDO` can still be resumed here.
 */
export async function platformStorageControl(request: Request, env: Env): Promise<Response> {
  const parsed = PlatformStorageRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: 'Invalid storage control request' }, { status: 400 });
  const input = parsed.data;
  const object = budgetedObject(env, input.objectId);
  if (!object) return Response.json({ error: 'No Durable Object of this account has that id' }, { status: 404 });
  const incident = (kind: StorageIncident['kind'], reason: string, className: string) => env.ACCOUNT_STATE.getByName('account')
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
      await env.ACCOUNT_STATE.getByName('account').clearStorageIncident(input.objectId).catch(() => {});
      return Response.json(status);
    }
  }
}

/** The account's storage incidents, and resuming a quarantined object (account administration). */
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
      await account.clearStorageIncident(input.objectId);
      return ok({ resumed });
    } catch (error) { return err(errors.OperationFailed({ operation: 'resume storage', message: error instanceof Error ? error.message : String(error) })); }
  });
  return { list, resume };
}
