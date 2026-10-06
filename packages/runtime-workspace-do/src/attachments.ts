import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { canonicalJson, dispatchIdentity, receiptDigest, verifyReceipt, RuntimeExecutorReceiptSchema, RuntimeReceiptTransportSchema, RuntimeAttachmentSchema, RuntimeToolDispatchSchema, RuntimeToolResultSchema, type RuntimeExecutorReceipt, type RuntimeReceiptTransport, type RuntimeAttachInput, type RuntimeAttachment, type RuntimeToolDispatch, type RuntimeToolResult } from '@gitspace/protocol-runtime';
import { RuntimeAttachmentSourceSchema, RuntimeExecutionObservationSchema } from '@gitspace/protocol-runtime';
import type { RuntimeAttachmentSource, RuntimeAttachmentRequestInput, RuntimeAttachmentReadyInput, RuntimeExecutionObservation } from '@gitspace/protocol-runtime';
export type GrantScope = Pick<RuntimeAttachment, 'projectId' | 'workspaceId' | 'attachmentId' | 'generation'>;
export type AttachmentServices = {
  seal(secret: string, scope: GrantScope): Promise<string>;
  open(ciphertext: string, scope: GrantScope): Promise<string>;
  dispatch(input: { machineId: RuntimeAttachment['machineId']; path: '/runtime/execute' | '/runtime/receipt'; body: string; signature: string; signal: AbortSignal }): Promise<RuntimeReceiptTransport>;
};
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
    storage.sql.exec('CREATE TABLE IF NOT EXISTS runtime_primary_flush(attachment TEXT PRIMARY KEY, generation INTEGER NOT NULL)');
    const columns = storage.sql.exec<{ name: string }>('PRAGMA table_info(runtime_attachments)').toArray();
    if (!columns.some(column => column.name === 'request_id')) storage.sql.exec('ALTER TABLE runtime_attachments ADD COLUMN request_id TEXT');
    if (!columns.some(column => column.name === 'source')) storage.sql.exec('ALTER TABLE runtime_attachments ADD COLUMN source TEXT');
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
    if (input.role === 'replica' && input.checkout.kind !== 'branch') throw new Error('Replica requires a private branch');
    const candidate = RuntimeAttachmentSchema.parse({ ...input, attachmentId: crypto.randomUUID(), state: 'attaching', updatedAt: new Date().toISOString() });
    const candidateSecret = encode(crypto.getRandomValues(new Uint8Array(32)));
    const ciphertext = await this.services.seal(candidateSecret, candidate);
    const attachment = this.storage.transactionSync(() => {
      const current = this.list();
      const existing = current.find(a => a.machineId === input.machineId && a.generation === input.generation && a.state !== 'detached');
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
      if (input.role === 'primary' && current.some(a => a.machineId === input.machineId && a.role === 'primary' && a.state !== 'detached')) throw new Error('Previous attachment of this shared checkout must complete its fencing barrier');
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
      if (attachment.role !== (input.role ?? (input.checkout.kind === 'snapshot' ? 'runner' : 'delegate')) || attachment.machineId !== input.machineId || attachment.projectId !== input.projectId || attachment.workspaceId !== input.workspaceId || JSON.stringify(attachment.checkout) !== JSON.stringify(input.checkout) || JSON.stringify(saved) !== JSON.stringify(source)) throw new Error('Attachment request identity changed');
      return { attachment };
    }
    const generation = Math.max(-1, ...this.list().filter(attachment => attachment.machineId === input.machineId).map(attachment => attachment.generation)) + 1;
    const { attachment } = await this.attach({ projectId: input.projectId, workspaceId: input.workspaceId, machineId: input.machineId, generation,
      role: input.role ?? (input.checkout.kind === 'snapshot' ? 'runner' : 'delegate'), checkout: input.checkout, capabilities,
    }, { requestId: input.requestId, source });
    return { attachment };
  }

  async requestPrimary(input: Omit<RuntimeAttachInput, 'generation' | 'role'> & { requestId: string }) {
    const prior = this.storage.sql.exec<{ record: string }>('SELECT record FROM runtime_attachments WHERE request_id=?', input.requestId).toArray()[0];
    if (prior) {
      const attachment = RuntimeAttachmentSchema.parse(JSON.parse(prior.record));
      if (attachment.role !== 'primary' || attachment.machineId !== input.machineId || attachment.projectId !== input.projectId || attachment.workspaceId !== input.workspaceId || attachment.ownershipGeneration !== input.ownershipGeneration || JSON.stringify(attachment.checkout) !== JSON.stringify(input.checkout)) throw new Error('Attachment request identity changed');
      return { attachment };
    }
    const generation = Math.max(-1, ...this.list().map(attachment => attachment.generation)) + 1;
    const { attachment } = await this.attach({ ...input, generation, role: 'primary' }, { requestId: input.requestId, source: null });
    return { attachment };
  }

  async assignments(machineId: RuntimeAttachment['machineId']) {
    const records = this.storage.sql.exec<{ record: string; source: string | null; secret: string }>('SELECT record,source,secret FROM runtime_attachments').toArray();
    const assignments = [];
    for (const row of records) {
      const attachment = RuntimeAttachmentSchema.parse(JSON.parse(row.record));
      if (attachment.machineId !== machineId || attachment.state === 'detached') continue;
      const grant = { attachment, executionSecret: await this.services.open(row.secret, attachment) };
      assignments.push({ grant, source: row.source && row.source !== 'null' ? RuntimeAttachmentSourceSchema.parse(JSON.parse(row.source)) : null });
    }
    return assignments;
  }

  ready(input: RuntimeAttachmentReadyInput, primaryCommit?: string) {
    const attachment = this.list().find(candidate => candidate.attachmentId === input.attachmentId);
    const expected = attachment?.checkout.kind === 'shared' ? attachment.role === 'primary' ? primaryCommit : undefined : attachment?.checkout.commit;
    if (!attachment || attachment.machineId !== input.machineId || attachment.projectId !== input.projectId || attachment.workspaceId !== input.workspaceId || attachment.generation !== input.generation || expected === undefined || expected !== input.commit || !input.prerequisitesComplete) throw new Error('Attachment readiness proof does not match its admission');
    if (!attachment.capabilities.every(capability => input.capabilities.includes(capability))) throw new Error('Executor lacks assigned capabilities');
    if (attachment.state === 'ready') {
      if (canonicalJson(attachment.lfsRestored ?? []) !== canonicalJson(input.lfsRestored ?? [])) throw new Error('Attachment readiness LFS proof changed');
      return { attachment };
    }
    return this.storage.transactionSync(() => {
      const ready = this.transition(attachment.attachmentId, attachment.generation, 'ready');
      const next = { ...ready, ...(input.lfsRestored ? { lfsRestored: input.lfsRestored } : {}) };
      this.storage.sql.exec('UPDATE runtime_attachments SET record=? WHERE id=?', JSON.stringify(next), attachment.attachmentId);
      return { attachment: next };
    });
  }

  heartbeat(lease: GrantScope & Pick<RuntimeAttachment, 'machineId'> & { executionObservation: RuntimeExecutionObservation; browserCapabilities?: string[] }): RuntimeAttachment {
    const attachment = this.list().find(candidate => candidate.attachmentId === lease.attachmentId);
    if (!attachment || attachment.projectId !== lease.projectId || attachment.workspaceId !== lease.workspaceId || attachment.machineId !== lease.machineId || attachment.generation !== lease.generation || !['attaching', 'ready', 'draining'].includes(attachment.state)) throw new Error('Attachment heartbeat has stale authority');
    const observation = RuntimeExecutionObservationSchema.parse(lease.executionObservation);
    const observedAt = Date.parse(observation.observedAt);
    if (observedAt > Date.now() + 5_000 || (attachment.executionObservation && observedAt < Date.parse(attachment.executionObservation.observedAt))) throw new Error('Execution observation clock is invalid or stale');
    const next = { ...attachment, ...(lease.browserCapabilities ? { capabilities: [...attachment.capabilities.filter(capability => capability !== 'browser' && capability !== 'browser_control' && !capability.startsWith('browser.')), ...lease.browserCapabilities] } : {}), executionObservation: observation, updatedAt: new Date().toISOString() };
    this.storage.sql.exec('UPDATE runtime_attachments SET record=? WHERE id=?', JSON.stringify(next), attachment.attachmentId);
    return next;
  }

  detach(input: GrantScope & Pick<RuntimeAttachment, 'machineId'> & { state: 'draining' | 'detached' | 'lost' }): RuntimeAttachment {
    const attachment = this.list().find(candidate => candidate.attachmentId === input.attachmentId);
    if (!attachment || attachment.projectId !== input.projectId || attachment.workspaceId !== input.workspaceId || attachment.machineId !== input.machineId || attachment.generation !== input.generation) throw new Error('Attachment detach has stale authority');
    if (attachment.state === input.state) return attachment;
    return this.transition(input.attachmentId, input.generation, input.state);
  }

  async reconcileDetach(input: GrantScope & Pick<RuntimeAttachment, 'machineId'>) {
    const attachment = this.list().find(candidate => candidate.attachmentId === input.attachmentId);
    if (!attachment || attachment.projectId !== input.projectId || attachment.workspaceId !== input.workspaceId || attachment.machineId !== input.machineId || attachment.generation !== input.generation || !['draining', 'detached'].includes(attachment.state)) throw new Error('Detach reconciliation has stale authority');
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
  recordPrimaryFlush(attachmentId: string, generation: number): void {
    const attachment = this.list().find(item => item.attachmentId === attachmentId && item.generation === generation);
    if (!attachment || (attachment.role !== 'primary' && attachment.role !== 'replica') || attachment.state !== 'draining') throw new Error('Final snapshot requires a draining replica');
    this.storage.sql.exec('INSERT OR REPLACE INTO runtime_primary_flush(attachment,generation) VALUES(?,?)', attachmentId, generation);
  }
  transition(attachmentId: string, generation: number, state: RuntimeAttachment['state']): RuntimeAttachment {
    return this.storage.transactionSync(() => {
      const attachment = this.list().find(item => item.attachmentId === attachmentId);
      if (!attachment || attachment.generation !== generation) throw new Error('Stale attachment generation');
      const permitted: Record<RuntimeAttachment['state'], readonly RuntimeAttachment['state'][]> = { attaching: ['ready', 'lost', 'draining'], ready: ['draining', 'lost'], draining: ['detached', 'lost'], lost: ['draining'], detached: [] };
      if (!permitted[attachment.state].includes(state)) throw new Error('Invalid attachment transition');
      if (state === 'detached' && this.storage.sql.exec<{ dispatch: string }>("SELECT dispatch FROM runtime_attempts WHERE status='dispatched'").toArray().some(row => RuntimeToolDispatchSchema.parse(JSON.parse(row.dispatch)).attachmentId === attachmentId)) throw new Error('Unresolved execution prevents detach');
      if ((attachment.role === 'primary' || attachment.role === 'replica') && state === 'detached' && !this.storage.sql.exec('SELECT attachment FROM runtime_primary_flush WHERE attachment=? AND generation=?', attachmentId, generation).toArray().length) throw new Error('Replica must publish its final snapshot before detaching');
      const next = { ...attachment, state, updatedAt: new Date().toISOString() };
      this.storage.sql.exec('UPDATE runtime_attachments SET record=? WHERE id=?', JSON.stringify(next), attachmentId);
      return next;
    });
  }
  private async exchange(dispatch: RuntimeToolDispatch, op: 'execute' | 'observe' | 'cancel' | 'ack', signal: AbortSignal, receipt?: RuntimeExecutorReceipt): Promise<RuntimeReceiptTransport> {
    const attachment = this.list().find(item => item.attachmentId === dispatch.attachmentId);
    if (!attachment || attachment.generation !== dispatch.generation || attachment.machineId !== dispatch.machineId || attachment.projectId !== dispatch.projectId || attachment.workspaceId !== dispatch.workspaceId || (op === 'execute' && attachment.state !== 'ready')) throw new Error('Executor attachment authority is stale');
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
    if (prior) receipt = await this.reconcile(dispatch, signal);
    else {
      this.storage.sql.exec("INSERT INTO runtime_attempts(id,dispatch,status) VALUES(?,?,'dispatched')", dispatch.attemptId, JSON.stringify(dispatch));
      await this.storage.sync();
      try { receipt = await this.accept(dispatch, await this.exchange(dispatch, 'execute', signal)); }
      catch { receipt = await this.reconcile(dispatch, signal); }
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
      receipt = await this.reconcile(dispatch, signal);
    }
  }
}
