import { sha256 } from '@noble/hashes/sha2.js';
import { TaggedError } from 'better-result';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { canonicalJson, dispatchIdentity, receiptDigest, verifyReceipt, RuntimeExecutorReceiptSchema, RuntimeReceiptTransportSchema, RuntimeAttachmentSchema, RuntimeToolDispatchSchema, RuntimeToolResultSchema, type RuntimeExecutorReceipt, type RuntimeReceiptTransport, type RuntimeAttachInput, type RuntimeAttachment, type RuntimeAttachmentLossReason, type RuntimeToolDispatch, type RuntimeToolResult } from '@gitspace/protocol-runtime';
import { RuntimeAttachmentSourceSchema, RuntimeExecutionObservationSchema } from '@gitspace/protocol-runtime';
import type { RuntimeAttachmentSource, RuntimeAttachmentRequestInput, RuntimeAttachmentReadyInput, RuntimeHeartbeatInput, RuntimeCacheActionInput } from '@gitspace/protocol-runtime';
/** A cloud sandbox costs money while held and is cheap to recreate; a paired computer is the user's own machine. */
export type AttachmentMachineKind = 'cloud' | 'computer';
type LeaseClass = 'progress' | 'draining' | 'heartbeat';
type Lease = { kind: LeaseClass | null; deadlineAt: string | null };
const MINUTE = 60_000;
/** Every live attachment is a lease the cloud can expire to `lost`. Setup and drain are renewed only by reported
 * progress, a ready or parked attachment by any heartbeat. A cloud sandbox's leases are short and heartbeat loss
 * alone releases it; a paired computer is patient and never expires for heartbeat loss. `null` never expires. */
