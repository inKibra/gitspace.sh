import { Database } from 'bun:sqlite';
import { RuntimeAttachmentSchema } from '@gitspace/protocol-runtime';
import { z } from 'zod';

const LocalAttachmentSchema = z.object({ attachment: RuntimeAttachmentSchema, rootPath: z.string().min(1), executionSecret: z.string().min(1), prerequisitesComplete: z.boolean() });
export type LocalAttachment = z.infer<typeof LocalAttachmentSchema>;
const RowSchema = z.object({ payload: z.string() });

/** The machine's local checkouts (one row per attachment) and staged AST proposals. Commands are not journaled. */
export class ExecutorJournal {
  private readonly database: Database;
  constructor(path: string, options: { readonly?: boolean } = {}) {
    this.database = new Database(path, options.readonly ? { readonly: true } : { create: true });
    if (options.readonly) return;
    this.database.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS executor_attachments (id TEXT PRIMARY KEY, payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS executor_proposals(id TEXT PRIMARY KEY, payload TEXT NOT NULL); DROP TABLE IF EXISTS executor_attempts;');
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
  close(): void { this.database.close(); }
}
