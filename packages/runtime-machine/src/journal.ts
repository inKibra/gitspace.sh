import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { canonicalJson, RuntimeDispatchSelectionSchema, RuntimeReceiptTransportSchema, RuntimeAttachmentSchema, RuntimeToolDispatchSchema, RuntimeToolResultSchema, type RuntimeAttachment, type RuntimeToolDispatch, type RuntimeToolResult, type RuntimeReceiptTransport } from '@gitspace/protocol-runtime';
import { z } from 'zod';

const LocalAttachmentSchema = z.object({ attachment: RuntimeAttachmentSchema, rootPath: z.string().min(1), executionSecret: z.string().min(1), prerequisitesComplete: z.boolean(), checkoutPrepared: z.boolean().optional() });
export type LocalAttachment = z.infer<typeof LocalAttachmentSchema>;
const RowSchema = z.object({ payload: z.string() });
const AttemptSchema = z.object({ dispatch: RuntimeToolDispatchSchema, fingerprint: z.string(), state: z.enum(['starting', 'running', 'fenced', 'settled']), result: RuntimeToolResultSchema.nullable(), receipt: RuntimeReceiptTransportSchema.optional(), acknowledged: z.boolean().optional(), cancelRequested: z.boolean().optional() });
export type ExecutorAttempt = z.infer<typeof AttemptSchema>;
export function dispatchFingerprint(dispatch: RuntimeToolDispatch): string { return createHash('sha256').update(canonicalJson(dispatch)).digest('hex'); }