export const ATTACHMENT_LEASE_MS: Record<AttachmentMachineKind, Record<LeaseClass, number | null>> = {
  cloud: { progress: 20 * MINUTE, draining: 10 * MINUTE, heartbeat: 5 * MINUTE },
  computer: { progress: 24 * 60 * MINUTE, draining: 24 * 60 * MINUTE, heartbeat: null },
};
/** A machine silent for longer than this is offline: never dispatched to and never listed. */
export const ATTACHMENT_ONLINE_MS = 30_000;
export function isAttachmentOnline(attachment: RuntimeAttachment, now: number): boolean {
  return attachment.state !== 'lost' && attachment.state !== 'detached' && attachment.heartbeatAt !== null && now - Date.parse(attachment.heartbeatAt) <= ATTACHMENT_ONLINE_MS;
}
function leaseClass(attachment: RuntimeAttachment): LeaseClass | null {
  if (attachment.state === 'draining') return 'draining';
  if (attachment.state === 'ready') return 'heartbeat';
  if (attachment.state !== 'attaching') return null;
  const setupPending = attachment.cacheAction?.action === 'setup' && ['requested', 'running'].includes(attachment.cacheAction.status);
  return !setupPending && (attachment.cache?.state === 'paused' || attachment.cache?.state === 'reclaimed') ? 'heartbeat' : 'progress';
}
const leaseOf = (attachment: RuntimeAttachment): Lease => ({ kind: leaseClass(attachment), deadlineAt: attachment.deadlineAt });
export type GrantScope = Pick<RuntimeAttachment, 'projectId' | 'workspaceId' | 'attachmentId' | 'generation'>;
export type AttachmentServices = {
  seal(secret: string, scope: GrantScope): Promise<string>;
  open(ciphertext: string, scope: GrantScope): Promise<string>;
  admitExecution?(machineId: RuntimeAttachment['machineId']): Promise<void>;
  dispatch(input: { machineId: RuntimeAttachment['machineId']; path: '/runtime/execute' | '/runtime/receipt'; body: string; signature: string; signal: AbortSignal }): Promise<RuntimeReceiptTransport>;
};
/** The transport proved the request was never delivered: the machine has no relay connection. */
export class ExecutorNotConnected extends TaggedError('ExecutorNotConnected')<{ machineId: string; message: string }> {
  constructor(machineId: string) {
    super({ machineId, message: `Machine ${machineId} is not connected to the relay` });
  }
}
const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
export class AttachmentStore {
  constructor(private readonly storage: DurableObjectStorage, private readonly services: AttachmentServices) {
    storage.sql.exec('CREATE TABLE IF NOT EXISTS runtime_attachments(id TEXT PRIMARY KEY, record TEXT NOT NULL, secret TEXT NOT NULL)');
    storage.sql.exec('CREATE TABLE IF NOT EXISTS runtime_attempts(id TEXT PRIMARY KEY, dispatch TEXT NOT NULL, status TEXT NOT NULL, result TEXT)');
    storage.sql.exec('CREATE TABLE IF NOT EXISTS runtime_executor_receipts(id TEXT PRIMARY KEY, envelope TEXT NOT NULL, acknowledged INTEGER NOT NULL DEFAULT 0)');
    storage.sql.exec('CREATE TABLE IF NOT EXISTS runtime_terminal_payloads(id TEXT NOT NULL,kind TEXT NOT NULL,parts INTEGER NOT NULL,units INTEGER NOT NULL,digest TEXT NOT NULL,PRIMARY KEY(id,kind))');
    storage.sql.exec('CREATE TABLE IF NOT EXISTS runtime_terminal_chunks(id TEXT NOT NULL,kind TEXT NOT NULL,part INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(id,kind,part))');
    storage.sql.exec('CREATE TABLE IF NOT EXISTS runtime_materialized_attempts(id TEXT PRIMARY KEY,result_digest TEXT NOT NULL,receipt TEXT NOT NULL,collected INTEGER NOT NULL DEFAULT 0)');
    storage.sql.exec('CREATE TABLE IF NOT EXISTS runtime_history_result_payloads(id TEXT NOT NULL,kind TEXT NOT NULL,parts INTEGER NOT NULL,units INTEGER NOT NULL,digest TEXT NOT NULL,PRIMARY KEY(id,kind))');
    storage.sql.exec('CREATE TABLE IF NOT EXISTS runtime_history_result_chunks(id TEXT NOT NULL,kind TEXT NOT NULL,part INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(id,kind,part))');
    storage.sql.exec('CREATE TABLE IF NOT EXISTS runtime_cloud_writer(singleton INTEGER PRIMARY KEY CHECK(singleton=1), fence INTEGER NOT NULL, attempt TEXT)');
    storage.sql.exec('INSERT OR IGNORE INTO runtime_cloud_writer(singleton,fence,attempt) VALUES(1,0,NULL)');
    // Retain this persisted table name: existing cache detach fences must survive upgrades.
    storage.sql.exec('CREATE TABLE IF NOT EXISTS runtime_primary_flush(attachment TEXT PRIMARY KEY, generation INTEGER NOT NULL)');
    const columns = storage.sql.exec<{ name: string }>('PRAGMA table_info(runtime_attachments)').toArray();
    if (!columns.some(column => column.name === 'request_id')) storage.sql.exec('ALTER TABLE runtime_attachments ADD COLUMN request_id TEXT');
    if (!columns.some(column => column.name === 'source')) storage.sql.exec('ALTER TABLE runtime_attachments ADD COLUMN source TEXT');
    storage.sql.exec('CREATE TABLE IF NOT EXISTS runtime_machine_kinds(machine_id TEXT PRIMARY KEY, kind TEXT NOT NULL)');
  }
  /** Unknown machines are treated as computers: patient leases never strand a user's own checkout. */
  machineKind(machineId: string): AttachmentMachineKind {
    return this.storage.sql.exec<{ kind: string }>('SELECT kind FROM runtime_machine_kinds WHERE machine_id=?', machineId).toArray()[0]?.kind === 'cloud' ? 'cloud' : 'computer';
  }
  /** A machine's kind decides its lease windows; a changed kind restarts its live leases under the new windows. */
  recordMachineKind(machineId: string, kind: AttachmentMachineKind): void {
    this.storage.transactionSync(() => {
      if (this.storage.sql.exec<{ kind: string }>('SELECT kind FROM runtime_machine_kinds WHERE machine_id=?', machineId).toArray()[0]?.kind === kind) return;
      this.storage.sql.exec('INSERT INTO runtime_machine_kinds(machine_id,kind) VALUES(?,?) ON CONFLICT(machine_id) DO UPDATE SET kind=excluded.kind', machineId, kind);
      const now = Date.now();
      for (const attachment of this.list()) if (attachment.machineId === machineId && attachment.state !== 'lost' && attachment.state !== 'detached') this.save({ ...attachment, deadlineAt: this.deadline(attachment, null, now) });
    });
  }
  private deadline(next: RuntimeAttachment, prior: Lease | null, now: number, renewal: { heartbeat?: boolean; progressAt?: number } = {}): string | null {
    const kind = leaseClass(next);
    const window = kind === null ? null : ATTACHMENT_LEASE_MS[this.machineKind(next.machineId)][kind];
    if (kind === null || window === null) return null;
    if (!prior || prior.kind !== kind || prior.deadlineAt === null) return new Date(now + window).toISOString();
    if (kind === 'heartbeat' && renewal.heartbeat) return new Date(now + window).toISOString();
    if (kind !== 'heartbeat' && renewal.progressAt !== undefined) return new Date(Math.max(Date.parse(prior.deadlineAt), Math.min(renewal.progressAt, now) + window)).toISOString();
    return prior.deadlineAt;
  }
  private save(attachment: RuntimeAttachment): void {
    this.storage.sql.exec('UPDATE runtime_attachments SET record=? WHERE id=?', JSON.stringify(attachment), attachment.attachmentId);
  }
  /** Live attachments whose lease expired at `now`. Rows stored before leases existed start theirs from their last record. */
  overdue(now: number): RuntimeAttachment[] {
    return this.storage.transactionSync(() => this.list().filter(attachment => {
      if (attachment.state === 'lost' || attachment.state === 'detached') return false;
      if (attachment.deadlineAt === null) {
        const basis = leaseClass(attachment) === 'heartbeat' ? attachment.heartbeatAt ?? attachment.updatedAt : attachment.updatedAt;
        const deadlineAt = this.deadline(attachment, null, Date.parse(basis));
        if (deadlineAt === null) return false;
        this.save({ ...attachment, deadlineAt });
        return Date.parse(deadlineAt) <= now;
      }
      return Date.parse(attachment.deadlineAt) <= now;
    }));
  }
  nextDeadline(): number | null {
    const deadlines = this.list().flatMap(attachment => attachment.state !== 'lost' && attachment.state !== 'detached' && attachment.deadlineAt !== null ? [Date.parse(attachment.deadlineAt)] : []);
    return deadlines.length ? Math.min(...deadlines) : null;
  }
  /** Terminal and releasing: the attachment's fences open, its unresolved attempts end interrupted and a pending cache
   * action fails. Idempotent; a detached attachment stays detached. With `expiredAt`, an attachment whose lease was
   * renewed past that instant is left live. */
  lose(attachmentId: string, generation: number, reason: RuntimeAttachmentLossReason, options: { failure?: RuntimeAttachment['failure']; expiredAt?: number } = {}): RuntimeAttachment {
    return this.storage.transactionSync(() => {
      const attachment = this.list().find(item => item.attachmentId === attachmentId);
      if (!attachment || attachment.generation !== generation) throw new Error('Stale attachment generation');
      if (attachment.state === 'lost' || attachment.state === 'detached') return attachment;
      if (options.expiredAt !== undefined && (attachment.deadlineAt === null || Date.parse(attachment.deadlineAt) > options.expiredAt)) return attachment;
      const message = `Machine ${attachment.machineId} lost this attachment (${reason}); the outcome of this execution is unknown`;
      for (const row of this.storage.sql.exec<{ dispatch: string }>("SELECT dispatch FROM runtime_attempts WHERE status='dispatched'").toArray()) {
        const dispatch = RuntimeToolDispatchSchema.parse(JSON.parse(row.dispatch));
        if (dispatch.attachmentId === attachmentId) this.settle(dispatch, { requestId: dispatch.requestId, attemptId: dispatch.attemptId, status: 'interrupted', content: [{ type: 'text', text: message }] });
      }
      const pendingAction = attachment.cacheAction && ['requested', 'running'].includes(attachment.cacheAction.status);
      const next: RuntimeAttachment = { ...attachment, state: 'lost', lossReason: reason, deadlineAt: null, failure: options.failure ?? attachment.failure, updatedAt: new Date(Date.now()).toISOString(), ...(pendingAction && attachment.cacheAction ? { cacheAction: { ...attachment.cacheAction, status: 'failed', error: message } } : {}) };
      delete next.detachRequest;
      this.storage.sql.exec('DELETE FROM runtime_primary_flush WHERE attachment=?', attachmentId);
      this.save(next);
      return next;
    });
  }
  /** The interrupted result recorded when the attempt's attachment was lost; the machine never receipted it. */
  lossResult(attemptId: string): RuntimeToolResult | null {
    if (this.storage.sql.exec('SELECT id FROM runtime_executor_receipts WHERE id=?', attemptId).toArray().length) return null;
    const attempt = this.getAttempt(attemptId);
    return attempt?.status === 'interrupted' ? attempt.result : null;
  }
  private putTerminalPayload(id: string, kind: 'result' | 'envelope', payload: string, store: 'terminal' | 'history_result' = 'terminal'): void {
    // Called only within the transaction that publishes the terminal status.
    // Match replica storage's bounded, surrogate-safe TEXT chunks.
    let parts = 0;
    for (let offset = 0; offset < payload.length;) {
      let end = Math.min(payload.length, offset + 16_384);
      const last = payload.charCodeAt(end - 1);
      if (end < payload.length && last >= 0xd800 && last <= 0xdbff) end--;
      this.storage.sql.exec(`INSERT INTO runtime_${store}_chunks(id,kind,part,payload) VALUES(?,?,?,?)`, id, kind, parts++, payload.slice(offset, end));
      offset = end;
    }
    this.storage.sql.exec(`INSERT INTO runtime_${store}_payloads(id,kind,parts,units,digest) VALUES(?,?,?,?,?)`, id, kind, parts, payload.length, bytesToHex(sha256(utf8ToBytes(payload))));
  }
  private terminalPayload(id: string, kind: 'result' | 'envelope', inline: string, store: 'terminal' | 'history_result' = 'terminal'): string {
    // Legacy valid rows remain readable without an eager, unbounded migration.
    // New rows use a non-payload marker so missing metadata cannot look pending.
    if (inline !== 'null') return inline;
    const metadata = this.storage.sql.exec<{ parts: number; units: number; digest: string }>(`SELECT parts,units,digest FROM runtime_${store}_payloads WHERE id=? AND kind=?`, id, kind).toArray()[0];
    if (!metadata || !Number.isSafeInteger(metadata.parts) || metadata.parts < 1 || !Number.isSafeInteger(metadata.units) || metadata.units < 1 || !/^[a-f0-9]{64}$/.test(metadata.digest)) throw new Error('Terminal payload metadata is missing or invalid');
    const chunks: string[] = [];
    const digest = sha256.create();
    let units = 0;
    for (const row of this.storage.sql.exec<{ part: number; payload: string }>(`SELECT part,payload FROM runtime_${store}_chunks WHERE id=? AND kind=? ORDER BY part`, id, kind)) {
      if (row.part !== chunks.length || chunks.length >= metadata.parts || !row.payload.length || row.payload.length > 16_384) throw new Error('Terminal payload chunk order or count is invalid');
      chunks.push(row.payload);
      units += row.payload.length;
      digest.update(utf8ToBytes(row.payload));
    }
    if (chunks.length !== metadata.parts || units !== metadata.units || bytesToHex(digest.digest()) !== metadata.digest) throw new Error('Terminal payload integrity check failed');
    return chunks.join('');
  }
  list(): RuntimeAttachment[] { return this.storage.sql.exec<{ record: string }>('SELECT record FROM runtime_attachments').toArray().map(row => RuntimeAttachmentSchema.parse(JSON.parse(row.record))); }
  getAttempt(attemptId: string): { dispatch: RuntimeToolDispatch; status: string; result: RuntimeToolResult | null } | null {
    const row = this.storage.sql.exec<{ dispatch: string; status: string; result: string | null }>('SELECT dispatch,status,result FROM runtime_attempts WHERE id=?', attemptId).toArray()[0];
    return row ? { dispatch: RuntimeToolDispatchSchema.parse(JSON.parse(row.dispatch)), status: row.status, result: this.isCollected(attemptId) ? this.materializedResult(attemptId) : row.result === null ? null : RuntimeToolResultSchema.parse(JSON.parse(this.terminalPayload(attemptId, 'result', row.result))) } : null;
  }
  private isCollected(id: string): boolean {
    return this.storage.sql.exec<{ collected: number }>('SELECT collected FROM runtime_materialized_attempts WHERE id=?', id).toArray()[0]?.collected === 1;
  }
  hasMaterialized(id: string): boolean {
    return this.storage.sql.exec('SELECT id FROM runtime_materialized_attempts WHERE id=?', id).toArray().length > 0;
  }
  materializedResult(id: string): RuntimeToolResult {
    const row = this.storage.sql.exec<{ result_digest: string }>('SELECT result_digest FROM runtime_materialized_attempts WHERE id=?', id).toArray()[0];
    if (!row) throw new Error('Result has not been durably materialized');
    const result = RuntimeToolResultSchema.parse(JSON.parse(this.terminalPayload(id, 'result', 'null', 'history_result')));
    if (bytesToHex(sha256(utf8ToBytes(canonicalJson(result)))) !== row.result_digest || result.attemptId !== id) throw new Error('Materialized result integrity check failed');
    return result;
  }
  historyResult(reference: { attemptId: string; sha256: string }, conversationId: string): RuntimeToolResult | undefined {
    const attempt = this.getAttempt(reference.attemptId);
    if (!attempt?.result || attempt.dispatch.conversationId !== conversationId) return;
    if (bytesToHex(sha256(utf8ToBytes(canonicalJson(attempt.result)))) !== reference.sha256) throw new Error('History result reference integrity check failed');
    return attempt.result;
  }
  materializedReference(reference: { attemptId: string; sha256: string }, conversationId: string): void {
    const saved = this.storage.sql.exec<{ result_digest: string }>('SELECT result_digest FROM runtime_materialized_attempts WHERE id=?', reference.attemptId).toArray()[0];
    if (saved) { if (saved.result_digest !== reference.sha256) throw new Error('History reference changed'); return; }
    const attempt = this.getAttempt(reference.attemptId);
    if (!attempt?.result || attempt.dispatch.conversationId !== conversationId) return;
    if (bytesToHex(sha256(utf8ToBytes(canonicalJson(attempt.result)))) !== reference.sha256) throw new Error('History reference does not match executor result');
    this.materialized(attempt.result);
  }
  pendingMaterialization(): RuntimeToolDispatch[] {
    return this.storage.sql.exec<{ dispatch: string }>('SELECT a.dispatch FROM runtime_attempts a JOIN runtime_executor_receipts r ON r.id=a.id LEFT JOIN runtime_materialized_attempts m ON m.id=a.id WHERE m.id IS NULL').toArray().map(row => RuntimeToolDispatchSchema.parse(JSON.parse(row.dispatch)));
  }
  /** Caller must supply the exact result recovered from a committed task/history transaction. */
  materialized(result: RuntimeToolResult): void {
    const digest = bytesToHex(sha256(utf8ToBytes(canonicalJson(result))));
    this.storage.transactionSync(() => {
      const prior = this.storage.sql.exec<{ result_digest: string }>('SELECT result_digest FROM runtime_materialized_attempts WHERE id=?', result.attemptId).toArray()[0];
      if (prior) { if (prior.result_digest !== digest) throw new Error('Materialized result changed'); return; }
      const attempt = this.getAttempt(result.attemptId);
      if (!attempt?.result || canonicalJson(attempt.result) !== canonicalJson(result)) throw new Error('Materialization does not match executor result');
      const saved = this.storage.sql.exec<{ envelope: string }>('SELECT envelope FROM runtime_executor_receipts WHERE id=?', result.attemptId).toArray()[0];
      if (!saved) throw new Error('Materialization requires a durable terminal receipt');
      const envelope = RuntimeReceiptTransportSchema.parse(JSON.parse(this.terminalPayload(result.attemptId, 'envelope', saved.envelope)));
      if (envelope.receipt.state !== 'terminal') throw new Error('Materialization requires a terminal receipt');
      const { result: _result, ...receipt } = envelope.receipt;
      // One chunked history-owned result replaces the result plus encrypted envelope
      // copies. The bounded receipt tombstone preserves terminal replay evidence.
      if (this.storage.sql.exec("SELECT id FROM runtime_terminal_payloads WHERE id=? AND kind='result'", result.attemptId).toArray().length) {
        this.storage.sql.exec("INSERT INTO runtime_history_result_payloads SELECT * FROM runtime_terminal_payloads WHERE id=? AND kind='result'", result.attemptId);
        this.storage.sql.exec("INSERT INTO runtime_history_result_chunks SELECT * FROM runtime_terminal_chunks WHERE id=? AND kind='result'", result.attemptId);
      } else {
        this.putTerminalPayload(result.attemptId, 'result', JSON.stringify(result), 'history_result');
      }
      this.storage.sql.exec('INSERT INTO runtime_materialized_attempts(id,result_digest,receipt) VALUES(?,?,?)', result.attemptId, digest, JSON.stringify(receipt));
    });
  }
  async collectMaterialized(): Promise<boolean> {
    const rows = this.storage.sql.exec<{ id: string }>('SELECT id FROM runtime_materialized_attempts WHERE collected=0 LIMIT 32').toArray();
    for (const row of rows) {
      const receipt = this.storage.sql.exec<{ acknowledged: number }>('SELECT acknowledged FROM runtime_executor_receipts WHERE id=?', row.id).toArray()[0];
      if (!receipt) throw new Error('Materialized attempt lost its receipt');
      if (!receipt.acknowledged) {
        const attempt = this.getAttempt(row.id);
        if (!attempt) throw new Error('Materialized attempt lost its dispatch');
        await this.reconcile(attempt.dispatch);
      }
      this.storage.transactionSync(() => {
        if (!this.storage.sql.exec<{ acknowledged: number }>('SELECT acknowledged FROM runtime_executor_receipts WHERE id=?', row.id).toArray()[0]?.acknowledged) return;
        this.storage.sql.exec('UPDATE runtime_materialized_attempts SET collected=1 WHERE id=?', row.id);
        this.storage.sql.exec('DELETE FROM runtime_terminal_chunks WHERE id=?', row.id);
        this.storage.sql.exec('DELETE FROM runtime_terminal_payloads WHERE id=?', row.id);
        this.storage.sql.exec('DELETE FROM runtime_executor_receipts WHERE id=?', row.id);
        this.storage.sql.exec('UPDATE runtime_attempts SET result=NULL WHERE id=?', row.id);
      });
    }
    await this.storage.sync();
    return this.storage.sql.exec('SELECT id FROM runtime_materialized_attempts WHERE collected=0 LIMIT 1').toArray().length > 0;
  }
  private collectedReceipt(id: string): RuntimeExecutorReceipt | null {
    const row = this.storage.sql.exec<{ receipt: string }>('SELECT receipt FROM runtime_materialized_attempts WHERE id=? AND collected=1', id).toArray()[0];
    return row ? RuntimeExecutorReceiptSchema.parse({ ...JSON.parse(row.receipt), result: this.materializedResult(id) }) : null;
  }
  async attach(input: RuntimeAttachInput, assignment?: { requestId: string; source: RuntimeAttachmentSource | null }) {
    if (input.role === 'runner' && input.checkout.kind !== 'snapshot') throw new Error('Runner requires an exact snapshot');
    if (input.role === 'delegate' && input.checkout.kind !== 'branch') throw new Error('Delegate requires a private branch');
    if (input.role === 'cache' && input.checkout.kind !== 'shared') throw new Error('Canonical cache requires the standard shared checkout');
    const admittedAt = Date.now();
    const now = new Date(admittedAt).toISOString();
    const candidate = RuntimeAttachmentSchema.parse({ ...input, attachmentId: crypto.randomUUID(), state: 'attaching', updatedAt: now, heartbeatAt: null, ...(input.role === 'cache' ? { cache: { state: 'setup', platform: null, activity: [], lastActivityAt: now, pausedAt: null, reclaimAt: null, lastSyncAt: null, localWorkOptIn: false, setup: [] } } : {}) });
    candidate.deadlineAt = this.deadline(candidate, null, admittedAt);
    const candidateSecret = encode(crypto.getRandomValues(new Uint8Array(32)));
    const ciphertext = await this.services.seal(candidateSecret, candidate);
    const attachment = this.storage.transactionSync(() => {
      const current = this.list();
      const existing = current.find(a => a.machineId === input.machineId && a.generation === input.generation && a.state !== 'detached' && a.state !== 'lost');
      if (existing) {
        const nonBrowser = (capabilities: string[]) => capabilities.filter(capability => capability !== 'browser' && capability !== 'browser_control' && !capability.startsWith('browser.'));
        if (existing.projectId !== input.projectId || existing.workspaceId !== input.workspaceId || existing.role !== input.role || existing.ownershipGeneration !== input.ownershipGeneration || JSON.stringify(existing.checkout) !== JSON.stringify(input.checkout) || JSON.stringify(nonBrowser(existing.capabilities)) !== JSON.stringify(nonBrowser(input.capabilities))) throw new Error('Attachment retry changed admission');
        if (assignment) {
          const saved = this.storage.sql.exec<{ request_id: string | null; source: string | null }>('SELECT request_id,source FROM runtime_attachments WHERE id=?', existing.attachmentId).toArray()[0];
          if (saved?.request_id !== assignment.requestId || saved.source !== JSON.stringify(assignment.source)) throw new Error('Attachment request identity changed');
        }
        existing.capabilities = input.capabilities;
        this.storage.sql.exec('UPDATE runtime_attachments SET record=? WHERE id=?', JSON.stringify(existing), existing.attachmentId);
        return existing;
      }
      if (current.some(a => a.machineId === input.machineId && a.generation >= input.generation)) throw new Error('Attachment generation is stale');
      if (input.role === 'cache' && current.some(a => a.machineId === input.machineId && a.role === 'cache' && a.state !== 'detached' && a.state !== 'lost')) throw new Error('Previous attachment of this shared checkout must complete its fencing barrier');
      this.storage.sql.exec('INSERT INTO runtime_attachments(id,record,secret,request_id,source) VALUES(?,?,?,?,?)', candidate.attachmentId, JSON.stringify(candidate), ciphertext, assignment?.requestId ?? null, assignment ? JSON.stringify(assignment.source) : null);
      return candidate;
    });
    if (attachment.attachmentId === candidate.attachmentId) return { attachment, executionSecret: candidateSecret };
    const row = this.storage.sql.exec<{ secret: string }>('SELECT secret FROM runtime_attachments WHERE id=?', attachment.attachmentId).toArray()[0];
    if (!row) throw new Error('Attachment grant missing');
    return { attachment, executionSecret: await this.services.open(row.secret, attachment) };
  }

