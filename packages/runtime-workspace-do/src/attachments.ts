import { TaggedError } from 'better-result';
import { RuntimeAttachmentSchema, RuntimeToolDispatchSchema, RuntimeToolResultSchema, type RuntimeAttachInput, type RuntimeAttachment, type RuntimeAttachmentReadyInput, type RuntimeHeartbeatInput, type RuntimeToolDispatch, type RuntimeToolResult } from '@gitspace/protocol-runtime';
import { z } from 'zod';

/** Online = the machine holds a live relay connection; an offline machine is never dispatched to. */
export function isAttachmentOnline(attachment: RuntimeAttachment): boolean {
  return attachment.state !== 'detached' && attachment.online;
}
/** Ready = online, checkout exists and sync is running. Nothing else changes it. */
export function isAttachmentReady(attachment: RuntimeAttachment): boolean {
  return attachment.state === 'ready' && isAttachmentOnline(attachment);
}
export type GrantScope = Pick<RuntimeAttachment, 'projectId' | 'workspaceId' | 'attachmentId' | 'generation'>;
export type AttachmentServices = {
  seal(secret: string, scope: GrantScope): Promise<string>;
  open(ciphertext: string, scope: GrantScope): Promise<string>;
  /** POSTs the signed dispatch to the machine's `/runtime/execute`; the response body is the `RuntimeToolResult`. */
  dispatch(input: { machineId: RuntimeAttachment['machineId']; body: string; signature: string; signal: AbortSignal }): Promise<Response>;
};
/** The transport proved the request was never delivered: the machine has no relay connection. */
export class ExecutorNotConnected extends TaggedError('ExecutorNotConnected')<{ machineId: string; message: string }> {
  constructor(machineId: string) {
    super({ machineId, message: `Machine ${machineId} is not connected to the relay` });
  }
}
// The machine rejects with `{ error }`; the relay tunnel fails with `{ error: { code, message } }`.
/** How long a command's result is waited for after the machine's connection drops, and how often it is asked again. */
const RESULT_RECOVERY_MS = 120_000;
const RESULT_RETRY_MS = 2_000;
const TransportFailureSchema = z.object({ error: z.object({ code: z.literal('TUNNEL_TRANSPORT_FAILED') }) });
/** The relay lost the machine connection after it sent the command, so the reply never arrived. */
async function lostReply(response: Response): Promise<boolean> {
  return response.status === 502 && TransportFailureSchema.safeParse(await response.clone().json().catch(() => null)).success;
}
function delay(ms: number, signal: AbortSignal): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
  const abort = () => { clearTimeout(timer); reject(signal.reason); };
  signal.addEventListener('abort', abort, { once: true });
  return promise;
}
const RejectionSchema = z.object({ error: z.union([z.string(), z.object({ message: z.string() }).transform(error => error.message)]) });
const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
const isBrowserCapability = (capability: string) => capability === 'browser' || capability === 'browser_control' || capability.startsWith('browser.');
const failed = (dispatch: RuntimeToolDispatch, message: string): RuntimeToolResult => ({ requestId: dispatch.requestId, attemptId: dispatch.attemptId, status: 'failed', content: [{ type: 'text', text: message }], error: { code: 'machine_unavailable', message } });

