import { DurableObject } from 'cloudflare:workers';
import { z } from 'zod';
import { installDurableObjectBreaker, type StorageBreaker, type StorageBreakerStatus } from '@gitspace/protocol/storage-breaker';

/** Every Durable Object class of the operator: the storage breaker is installed before the class touches its storage. */
export abstract class BudgetedDurableObject extends DurableObject<Env> {
  readonly #breaker: StorageBreaker;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const object = { objectId: ctx.id.toString(), className: new.target.name, name: ctx.id.name ?? null };
    this.#breaker = installDurableObjectBreaker(ctx, { onTrip: status => console.error(JSON.stringify({ event: 'storage_quarantined', ...object, ...status })) });
  }

  storageBreakerStatus(): StorageBreakerStatus { return this.#breaker.status(); }
  quarantineStorage(reason: string): StorageBreakerStatus { return this.#breaker.quarantine(reason); }
  resumeStorage(): StorageBreakerStatus { return this.#breaker.resume(); }
}

/** The stub of the operator object `objectId` names, in whichever of the operator's namespaces issued it. */
export function budgetedObject(env: Env, objectId: string): DurableObjectStub<BudgetedDurableObject> | null {
  const namespaces: DurableObjectNamespace<BudgetedDurableObject>[] = [env.INVITES, env.ACCOUNTS];
  for (const namespace of namespaces) {
    try { return namespace.get(namespace.idFromString(objectId)); }
    catch { /* Another namespace's id. */ }
  }
  return null;
}

export const OperatorStorageActionSchema = z.object({
  objectId: z.string().regex(/^[0-9a-f]{64}$/u),
  action: z.enum(['status', 'quarantine', 'resume']),
  reason: z.string().min(1).max(500).optional(),
});

/** Inspects, quarantines or resumes one of the operator's own objects. */
export async function operatorObjectStorage(env: Env, input: z.infer<typeof OperatorStorageActionSchema>): Promise<StorageBreakerStatus | null> {
  const object = budgetedObject(env, input.objectId);
  if (!object) return null;
  if (input.action === 'quarantine') return object.quarantineStorage(input.reason ?? 'Quarantined by the operator');
  if (input.action === 'resume') return object.resumeStorage();
  return object.storageBreakerStatus();
}