  async request(input: RuntimeAttachmentRequestInput, source: RuntimeAttachmentSource, capabilities: string[]) {
    const prior = this.storage.sql.exec<{ record: string; source: string }>('SELECT record,source FROM runtime_attachments WHERE request_id=?', input.requestId).toArray()[0];
    if (prior) {
      const attachment = RuntimeAttachmentSchema.parse(JSON.parse(prior.record));
      const saved = RuntimeAttachmentSourceSchema.parse(JSON.parse(prior.source));
      if (attachment.role !== (input.checkout.kind === 'snapshot' ? 'runner' : 'delegate') || attachment.machineId !== input.machineId || attachment.projectId !== input.projectId || attachment.workspaceId !== input.workspaceId || JSON.stringify(attachment.checkout) !== JSON.stringify(input.checkout) || JSON.stringify(saved) !== JSON.stringify(source)) throw new Error('Attachment request identity changed');
      return { attachment };
    }
    const generation = Math.max(-1, ...this.list().filter(attachment => attachment.machineId === input.machineId).map(attachment => attachment.generation)) + 1;
    const { attachment } = await this.attach({ projectId: input.projectId, workspaceId: input.workspaceId, machineId: input.machineId, generation,
      role: input.checkout.kind === 'snapshot' ? 'runner' : 'delegate', checkout: input.checkout, capabilities,
    }, { requestId: input.requestId, source });
    return { attachment };
  }