/** FULL synchronous SQLite commits precede effects. A running row survives a process crash as uncertainty, never permission to retry. */
export class ExecutorJournal {
  private readonly database: Database;
  constructor(path: string) {
    this.database = new Database(path, { create: true });
    this.database.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS executor_attachments (id TEXT PRIMARY KEY, payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS executor_attempts (id TEXT PRIMARY KEY, attachment_id TEXT NOT NULL, payload TEXT NOT NULL);');
    this.database.exec('CREATE TABLE IF NOT EXISTS executor_proposals(id TEXT PRIMARY KEY, payload TEXT NOT NULL)');
  }
  attachment(id: string): LocalAttachment | null {
    const row = this.database.query('SELECT payload FROM executor_attachments WHERE id = ?').get(id);
    return row === null ? null : LocalAttachmentSchema.parse(JSON.parse(RowSchema.parse(row).payload));
  }
  attachments(): LocalAttachment[] {
    return this.database.query('SELECT payload FROM executor_attachments').all().map(row => LocalAttachmentSchema.parse(JSON.parse(RowSchema.parse(row).payload)));
  }
  installAttachment(value: LocalAttachment): void {
    const record = LocalAttachmentSchema.parse(value);
    const previous = this.attachment(record.attachment.attachmentId);
    if (previous && (previous.attachment.generation > record.attachment.generation || previous.attachment.machineId !== record.attachment.machineId || previous.attachment.workspaceId !== record.attachment.workspaceId || previous.attachment.projectId !== record.attachment.projectId)) throw new Error('Attachment identity or generation conflict');
    if (previous && previous.attachment.generation !== record.attachment.generation && this.unresolved(previous.attachment).length) throw new Error('Cannot transfer attachment while effects are unresolved');
    for (const other of this.attachments()) {
      if (other.attachment.attachmentId === record.attachment.attachmentId || other.attachment.workspaceId !== record.attachment.workspaceId || other.attachment.projectId !== record.attachment.projectId || other.attachment.role !== 'primary' || record.attachment.role !== 'primary') continue;
      if (other.attachment.generation > record.attachment.generation) throw new Error('New primary attachment has stale authority generation');
      if (other.attachment.state === 'ready' || other.attachment.state === 'draining') {
        if (this.unresolved(other.attachment).length) throw new Error('Previous primary has unresolved effects; transfer requires recovery');
        this.database.query('UPDATE executor_attachments SET payload=? WHERE id=?').run(JSON.stringify({ ...other, attachment: { ...other.attachment, state: 'detached' } }), other.attachment.attachmentId);
      }
    }
    this.database.query('INSERT INTO executor_attachments(id,payload) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(record.attachment.attachmentId, JSON.stringify(record));
  }
  attempt(id: string): ExecutorAttempt | null {
    const row = this.database.query('SELECT payload FROM executor_attempts WHERE id = ?').get(id);
    return row === null ? null : AttemptSchema.parse(JSON.parse(RowSchema.parse(row).payload));
  }
  begin(dispatch: RuntimeToolDispatch): ExecutorAttempt {
    return this.database.transaction(() => {
      const previous = this.attempt(dispatch.attemptId);
      const fingerprint = dispatchFingerprint(dispatch);
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new Error('Attempt ID cannot be reused with changed dispatch');
        return previous;
      }
      const attempt: ExecutorAttempt = { dispatch, fingerprint, state: 'starting', result: null };
      this.database.query('INSERT INTO executor_attempts(id,attachment_id,payload) VALUES (?,?,?)').run(dispatch.attemptId, dispatch.attachmentId, JSON.stringify(attempt));
      return attempt;
    })();
  }
  proposal(id: string): unknown | null {
    const row = this.database.query('SELECT payload FROM executor_proposals WHERE id=?').get(id);
    return row === null ? null : JSON.parse(RowSchema.parse(row).payload);
  }
  saveProposal(id: string, value: unknown): void { this.database.query('INSERT INTO executor_proposals(id,payload) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(id, JSON.stringify(value)); }
  jobControl(dispatch: RuntimeToolDispatch) {
    if (dispatch.tool !== 'jobs') return null;
    const control = z.object({ op: z.enum(['logs', 'cancel']), attemptId: z.string().min(1) }).strict().safeParse(dispatch.args);
    if (!control.success) return null;
    const attempt = this.attempt(control.data.attemptId);
    if (!attempt || attempt.fingerprint !== dispatchFingerprint(attempt.dispatch)
      || attempt.dispatch.tool !== 'jobs' || !['running', 'settled'].includes(attempt.state)
      || attempt.dispatch.projectId !== dispatch.projectId || attempt.dispatch.workspaceId !== dispatch.workspaceId
      || attempt.dispatch.machineId !== dispatch.machineId || attempt.dispatch.attachmentId !== dispatch.attachmentId
      || attempt.dispatch.generation !== dispatch.generation || attempt.dispatch.conversationId !== dispatch.conversationId
      || attempt.dispatch.taskId !== dispatch.taskId) throw new Error('Job does not belong to this admitted execution');
    const job = RuntimeDispatchSelectionSchema.extend({ op: z.literal('run'), application: z.string().min(1), args: z.array(z.string()), cwd: z.string().optional(), deadlineAt: z.iso.datetime().optional() }).strict().parse(attempt.dispatch.args);
    return { ...control.data, dispatch: attempt.dispatch, job };
  }
  fence(dispatch: RuntimeToolDispatch): boolean {
    return this.database.transaction(() => {
      const attempt = this.begin(dispatch);
      if (attempt.state === 'running') {
        if (!attempt.cancelRequested) this.database.query('UPDATE executor_attempts SET payload=? WHERE id=?').run(JSON.stringify({ ...attempt, cancelRequested: true }), dispatch.attemptId);
        return false;
      }
      if (attempt.state !== 'starting' && attempt.state !== 'fenced') return false;
      this.database.query('UPDATE executor_attempts SET payload=? WHERE id=?').run(JSON.stringify({ ...attempt, state: 'fenced' }), dispatch.attemptId);
      return true;
    })();
  }
  launch(dispatch: RuntimeToolDispatch): boolean {
    return this.database.transaction(() => {
      const attempt = this.attempt(dispatch.attemptId);
      if (!attempt || attempt.fingerprint !== dispatchFingerprint(dispatch) || attempt.state !== 'starting') return false;
      this.database.query('UPDATE executor_attempts SET payload=? WHERE id=?').run(JSON.stringify({ ...attempt, state: 'running' }), dispatch.attemptId);
      return true;
    })();
  }
  saveReceipt(dispatch: RuntimeToolDispatch, receipt: RuntimeReceiptTransport): RuntimeReceiptTransport {
    return this.database.transaction(() => {
      const attempt = this.attempt(dispatch.attemptId);
      if (!attempt || attempt.fingerprint !== dispatchFingerprint(dispatch) || !attempt.result) throw new Error('No terminal attempt');
      if (attempt.receipt) return attempt.receipt;
      this.database.query('UPDATE executor_attempts SET payload=? WHERE id=?').run(JSON.stringify({ ...attempt, receipt }), dispatch.attemptId);
      return receipt;
    })();
  }
  acknowledge(dispatch: RuntimeToolDispatch): void {
    const attempt = this.attempt(dispatch.attemptId);
    if (!attempt?.receipt || attempt.fingerprint !== dispatchFingerprint(dispatch)) throw new Error('No receipt to acknowledge');
    this.database.query('UPDATE executor_attempts SET payload=? WHERE id=?').run(JSON.stringify({ ...attempt, acknowledged: true }), dispatch.attemptId);
  }
  settle(dispatch: RuntimeToolDispatch, result: RuntimeToolResult): void {
    const attempt = this.attempt(dispatch.attemptId);
    if (!attempt || attempt.fingerprint !== dispatchFingerprint(dispatch)) throw new Error('Missing immutable attempt claim');
    if (attempt.state === 'fenced') throw new Error('Durable launch fence cannot be settled');
    if (attempt.result && canonicalJson(attempt.result) !== canonicalJson(result)) throw new Error('Terminal attempt result cannot change');
    if (result.attemptId !== dispatch.attemptId || result.requestId !== dispatch.requestId) throw new Error('Result identity conflict');
    this.database.query('UPDATE executor_attempts SET payload = ? WHERE id = ?').run(JSON.stringify({ ...attempt, state: 'settled', result: RuntimeToolResultSchema.parse(result) }), dispatch.attemptId);
  }
  unresolved(attachment: RuntimeAttachment): ExecutorAttempt[] {
    return this.database.query('SELECT payload FROM executor_attempts WHERE attachment_id = ?').all(attachment.attachmentId).map(row => AttemptSchema.parse(JSON.parse(RowSchema.parse(row).payload))).filter(row => row.state === 'running' || row.state === 'starting');
  }
  hasRunningCheckout(rootPath: string): boolean {
    return this.database.query(`SELECT 1 FROM executor_attempts AS attempt
      JOIN executor_attachments AS attachment ON attachment.id = attempt.attachment_id
      WHERE json_extract(attachment.payload, '$.rootPath') = ?
        AND json_extract(attempt.payload, '$.state') = 'running' LIMIT 1`).get(rootPath) !== null;
  }
  close(): void { this.database.close(); }
}