export class AttachmentStore {
  private cached: { revision: number; records: RuntimeAttachment[] } | undefined;
  /** Commands running now, by attempt id. A restart interrupts them, so memory is the whole record. */
  private readonly running = new Map<string, RuntimeAttachment['machineId']>();
  constructor(private readonly storage: DurableObjectStorage, private readonly services: AttachmentServices) {
    storage.sql.exec('CREATE TABLE IF NOT EXISTS runtime_attachments(id TEXT PRIMARY KEY, record TEXT NOT NULL, secret TEXT NOT NULL)');
    // Runner and delegate attachments, leases, receipts and materialized results no longer exist. Retiring them scans
    // every attachment, so it runs once per object; the marker row records that it has.
    storage.sql.exec('CREATE TABLE IF NOT EXISTS runtime_attachments_retired(singleton INTEGER PRIMARY KEY CHECK(singleton=1))');
    if (!storage.sql.exec('SELECT 1 FROM runtime_attachments_retired WHERE singleton=1').toArray().length) {
      storage.sql.exec("DELETE FROM runtime_attachments WHERE json_extract(record,'$.role') IN ('runner','delegate')");
      storage.sql.exec("UPDATE runtime_attachments SET record=json_set(record,'$.state','detached') WHERE json_extract(record,'$.state') IN ('lost','draining')");
      storage.sql.exec("UPDATE runtime_attachments SET record=json_set(record,'$.cache.state','setup') WHERE json_extract(record,'$.cache.state') IN ('paused','reclaimed','draining')");
      storage.sql.exec("UPDATE runtime_attachments SET record=json_set(record,'$.failure',json('null')) WHERE json_extract(record,'$.failure.operation') IN ('reclaim','detach')");
      for (const table of ['runtime_attempts', 'runtime_executor_receipts', 'runtime_terminal_payloads', 'runtime_terminal_chunks', 'runtime_materialized_attempts', 'runtime_history_result_payloads', 'runtime_history_result_chunks', 'runtime_primary_flush', 'runtime_machine_kinds']) storage.sql.exec(`DROP TABLE IF EXISTS ${table}`);
      storage.sql.exec('INSERT INTO runtime_attachments_retired(singleton) VALUES(1)');
    }
    // Every write to runtime_attachments draws a fresh random revision, so a token match means the cached rows are current.
    storage.sql.exec('CREATE TABLE IF NOT EXISTS runtime_attachments_revision(singleton INTEGER PRIMARY KEY CHECK(singleton=1), token INTEGER NOT NULL)');
    storage.sql.exec('INSERT OR IGNORE INTO runtime_attachments_revision(singleton,token) VALUES(1,random() >> 11)');
    for (const event of ['INSERT', 'UPDATE', 'DELETE']) storage.sql.exec(`CREATE TRIGGER IF NOT EXISTS runtime_attachments_revision_${event.toLowerCase()} AFTER ${event} ON runtime_attachments BEGIN UPDATE runtime_attachments_revision SET token=random() >> 11 WHERE singleton=1; END`);
  }
  /** Whether a dispatched machine command is awaiting its result now. */
  dispatching(): boolean {
    return this.running.size > 0;
  }
  runningMachine(attemptId: string): RuntimeAttachment['machineId'] | null {
    return this.running.get(attemptId) ?? null;
  }
  /** Callers receive copies they may mutate. */
  list(): RuntimeAttachment[] {
    const revision = this.storage.sql.exec<{ token: number }>('SELECT token FROM runtime_attachments_revision WHERE singleton=1').one().token;
    if (this.cached?.revision !== revision) this.cached = { revision, records: this.storage.sql.exec<{ record: string }>('SELECT record FROM runtime_attachments').toArray().map(row => RuntimeAttachmentSchema.parse(JSON.parse(row.record))) };
    return structuredClone(this.cached.records);
  }
  private save(attachment: RuntimeAttachment): void {
    this.storage.sql.exec('UPDATE runtime_attachments SET record=? WHERE id=?', JSON.stringify(attachment), attachment.attachmentId);
  }
  private find(scope: GrantScope & Pick<RuntimeAttachment, 'machineId'>): RuntimeAttachment {
    const attachment = this.list().find(candidate => candidate.attachmentId === scope.attachmentId);
    if (!attachment || attachment.projectId !== scope.projectId || attachment.workspaceId !== scope.workspaceId || attachment.machineId !== scope.machineId || attachment.generation !== scope.generation) throw new Error(`Machine ${scope.machineId} is not attached to this workspace with attachment ${scope.attachmentId}; reattach the machine`);
    return attachment;
  }
  private async grant(attachment: RuntimeAttachment) {
    const row = this.storage.sql.exec<{ secret: string }>('SELECT secret FROM runtime_attachments WHERE id=?', attachment.attachmentId).toArray()[0];
    if (!row) throw new Error('Attachment grant missing');
    return { attachment, executionSecret: await this.services.open(row.secret, attachment) };
  }
  /** Attaching an already attached machine returns its current attachment. `online` is the machine's relay presence now. */
  async attach(input: RuntimeAttachInput, online: boolean) {
    const live = this.list().find(item => item.machineId === input.machineId && item.state !== 'detached');
    if (live) return this.grant(live);
    if (this.list().some(item => item.machineId === input.machineId && item.generation >= input.generation)) throw new Error('Attachment generation is stale');
    const now = new Date().toISOString();
    const attachment = RuntimeAttachmentSchema.parse({ ...input, attachmentId: crypto.randomUUID(), state: 'attaching', updatedAt: now, online, cache: { state: 'setup', platform: null, lastSyncAt: null, setup: [], unsent: null, syncProblem: null } });
    const executionSecret = encode(crypto.getRandomValues(new Uint8Array(32)));
    const ciphertext = await this.services.seal(executionSecret, attachment);
    this.storage.sql.exec('INSERT INTO runtime_attachments(id,record,secret) VALUES(?,?,?)', attachment.attachmentId, JSON.stringify(attachment), ciphertext);
    return { attachment, executionSecret };
  }
  async requestCache(input: Omit<RuntimeAttachInput, 'generation'>, online: boolean) {
    const generation = Math.max(-1, ...this.list().map(attachment => attachment.generation)) + 1;
    const { attachment } = await this.attach({ ...input, generation }, online);
    return { attachment };
  }
  async assignments(machineId: RuntimeAttachment['machineId'], capabilities?: readonly string[]) {
    const assignments = [];
    for (const attachment of this.list()) {
      if (attachment.machineId !== machineId || attachment.state === 'detached') continue;
      if (capabilities) {
        const next = [...capabilities.filter(capability => !isBrowserCapability(capability)), ...attachment.capabilities.filter(isBrowserCapability)];
        if (JSON.stringify(next) !== JSON.stringify(attachment.capabilities)) {
          attachment.capabilities = next;
          this.save(attachment);
        }
      }
      assignments.push({ grant: await this.grant(attachment) });
    }
    return assignments;
  }
  /** The machine's checkout exists and its sync is running. */
  ready(input: RuntimeAttachmentReadyInput) {
    const attachment = this.find(input);
    if (attachment.state === 'detached') throw new Error(`Machine ${input.machineId} was detached from this workspace; reattach it`);
    const now = new Date().toISOString();
    const next: RuntimeAttachment = { ...attachment, state: 'ready', failure: null, updatedAt: now, cache: { ...(attachment.cache ?? { platform: null, setup: [], unsent: null, syncProblem: null }), state: 'live', lastSyncAt: now }, ...(input.lfsRestored ? { lfsRestored: input.lfsRestored } : {}) };
    this.save(next);
    return { attachment: next };
  }
  /** A machine's observation report (`runtime.heartbeat`). It records what the machine sees; liveness is relay presence. */
  observe(input: RuntimeHeartbeatInput): RuntimeAttachment {
    const attachment = this.find(input);
    if (attachment.state === 'detached') throw new Error(`Machine ${input.machineId} was detached from this workspace; reattach it`);
    const now = Date.now();
    const observedAt = Date.parse(input.executionObservation.observedAt);
    // An out-of-order execution observation is dropped; the rest of the report still counts.
    const fresh = observedAt <= now + 5_000 && (!attachment.executionObservation || observedAt >= Date.parse(attachment.executionObservation.observedAt));
    const next: RuntimeAttachment = {
      ...attachment,
      ...(input.cache ? { cache: input.cache, state: input.cache.state === 'live' ? 'ready' : 'attaching' } : {}),
      ...(input.browserCapabilities ? { capabilities: [...attachment.capabilities.filter(capability => !isBrowserCapability(capability)), ...input.browserCapabilities] } : {}),
      executionObservation: fresh ? input.executionObservation : attachment.executionObservation,
      failure: input.failure === undefined ? attachment.failure : input.failure,
      updatedAt: new Date(now).toISOString(),
    };
    this.save(next);
    return next;
  }
  detach(input: GrantScope & Pick<RuntimeAttachment, 'machineId'>): RuntimeAttachment {
    const attachment = this.find(input);
    if (attachment.state === 'detached') return attachment;
    const next: RuntimeAttachment = { ...attachment, state: 'detached', updatedAt: new Date().toISOString() };
    this.save(next);
    return next;
  }
  /** Relay presence of a machine changed; true when an attachment's `online` moved. */
  presence(machineId: RuntimeAttachment['machineId'], online: boolean): boolean {
    const changed = this.list().filter(item => item.machineId === machineId && item.state !== 'detached' && item.online !== online);
    for (const item of changed) this.save({ ...item, online });
    return changed.length > 0;
  }
  /** A removed machine is detached from every workspace. */
  remove(machineId: RuntimeAttachment['machineId']): RuntimeAttachment[] {
    return this.list().filter(item => item.machineId === machineId && item.state !== 'detached').map(item => this.detach(item));
  }
  /** Runs the command on the machine and returns its result. A command whose machine stops answering is `interrupted`. */
  async execute(candidate: RuntimeToolDispatch, signal: AbortSignal): Promise<RuntimeToolResult> {
    const dispatch = RuntimeToolDispatchSchema.parse(candidate);
    const attachment = this.list().find(item => item.attachmentId === dispatch.attachmentId);
    if (!attachment || attachment.generation !== dispatch.generation || attachment.machineId !== dispatch.machineId || attachment.projectId !== dispatch.projectId || attachment.workspaceId !== dispatch.workspaceId || attachment.state === 'detached') return failed(dispatch, `Machine ${dispatch.machineId} is no longer attached to this workspace; attach it again or use another machine`);
    if (!isAttachmentOnline(attachment)) return failed(dispatch, `Machine ${dispatch.machineId} is offline; start GitSpace on it or attach another machine`);
    // Setup runs are what make a checkout ready, so they run while it is attaching too.
    if (attachment.state !== 'ready' && !(dispatch.tool === 'lifecycle' && attachment.state === 'attaching')) return failed(dispatch, `Machine ${dispatch.machineId} is still setting up this workspace's checkout; wait for it to become ready`);
    const { executionSecret } = await this.grant(attachment);
    const body = JSON.stringify(dispatch);
    const key = await crypto.subtle.importKey('raw', Uint8Array.from(atob(executionSecret.replaceAll('-', '+').replaceAll('_', '/')), character => character.charCodeAt(0)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const signature = encode(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body))));
    let response: Response;
    this.running.set(dispatch.attemptId, dispatch.machineId);
    try {
      // A dropped relay connection loses the reply, not the command: the machine keeps it running and answers the same
      // signed dispatch again with its result, so it is sent again while the machine reconnects.
      let lostAt: number | null = null;
      for (;;) {
        let answer: Response | null = null;
        try { answer = await this.services.dispatch({ machineId: dispatch.machineId, body, signature, signal }); }
        catch (error) {
          signal.throwIfAborted();
          if (lostAt === null && error instanceof ExecutorNotConnected) return failed(dispatch, `Machine ${dispatch.machineId} is not connected; start GitSpace on it or attach another machine`);
        }
        if (answer && !await lostReply(answer)) { response = answer; break; }
        lostAt ??= Date.now();
        if (Date.now() - lostAt > RESULT_RECOVERY_MS || Date.now() + RESULT_RETRY_MS >= Date.parse(dispatch.deadlineAt)) {
          return { requestId: dispatch.requestId, attemptId: dispatch.attemptId, status: 'interrupted', content: [{ type: 'text', text: `Machine ${dispatch.machineId} stopped responding while running this command; its outcome is unknown` }] };
        }
        await delay(RESULT_RETRY_MS, signal);
      }
    } finally { this.running.delete(dispatch.attemptId); }
    if (!response.ok) {
      const rejection = RejectionSchema.safeParse(await response.json().catch(() => null));
      return failed(dispatch, rejection.success ? rejection.data.error : `Machine ${dispatch.machineId} rejected the command (HTTP ${response.status})`);
    }
    const result = RuntimeToolResultSchema.parse(await response.json());
    if (result.requestId !== dispatch.requestId || result.attemptId !== dispatch.attemptId) throw new Error('Machine returned a result for a different command');
    return result;
  }
}