  async requestCache(input: Omit<RuntimeAttachInput, 'generation' | 'role'> & { requestId: string }) {
    const prior = this.storage.sql.exec<{ record: string }>('SELECT record FROM runtime_attachments WHERE request_id=?', input.requestId).toArray()[0];
    if (prior) {
      const attachment = RuntimeAttachmentSchema.parse(JSON.parse(prior.record));
      if (attachment.role !== 'cache' || attachment.machineId !== input.machineId || attachment.projectId !== input.projectId || attachment.workspaceId !== input.workspaceId || JSON.stringify(attachment.checkout) !== JSON.stringify(input.checkout)) throw new Error('Attachment request identity changed');
      return { attachment };
    }
    const existing = this.list().find(item => item.machineId === input.machineId && item.role === 'cache' && item.state !== 'detached' && item.state !== 'lost');
    if (existing?.cache?.state === 'reclaimed' || existing?.cache?.state === 'paused') return this.requestCacheAction({ ...existing, requestId: input.requestId, action: { kind: 'setup' } });
    const generation = Math.max(-1, ...this.list().map(attachment => attachment.generation)) + 1;
    const { attachment } = await this.attach({ ...input, generation, role: 'cache' }, { requestId: input.requestId, source: null });
    return { attachment };
  }

  requestCacheAction(input: RuntimeCacheActionInput) {
    const attachment = this.list().find(item => item.attachmentId === input.attachmentId);
    if (!attachment || attachment.role !== 'cache' || !attachment.cache || attachment.projectId !== input.projectId || attachment.workspaceId !== input.workspaceId || attachment.machineId !== input.machineId || attachment.generation !== input.generation || attachment.state === 'detached' || attachment.state === 'lost') throw new Error('Cache action has stale authority');
    const prior = leaseOf(attachment);
    if (input.action.kind === 'local-work') {
      attachment.cache.localWorkOptIn = input.action.enabled;
    } else {
      if (attachment.cacheAction?.requestId === input.requestId) {
        if (attachment.cacheAction.action !== input.action.kind || (attachment.cacheAction.discardHeldBack === true) !== (input.action.kind === 'reclaim' && input.action.discardHeldBack === true)) throw new Error('Cache action request identity changed');
        return { attachment };
      }
      if (attachment.cacheAction && ['requested', 'running'].includes(attachment.cacheAction.status)) throw new Error('Cache action is already pending');
      if (attachment.detachRequest) throw new Error('Cache detach must finish before another cache action');
      if (input.action.kind === 'setup' && attachment.state === 'draining') throw new Error('Cache drain must finish before setup');
      if (input.action.kind === 'setup' && this.storage.sql.exec<{ dispatch: string }>("SELECT dispatch FROM runtime_attempts WHERE status='dispatched'").toArray().some(row => RuntimeToolDispatchSchema.parse(JSON.parse(row.dispatch)).attachmentId === attachment.attachmentId)) throw new Error('Unresolved execution prevents cache setup');
      attachment.cacheAction = { requestId: input.requestId, action: input.action.kind, status: 'requested', error: null, ...(input.action.kind === 'reclaim' && input.action.discardHeldBack === true ? { discardHeldBack: true } : {}) };
      attachment.state = input.action.kind === 'reclaim' ? 'draining' : 'attaching';
      attachment.cache.state = input.action.kind === 'reclaim' ? 'draining' : 'setup';
      attachment.cache.reclaimBlocked = null;
      if (input.action.kind === 'reclaim') this.storage.sql.exec('DELETE FROM runtime_primary_flush WHERE attachment=? AND generation=?', attachment.attachmentId, attachment.generation);
    }
    const now = Date.now();
    attachment.updatedAt = new Date(now).toISOString();
    attachment.deadlineAt = this.deadline(attachment, prior, now);
    this.save(attachment);
    return { attachment };
  }

