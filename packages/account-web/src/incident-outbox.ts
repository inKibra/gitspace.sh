import { AgentIncidentChangeSchema, agentIssueFailure, agentOperationIssue, type AgentIncidentChange } from '@gitspace/protocol-agent';
import { z } from 'zod';
import { currentDevice } from './device-session.js';
import { rpcClient } from './rpc-client.js';

const rowSchema = z.object({ eventId: z.string(), accountId: z.string(), projectId: z.string(), change: AgentIncidentChangeSchema, synced: z.boolean() });
type IncidentRow = z.infer<typeof rowSchema>;
let database: Promise<IDBDatabase> | undefined;
let flushing: Promise<void> | undefined;
let flushRequested = false;
function incidentDatabase(): Promise<IDBDatabase> {
  database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('gitspace-incidents', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('incidents', { keyPath: 'eventId' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { database = undefined; reject(request.error); };
  });
  return database;
}
async function save(row: IncidentRow): Promise<void> {
  const db = await incidentDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction('incidents', 'readwrite');
    transaction.objectStore('incidents').put(row);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error('Incident persistence aborted'));
  });
}
export async function localIncidentHistory(): Promise<IncidentRow[]> {
  const device = await currentDevice();
  if (!device) return [];
  const db = await incidentDatabase();
  const rows = await new Promise<unknown[]>((resolve, reject) => {
    const request = db.transaction('incidents', 'readonly').objectStore('incidents').getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return rows.map((row) => rowSchema.parse(row)).filter((row) => row.accountId === device.userId);
}
export async function persistIncident(projectId: string, change: AgentIncidentChange): Promise<string> {
  const device = await currentDevice();
  if (!device) throw new Error('Cannot attribute an incident without the enrolled account identity');
  const eventId = crypto.randomUUID();
  await save({ eventId, accountId: device.userId, projectId, change: AgentIncidentChangeSchema.parse(change), synced: false });
  void flushIncidentOutbox();
  return eventId;
}
/** Preserve actionable failure evidence before attempting network delivery. */
export async function recordActionIncident(input: { projectId: string; spaceId: string; sessionId: string | null; operation: string; operationId: string; error: unknown }): Promise<void> {
  const failure = agentIssueFailure(input.error, 'AGENT_DISCONNECTED', { operation: input.operation, transportOutcome: 'unknown' });
  try {
    await persistIncident(input.projectId, {
      type: 'occurred',
      incident: {
        id: crypto.randomUUID(), sessionId: input.sessionId, spaceId: input.spaceId,
        issue: agentOperationIssue(input.operation), operationId: input.operationId, revision: 1, occurredAt: new Date().toISOString(),
        failure,
      },
    });
  } catch (error) {
    throw new AggregateError([input.error, error], `${failure.message} Incident could not be saved locally: ${error instanceof Error ? error.message : String(error)}`);
  }
}
export function flushIncidentOutbox(): Promise<void> {
  flushRequested = true;
  flushing ??= (async () => {
    try {
      do {
      flushRequested = false;
      for (const row of await localIncidentHistory()) {
        if (row.synced) continue;
        const device = await currentDevice();
        if (device?.userId !== row.accountId) return;
        const result = await rpcClient.incidents.record({ projectId: row.projectId, eventId: row.eventId, change: row.change });
        if (result.status === 'error') return;
        // Acknowledgement is recorded, not deletion: recovery never erases history.
        await save({ ...row, synced: true });
      }
      } while (flushRequested);
    } catch { /* Retain the durable outbox; reconnect/online wakes the next attempt. */ }
  })().finally(() => { flushing = undefined; });
  return flushing;
}
