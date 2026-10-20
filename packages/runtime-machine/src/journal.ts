import { Database } from 'bun:sqlite';
import { RuntimeAttachmentSchema, RuntimeToolResultSchema, type RuntimeToolResult } from '@gitspace/protocol-runtime';
import { z } from 'zod';

const LocalAttachmentSchema = z.object({ attachment: RuntimeAttachmentSchema, rootPath: z.string().min(1), executionSecret: z.string().min(1), prerequisitesComplete: z.boolean() });
export type LocalAttachment = z.infer<typeof LocalAttachmentSchema>;
const RowSchema = z.object({ payload: z.string() });

/** The machine's local checkouts (one row per attachment), staged AST proposals, and the results of commands finished
 * in the last day, so a reply lost with the relay connection can be answered again. */
export class ExecutorJournal {
  private readonly database: Database;
  constructor(path: string, options: { readonly?: boolean } = {}) {
    this.database = new Database(path, options.readonly ? { readonly: true } : { create: true });
    if (options.readonly) return;
    this.database.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS executor_attachments (id TEXT PRIMARY KEY, payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS executor_proposals(id TEXT PRIMARY KEY, payload TEXT NOT NULL); DROP TABLE IF EXISTS executor_attempts; CREATE TABLE IF NOT EXISTS executor_results(attempt_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result TEXT NOT NULL, completed_at INTEGER NOT NULL);');
    // Results of replay-safe reads (process observations, one per poll) are no longer kept; drop the ones stored before.
    this.database.exec("DELETE FROM executor_results WHERE attempt_id LIKE 'process-observation:%' OR attempt_id LIKE 'process-stop-observation:%'");
    // Rows from the old attachment lifecycle: lost/draining become detached and an old-shape cache observation is
    // dropped (the next heartbeat sends a new one). A row that still does not parse is removed; the cloud reassigns it.
    const OldRowSchema = z.object({ id: z.string(), payload: z.string() });
    for (const row of this.database.query('SELECT id, payload FROM executor_attachments').all().map(value => OldRowSchema.parse(value))) {
      if (LocalAttachmentSchema.safeParse(JSON.parse(row.payload)).success) continue;
      const old = z.object({ attachment: z.record(z.string(), z.unknown()) }).passthrough().safeParse(JSON.parse(row.payload));
      const state = old.success ? old.data.attachment.state : undefined;
      const upgraded = old.success ? LocalAttachmentSchema.safeParse({ ...old.data, attachment: { ...old.data.attachment, state: state === 'attaching' || state === 'ready' ? state : 'detached', cache: undefined, failure: null } }) : undefined;
      if (upgraded?.success) this.database.query('UPDATE executor_attachments SET payload=? WHERE id=?').run(JSON.stringify(upgraded.data), row.id);
      else this.database.query('DELETE FROM executor_attachments WHERE id=?').run(row.id);
    }
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
    for (const other of this.attachments()) {
      if (other.attachment.attachmentId === record.attachment.attachmentId || other.attachment.workspaceId !== record.attachment.workspaceId || other.attachment.projectId !== record.attachment.projectId) continue;
      if (other.attachment.generation > record.attachment.generation) throw new Error('New cache attachment has stale authority generation');
      if (other.attachment.state !== 'detached') {
        this.database.query('UPDATE executor_attachments SET payload=? WHERE id=?').run(JSON.stringify({ ...other, attachment: { ...other.attachment, state: 'detached' } }), other.attachment.attachmentId);
      }
    }
    this.database.query('INSERT INTO executor_attachments(id,payload) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(record.attachment.attachmentId, JSON.stringify(record));
  }
  proposal(id: string): unknown | null {
    const row = this.database.query('SELECT payload FROM executor_proposals WHERE id=?').get(id);
    return row === null ? null : JSON.parse(RowSchema.parse(row).payload);
  }
  saveProposal(id: string, value: unknown): void { this.database.query('INSERT INTO executor_proposals(id,payload) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(id, JSON.stringify(value)); }
  /** A finished command's result and the fingerprint of the dispatch that ran it. */
  executionResult(attemptId: string): { fingerprint: string; result: RuntimeToolResult } | null {
    const row = this.database.query('SELECT fingerprint, result FROM executor_results WHERE attempt_id = ?').get(attemptId);
    if (row === null) return null;
    const { fingerprint, result } = z.object({ fingerprint: z.string(), result: z.string() }).parse(row);
    return { fingerprint, result: RuntimeToolResultSchema.parse(JSON.parse(result)) };
  }
  saveExecutionResult(attemptId: string, fingerprint: string, result: RuntimeToolResult): void {
    const now = Date.now();
    this.database.query('DELETE FROM executor_results WHERE completed_at < ?').run(now - 24 * 60 * 60 * 1000);
    this.database.query('INSERT OR REPLACE INTO executor_results(attempt_id, fingerprint, result, completed_at) VALUES (?, ?, ?, ?)').run(attemptId, fingerprint, JSON.stringify(result), now);
  }
  close(): void { this.database.close(); }
}