  async assignments(machineId: RuntimeAttachment['machineId'], cacheCapabilities?: readonly string[]) {
    const records = this.storage.sql.exec<{ record: string; source: string | null; secret: string }>('SELECT record,source,secret FROM runtime_attachments').toArray();
    const assignments = [];
    for (const row of records) {
      const attachment = RuntimeAttachmentSchema.parse(JSON.parse(row.record));
      if (attachment.machineId !== machineId || attachment.state === 'detached') continue;
      if (attachment.role === 'cache' && cacheCapabilities && ['attaching', 'ready'].includes(attachment.state)) {
        const browserCapability = (capability: string) => capability === 'browser' || capability === 'browser_control' || capability.startsWith('browser.');
        const capabilities = [...cacheCapabilities.filter(capability => !browserCapability(capability)), ...attachment.capabilities.filter(browserCapability)];
        if (JSON.stringify(capabilities) !== JSON.stringify(attachment.capabilities)) {
          attachment.capabilities = capabilities;
          this.storage.sql.exec('UPDATE runtime_attachments SET record=? WHERE id=?', JSON.stringify(attachment), attachment.attachmentId);
        }
      }
      const grant = { attachment, executionSecret: await this.services.open(row.secret, attachment) };
      assignments.push({ grant, source: row.source && row.source !== 'null' ? RuntimeAttachmentSourceSchema.parse(JSON.parse(row.source)) : null });
    }
    return assignments;
  }

  ready(input: RuntimeAttachmentReadyInput, canonicalCommit?: string) {
    const attachment = this.list().find(candidate => candidate.attachmentId === input.attachmentId);
    const expected = attachment?.checkout.kind === 'shared' ? attachment.role === 'cache' ? canonicalCommit : undefined : attachment?.checkout.commit;
    if (!attachment || attachment.machineId !== input.machineId || attachment.projectId !== input.projectId || attachment.workspaceId !== input.workspaceId || attachment.generation !== input.generation || expected === undefined || expected !== input.commit || !input.prerequisitesComplete) throw new Error('Attachment readiness proof does not match its admission');
    if (!attachment.capabilities.every(capability => input.capabilities.includes(capability))) throw new Error('Executor lacks assigned capabilities');
    if (attachment.state === 'ready') {
      if (canonicalJson(attachment.lfsRestored ?? []) !== canonicalJson(input.lfsRestored ?? [])) throw new Error('Attachment readiness LFS proof changed');
      return { attachment };
    }
    return this.storage.transactionSync(() => {
      const ready = this.transition(attachment.attachmentId, attachment.generation, 'ready');
      this.storage.sql.exec('DELETE FROM runtime_primary_flush WHERE attachment=? AND generation=?', attachment.attachmentId, attachment.generation);
      const next = { ...ready, heartbeatAt: new Date(Date.now()).toISOString(), ...(ready.cache ? { cache: { ...ready.cache, state: 'live' as const, pausedAt: null, reclaimAt: null, lastSyncAt: new Date().toISOString() } } : {}), ...(input.lfsRestored ? { lfsRestored: input.lfsRestored } : {}) };
      this.storage.sql.exec('UPDATE runtime_attachments SET record=? WHERE id=?', JSON.stringify(next), attachment.attachmentId);
      return { attachment: next };
    });
  }

  heartbeat(lease: RuntimeHeartbeatInput): RuntimeAttachment {
    const attachment = this.list().find(candidate => candidate.attachmentId === lease.attachmentId);
    if (!attachment || attachment.projectId !== lease.projectId || attachment.workspaceId !== lease.workspaceId || attachment.machineId !== lease.machineId || attachment.generation !== lease.generation || !['attaching', 'ready', 'draining'].includes(attachment.state)) throw new Error('Attachment heartbeat has stale authority');
    const prior = leaseOf(attachment);
    const now = Date.now();
    const observation = RuntimeExecutionObservationSchema.parse(lease.executionObservation);
    const observedAt = Date.parse(observation.observedAt);
    if (observedAt > Date.now() + 5_000 || (attachment.executionObservation && observedAt < Date.parse(attachment.executionObservation.observedAt))) throw new Error('Execution observation clock is invalid or stale');
    if (lease.cache && (attachment.role !== 'cache' || !attachment.cache)) throw new Error('Only canonical caches report cache observations');
    if (lease.cache?.state === 'reclaimed') {
      if (!this.storage.sql.exec('SELECT attachment FROM runtime_primary_flush WHERE attachment=? AND generation=?', attachment.attachmentId, attachment.generation).toArray().length) throw new Error('Final snapshot publication prevents reclamation');
      if (this.storage.sql.exec<{ dispatch: string }>("SELECT dispatch FROM runtime_attempts WHERE status='dispatched'").toArray().some(row => RuntimeToolDispatchSchema.parse(JSON.parse(row.dispatch)).attachmentId === attachment.attachmentId)) throw new Error('Unresolved execution prevents reclamation');
    }
    if (lease.cacheAction) {
      if (!attachment.cacheAction || attachment.cacheAction.requestId !== lease.cacheAction.requestId) throw new Error('Cache action receipt has stale authority');
      if (['completed', 'failed'].includes(attachment.cacheAction.status) && (attachment.cacheAction.status !== lease.cacheAction.status || attachment.cacheAction.error !== lease.cacheAction.error)) throw new Error('Cache action terminal receipt changed');
      if (lease.cacheAction.status === 'completed' && attachment.cacheAction.status !== 'completed' && (attachment.cacheAction.action === 'reclaim' ? lease.cache?.state !== 'reclaimed' : attachment.state !== 'ready')) throw new Error('Cache action effect is not complete');
      attachment.cacheAction = { ...attachment.cacheAction, ...lease.cacheAction };
    }
    if (attachment.state === 'ready' && (!attachment.heartbeatAt || now - Date.parse(attachment.heartbeatAt) > ATTACHMENT_ONLINE_MS)) attachment.state = 'attaching';
    if (lease.cache) {
      if (lease.cache.state === 'draining' && attachment.cache?.state !== 'draining') this.storage.sql.exec('DELETE FROM runtime_primary_flush WHERE attachment=? AND generation=?', attachment.attachmentId, attachment.generation);
      attachment.cache = { ...lease.cache, localWorkOptIn: attachment.cache?.localWorkOptIn ?? false };
      if (lease.cache.state === 'draining') attachment.state = 'draining';
      else if (!attachment.detachRequest && (lease.cache.state === 'reclaimed' || lease.cache.state === 'paused' || lease.cache.state === 'setup')) attachment.state = 'attaching';
    }
    const next: RuntimeAttachment = { ...attachment, ...(lease.browserCapabilities ? { capabilities: [...attachment.capabilities.filter(capability => capability !== 'browser' && capability !== 'browser_control' && !capability.startsWith('browser.')), ...lease.browserCapabilities] } : {}), executionObservation: observation, failure: lease.failure === undefined ? attachment.failure : lease.failure, heartbeatAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString() };
    next.deadlineAt = this.deadline(next, prior, now, { heartbeat: true, ...(lease.progress ? { progressAt: Date.parse(lease.progress.at) } : {}) });
    this.save(next);
    return next;
  }

  detach(input: GrantScope & Pick<RuntimeAttachment, 'machineId'> & { state: 'draining' | 'detached' | 'lost'; discardHeldBack?: boolean }): RuntimeAttachment {
    const attachment = this.list().find(candidate => candidate.attachmentId === input.attachmentId);
    if (!attachment || attachment.projectId !== input.projectId || attachment.workspaceId !== input.workspaceId || attachment.machineId !== input.machineId || attachment.generation !== input.generation) throw new Error('Attachment detach has stale authority');
    // Lost is terminal: a machine that reports any detach of it is only told so.
    if (attachment.state === 'lost') return attachment;
    if (input.state === 'lost') return this.lose(input.attachmentId, input.generation, 'operator');
    if (input.state === 'draining' && attachment.role === 'cache') {
      attachment.detachRequest = input.discardHeldBack === true ? { discardHeldBack: true } : {};
      this.storage.sql.exec('UPDATE runtime_attachments SET record=? WHERE id=?', JSON.stringify(attachment), attachment.attachmentId);
    }
    if (attachment.state === input.state) return attachment;
    return this.transition(input.attachmentId, input.generation, input.state);
  }

  async reconcileDetach(input: GrantScope & Pick<RuntimeAttachment, 'machineId'>) {
    const attachment = this.list().find(candidate => candidate.attachmentId === input.attachmentId);
    if (!attachment || attachment.projectId !== input.projectId || attachment.workspaceId !== input.workspaceId || attachment.machineId !== input.machineId || attachment.generation !== input.generation || !['draining', 'detached', 'lost'].includes(attachment.state)) throw new Error('Detach reconciliation has stale authority');
    const rows = this.storage.sql.exec<{ dispatch: string }>("SELECT dispatch FROM runtime_attempts WHERE status='dispatched'").toArray();
    for (const row of rows) {
      const dispatch = RuntimeToolDispatchSchema.parse(JSON.parse(row.dispatch));
      if (dispatch.attachmentId === input.attachmentId) await this.cancel(dispatch);
    }
  }

  private settle(lease: GrantScope & Pick<RuntimeAttachment, 'machineId'>, candidate: RuntimeToolResult): RuntimeToolResult {
    const result = RuntimeToolResultSchema.parse(candidate);
    return this.storage.transactionSync(() => {
      const attempt = this.getAttempt(result.attemptId);
      if (!attempt || attempt.dispatch.requestId !== result.requestId || attempt.dispatch.attachmentId !== lease.attachmentId || attempt.dispatch.generation !== lease.generation || attempt.dispatch.machineId !== lease.machineId || attempt.dispatch.projectId !== lease.projectId || attempt.dispatch.workspaceId !== lease.workspaceId) throw new Error('Attempt settlement does not match immutable dispatch authority');
      if (attempt.result) {
        if (JSON.stringify(attempt.result) !== JSON.stringify(result)) throw new Error('Attempt already has a different terminal result');
        return attempt.result;
      }
      if (attempt.status !== 'dispatched') throw new Error('Attempt was not dispatched');
      this.putTerminalPayload(result.attemptId, 'result', JSON.stringify(result));
      this.storage.sql.exec("UPDATE runtime_attempts SET status=?,result='null' WHERE id=?", result.status, result.attemptId);
      return result;
    });
  }
  recordCacheFlush(attachmentId: string, generation: number): void {
    const attachment = this.list().find(item => item.attachmentId === attachmentId && item.generation === generation);
    if (!attachment || attachment.role !== 'cache' || attachment.state !== 'draining') throw new Error('Final snapshot requires a draining cache');
    this.storage.sql.exec('INSERT OR REPLACE INTO runtime_primary_flush(attachment,generation) VALUES(?,?)', attachmentId, generation);
  }
  /** Loss is never a transition here: `lose` is the only way into the terminal, releasing `lost` state. */
  transition(attachmentId: string, generation: number, state: 'ready' | 'draining' | 'detached'): RuntimeAttachment {
    return this.storage.transactionSync(() => {
      const attachment = this.list().find(item => item.attachmentId === attachmentId);
      if (!attachment || attachment.generation !== generation) throw new Error('Stale attachment generation');
      const permitted: Record<RuntimeAttachment['state'], readonly RuntimeAttachment['state'][]> = { attaching: ['ready', 'draining'], ready: ['draining'], draining: ['detached'], lost: [], detached: [] };
      if (!permitted[attachment.state].includes(state)) throw new Error('Invalid attachment transition');
      if (state === 'detached' && this.storage.sql.exec<{ dispatch: string }>("SELECT dispatch FROM runtime_attempts WHERE status='dispatched'").toArray().some(row => RuntimeToolDispatchSchema.parse(JSON.parse(row.dispatch)).attachmentId === attachmentId)) throw new Error('Unresolved execution prevents detach');
      if (attachment.role === 'cache' && state === 'detached' && !this.storage.sql.exec('SELECT attachment FROM runtime_primary_flush WHERE attachment=? AND generation=?', attachmentId, generation).toArray().length) throw new Error('Cache must publish its final snapshot before detaching');
      const now = Date.now();
      const next = { ...attachment, state, updatedAt: new Date(now).toISOString() };
      next.deadlineAt = this.deadline(next, leaseOf(attachment), now);
      if (state === 'detached') delete next.detachRequest;
      this.save(next);
      return next;
    });
  }
  private async exchange(dispatch: RuntimeToolDispatch, op: 'execute' | 'observe' | 'cancel' | 'ack', signal: AbortSignal, receipt?: RuntimeExecutorReceipt): Promise<RuntimeReceiptTransport> {
    const attachment = this.list().find(item => item.attachmentId === dispatch.attachmentId);
    if (!attachment || attachment.generation !== dispatch.generation || attachment.machineId !== dispatch.machineId || attachment.projectId !== dispatch.projectId || attachment.workspaceId !== dispatch.workspaceId || (op === 'execute' && attachment.state !== 'ready')) throw new Error('Executor attachment authority is stale');
    if (op === 'execute' && (!attachment.heartbeatAt || Date.now() - Date.parse(attachment.heartbeatAt) > ATTACHMENT_ONLINE_MS)) throw new Error('Executor attachment is offline');
    const row = this.storage.sql.exec<{ secret: string }>('SELECT secret FROM runtime_attachments WHERE id=?', attachment.attachmentId).toArray()[0];
    if (!row) throw new Error('Attachment grant missing');
    const secret = await this.services.open(row.secret, attachment);
    const body = JSON.stringify(op === 'execute' ? dispatch : { op, dispatch, ...(op === 'ack' && receipt ? { acknowledgement: { version: 1, receiptId: receipt.receiptId, dispatch: receipt.dispatch, receiptDigest: await receiptDigest(receipt), acknowledgedAt: new Date().toISOString() } } : {}) });
    const key = await crypto.subtle.importKey('raw', Uint8Array.from(atob(secret.replaceAll('-', '+').replaceAll('_', '/')), character => character.charCodeAt(0)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const signature = encode(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body))));
    const envelope = RuntimeReceiptTransportSchema.parse(await this.services.dispatch({ machineId: dispatch.machineId, path: op === 'execute' ? '/runtime/execute' : '/runtime/receipt', body, signature, signal }));
    await verifyReceipt(dispatch, envelope, secret);
    return envelope;
  }
  private async accept(dispatch: RuntimeToolDispatch, envelope: RuntimeReceiptTransport): Promise<RuntimeExecutorReceipt> {
    const receipt = envelope.receipt;
    const collected = this.collectedReceipt(dispatch.attemptId);
    if (collected) {
      if (canonicalJson(collected) !== canonicalJson(receipt)) throw new Error('Terminal receipt changed');
      return collected;
    }
    if (receipt.state === 'terminal') {
      this.storage.transactionSync(() => {
        const previous = this.storage.sql.exec<{ envelope: string }>('SELECT envelope FROM runtime_executor_receipts WHERE id=?', dispatch.attemptId).toArray()[0];
        if (previous && canonicalJson(JSON.parse(this.terminalPayload(dispatch.attemptId, 'envelope', previous.envelope))) !== canonicalJson(envelope)) throw new Error('Terminal receipt changed');
        this.settle(dispatch, receipt.result);
        if (!previous) {
          this.putTerminalPayload(dispatch.attemptId, 'envelope', JSON.stringify(envelope));
          this.storage.sql.exec("INSERT INTO runtime_executor_receipts(id,envelope) VALUES(?,'null')", dispatch.attemptId);
        }
      });
      await this.storage.sync();
      try {
        const acknowledged = await this.exchange(dispatch, 'ack', AbortSignal.timeout(10_000), receipt);
        if (canonicalJson(acknowledged.receipt) !== canonicalJson(receipt)) throw new Error('Acknowledgement response changed the terminal receipt');
        this.storage.sql.exec('UPDATE runtime_executor_receipts SET acknowledged=1 WHERE id=?', dispatch.attemptId);
      } catch { /* Durable receipt remains available; every subsequent observation retries acknowledgement. */ }
    }
    if (receipt.state === 'fenced-not-started') this.storage.sql.exec("UPDATE runtime_attempts SET status='fenced' WHERE id=? AND result IS NULL", dispatch.attemptId);
    return receipt;
  }
  async reconcile(dispatch: RuntimeToolDispatch, signal: AbortSignal = AbortSignal.timeout(30_000)): Promise<RuntimeExecutorReceipt> {
    const prior = this.getAttempt(dispatch.attemptId);
    if (prior && canonicalJson(prior.dispatch) !== canonicalJson(dispatch)) throw new Error('Attempt identity changed');
    const collected = this.collectedReceipt(dispatch.attemptId);
    if (collected) return collected;
    const saved = this.storage.sql.exec<{ envelope: string }>('SELECT envelope FROM runtime_executor_receipts WHERE id=?', dispatch.attemptId).toArray()[0];
    if (saved) return this.accept(dispatch, RuntimeReceiptTransportSchema.parse(JSON.parse(this.terminalPayload(dispatch.attemptId, 'envelope', saved.envelope))));
    let envelope: RuntimeReceiptTransport;
    try { envelope = await this.exchange(dispatch, 'observe', signal); }
    catch { return RuntimeExecutorReceiptSchema.parse({ version: 1, receiptId: crypto.randomUUID(), dispatch: await dispatchIdentity(dispatch), observedAt: new Date().toISOString(), state: 'unknown', reason: 'unreachable' }); }
    return this.accept(dispatch, envelope);
  }
  async cancel(dispatch: RuntimeToolDispatch, signal: AbortSignal = AbortSignal.timeout(30_000)): Promise<RuntimeExecutorReceipt> {
    const prior = this.getAttempt(dispatch.attemptId);
    if (prior && canonicalJson(prior.dispatch) !== canonicalJson(dispatch)) throw new Error('Attempt identity changed');
    const collected = this.collectedReceipt(dispatch.attemptId);
    if (collected) return collected;
    this.storage.sql.exec("INSERT INTO runtime_attempts(id,dispatch,status) VALUES(?,?,'dispatched') ON CONFLICT(id) DO NOTHING", dispatch.attemptId, JSON.stringify(dispatch));
    await this.storage.sync();
    return this.accept(dispatch, await this.exchange(dispatch, 'cancel', signal));
  }
  async execute(dispatch: RuntimeToolDispatch, signal: AbortSignal): Promise<RuntimeToolResult> {
    dispatch = RuntimeToolDispatchSchema.parse(dispatch);
    const prior = this.getAttempt(dispatch.attemptId);
    if (prior && canonicalJson(prior.dispatch) !== canonicalJson(dispatch)) throw new Error('Attempt identity changed');
    let receipt: RuntimeExecutorReceipt;
    if (prior) {
      const lost = this.lossResult(dispatch.attemptId);
      if (lost) return lost;
      receipt = await this.reconcile(dispatch, signal);
    } else {
      await this.services.admitExecution?.(dispatch.machineId);
      signal.throwIfAborted();
      const raced = this.getAttempt(dispatch.attemptId);
      if (raced) {
        if (canonicalJson(raced.dispatch) !== canonicalJson(dispatch)) throw new Error('Attempt identity changed');
        receipt = await this.reconcile(dispatch, signal);
      } else {
        this.storage.sql.exec("INSERT INTO runtime_attempts(id,dispatch,status) VALUES(?,?,'dispatched')", dispatch.attemptId, JSON.stringify(dispatch));
        await this.storage.sync();
        try { receipt = await this.accept(dispatch, await this.exchange(dispatch, 'execute', signal)); }
        catch (error) {
          if (!(error instanceof ExecutorNotConnected)) receipt = await this.reconcile(dispatch, signal);
          else {
            // Never delivered, so no effect exists: do not leave an unresolved attempt to poll until its deadline.
            this.storage.sql.exec("DELETE FROM runtime_attempts WHERE id=? AND status='dispatched'", dispatch.attemptId);
            await this.storage.sync();
            throw error;
          }
        }
      }
    }
    for (;;) {
      if (receipt.state === 'terminal') return receipt.result;
      if (receipt.state === 'fenced-not-started') throw new Error('Executor launch was prevented by a durable fence');
      signal.throwIfAborted();
      if (Date.parse(dispatch.deadlineAt) <= Date.now()) throw new Error('Executor outcome remains pending after deadline');
      await new Promise<void>((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(signal.reason); };
        const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 1000);
        signal.addEventListener('abort', abort, { once: true });
      });
      // A lost attachment settles its attempts as interrupted; a late machine receipt must not contradict that.
      const lost = this.lossResult(dispatch.attemptId);
      if (lost) return lost;
      receipt = await this.reconcile(dispatch, signal);
    }
  }
}
