import { z } from 'zod';
import { TaggedError } from 'better-result';
import { canonicalJson, RuntimeGitCheckpointSchema, RuntimeToolResultSchema, type RuntimeToolResult } from '@gitspace/protocol-runtime';
import type { AttachmentStore } from './attachments.js';
import { ArtifactsCodeStore, artifactsWorkspaceRepository } from './artifacts.js';

const InvocationSchema = z.object({ tool: z.enum(['read', 'edit', 'write']), args: z.unknown(), requestId: z.string(), attemptId: z.string() });
const PathSchema = z.object({ path: z.string().min(1) });
const ReadSchema = PathSchema.extend({ offset: z.number().int().positive().optional(), limit: z.number().int().positive().optional() });
const WriteSchema = PathSchema.extend({ content: z.string() });
const EditSchema = PathSchema.extend({ edits: z.array(z.object({ oldText: z.string().min(1), newText: z.string() })).min(1) });
type Checkpoint = z.infer<typeof RuntimeGitCheckpointSchema>;
type Invocation = z.infer<typeof InvocationSchema>;
const PendingSchema = z.object({ input: InvocationSchema, previous: RuntimeGitCheckpointSchema, path: z.string(), content: z.string(), fence: z.number().int().positive() });

export class CloudPublicationUncertain extends TaggedError('CloudPublicationUncertain')<{ attemptId: string; message: string }> {}

/** Read canonical checkpoint without constructing a runtime or waking inference. */
export async function readCurrentCheckpoint(storage: DurableObjectStorage): Promise<Checkpoint | null> {
  storage.sql.exec('CREATE TABLE IF NOT EXISTS runtime_code_snapshot(singleton INTEGER PRIMARY KEY CHECK(singleton=1), checkpoint TEXT NOT NULL)');
  let row = storage.sql.exec<{ checkpoint: string }>('SELECT checkpoint FROM runtime_code_snapshot WHERE singleton=1').toArray()[0];
  if (!row) {
    const legacy = await storage.get('runtime.code');
    if (legacy !== undefined) storage.sql.exec('INSERT OR IGNORE INTO runtime_code_snapshot(singleton,checkpoint) VALUES(1,?)', JSON.stringify(RuntimeGitCheckpointSchema.parse(legacy)));
    row = storage.sql.exec<{ checkpoint: string }>('SELECT checkpoint FROM runtime_code_snapshot WHERE singleton=1').toArray()[0];
  }
  return row ? RuntimeGitCheckpointSchema.parse(JSON.parse(row.checkpoint)) : null;
}
/** A non-expiring durable writer lease: uncertain publication must be retried, never stolen. */
export class CloudFileStore {
  private readonly running = new Map<string, Promise<RuntimeToolResult>>();
  constructor(private readonly storage: DurableObjectStorage, private readonly attachments: Pick<AttachmentStore, 'list'>, private readonly code: Pick<ArtifactsCodeStore, 'readFile' | 'writeSnapshot'>, private readonly workspaceId: string, private readonly publish: () => void, private readonly initialCheckpoint?: () => Promise<Checkpoint | null>) {
    storage.sql.exec('CREATE TABLE IF NOT EXISTS runtime_cloud_writer(singleton INTEGER PRIMARY KEY CHECK(singleton=1), fence INTEGER NOT NULL, attempt TEXT)');
    storage.sql.exec('INSERT OR IGNORE INTO runtime_cloud_writer(singleton,fence,attempt) VALUES(1,0,NULL)');
    storage.sql.exec('CREATE TABLE IF NOT EXISTS runtime_cloud_files(id TEXT PRIMARY KEY, input TEXT NOT NULL, pending TEXT, result TEXT)');
    storage.sql.exec('CREATE TABLE IF NOT EXISTS runtime_code_snapshot(singleton INTEGER PRIMARY KEY CHECK(singleton=1), checkpoint TEXT NOT NULL)');
    storage.sql.exec('CREATE TABLE IF NOT EXISTS runtime_code_commits(commit_id TEXT PRIMARY KEY, predecessor TEXT, checkpoint TEXT NOT NULL)');
  }
  hasAttempt(attemptId: string): boolean {
    return this.storage.sql.exec('SELECT id FROM runtime_cloud_files WHERE id=?', attemptId).toArray().length > 0;
  }
  snapshot(): Promise<Checkpoint | null> { return readCurrentCheckpoint(this.storage); }
  /** Explicit source initialization for file execution and attachment admission; snapshot stays read-only. */
  async initializeSnapshot(): Promise<Checkpoint | null> {
    const current = await this.snapshot();
    if (current || !this.initialCheckpoint || this.attachments.list().some(a => a.role === 'primary' && a.state !== 'detached')) return current;
    const source = await this.initialCheckpoint();
    if (!source) return null;
    const checkpoint = RuntimeGitCheckpointSchema.parse(source);
    return this.storage.transactionSync(() => {
      const row = this.storage.sql.exec<{ checkpoint: string }>('SELECT checkpoint FROM runtime_code_snapshot WHERE singleton=1').toArray()[0];
      if (row) return RuntimeGitCheckpointSchema.parse(JSON.parse(row.checkpoint));
      if (this.attachments.list().some(a => a.role === 'primary' && a.state !== 'detached')) return null;
      if (this.storage.sql.exec<{ attempt: string | null }>('SELECT attempt FROM runtime_cloud_writer WHERE singleton=1').toArray()[0]?.attempt) return null;
      this.recordCommit(checkpoint, null);
      this.storage.sql.exec('INSERT INTO runtime_code_snapshot(singleton,checkpoint) VALUES(1,?)', JSON.stringify(checkpoint));
      return checkpoint;
    });
  }
  /** Caller verifies the primary attachment/generation and immutable object availability. */
  commitMachine(checkpoint: Checkpoint, previous: string | null, initialOnly = false): void {
    this.storage.transactionSync(() => {
      if (this.storage.sql.exec<{ attempt: string | null }>('SELECT attempt FROM runtime_cloud_writer WHERE singleton=1').toArray()[0]?.attempt) throw new Error('Cloud publication holds the writer lease');
      const row = this.storage.sql.exec<{ checkpoint: string }>('SELECT checkpoint FROM runtime_code_snapshot WHERE singleton=1').toArray()[0];
      const current = row ? RuntimeGitCheckpointSchema.parse(JSON.parse(row.checkpoint)) : null;
      if (initialOnly && previous !== null) throw new Error('Attaching primary requires a null predecessor');
      if (current && canonicalJson(current) === canonicalJson(checkpoint)) return;
      if (initialOnly && current !== null) throw new Error('Attaching primary may only publish its initial checkpoint');
      if ((current?.worktreeCommit ?? null) !== previous) throw new Error('Snapshot publication has a stale predecessor');
      this.recordCommit(checkpoint, previous);
      this.storage.sql.exec('INSERT OR REPLACE INTO runtime_code_snapshot(singleton,checkpoint) VALUES(1,?)', JSON.stringify(checkpoint));
    });
    this.publish();
  }
  /** Resume a crashed lease before attachment admission; a failed provider remains fenced. */
  async recover(): Promise<void> {
    const lease = this.storage.sql.exec<{ attempt: string | null }>('SELECT attempt FROM runtime_cloud_writer WHERE singleton=1').toArray()[0];
    if (!lease?.attempt) return;
    const row = this.storage.sql.exec<{ input: string }>('SELECT input FROM runtime_cloud_files WHERE id=?', lease.attempt).toArray()[0];
    if (!row) throw new Error('Cloud writer lost its durable operation');
    await this.execute(InvocationSchema.parse(JSON.parse(row.input)));
  }
  execute(raw: Invocation, signal?: AbortSignal): Promise<RuntimeToolResult> {
    const input = InvocationSchema.parse(raw);
    const active = this.running.get(input.attemptId);
    if (active) return active.then(result => { this.assertIdentity(input); return result; });
    const promise = this.run(input, signal).catch(error => {
      const saved = this.assertIdentity(input);
      if (saved?.pending && !(error instanceof CloudPublicationUncertain)) throw new CloudPublicationUncertain({ attemptId: input.attemptId, message: error instanceof Error ? error.message : String(error) });
      throw error;
    }).finally(() => this.running.delete(input.attemptId));
    this.running.set(input.attemptId, promise);
    return promise;
  }
  private assertIdentity(input: Invocation) {
    const row = this.storage.sql.exec<{ input: string; pending: string | null; result: string | null }>('SELECT input,pending,result FROM runtime_cloud_files WHERE id=?', input.attemptId).toArray()[0];
    if (row && row.input !== canonicalJson(input)) throw new Error('Cloud attempt identity was reused');
    return row;
  }
  private async run(input: Invocation, signal?: AbortSignal): Promise<RuntimeToolResult> {
    const saved = this.assertIdentity(input);
    if (saved?.result) return RuntimeToolResultSchema.parse(JSON.parse(saved.result));
    if (saved?.pending) return this.finish(PendingSchema.parse(JSON.parse(saved.pending)), signal);
    const result = (status: 'completed' | 'failed', text: string): RuntimeToolResult => {
      const content: RuntimeToolResult['content'] = [{ type: 'text', text }];
      return status === 'failed'
        ? { requestId: input.requestId, attemptId: input.attemptId, status, content, error: { code: 'HOST_OPERATION_FAILED', message: text } }
        : { requestId: input.requestId, attemptId: input.attemptId, status, content };
    };
    let pending: z.infer<typeof PendingSchema> | undefined;
    try {
      signal?.throwIfAborted();
      const previous = await this.initializeSnapshot();
      if (!previous) throw new Error('Workspace has no committed source snapshot');
      const args = PathSchema.parse(input.args);
      const path = args.path.replace(/^\.\//u, '');
      if (!path || path.startsWith('/') || path.includes('://') || path.includes('\\') || path.split('/').some(part => !part || part === '..' || part === '.git')) throw new Error('Path leaves authorized checkout');
      const fence = this.storage.transactionSync(() => {
        if (this.attachments.list().some(a => a.role === 'primary' && a.state !== 'detached')) throw new Error('Primary machine owns the workspace writer');
        const lease = this.storage.sql.exec<{ fence: number; attempt: string | null }>('SELECT fence,attempt FROM runtime_cloud_writer WHERE singleton=1').toArray()[0];
        if (!lease || (lease.attempt && lease.attempt !== input.attemptId)) throw new Error('Cloud writer is busy or awaiting publication recovery');
        const current = this.storage.sql.exec<{ checkpoint: string }>('SELECT checkpoint FROM runtime_code_snapshot WHERE singleton=1').toArray()[0];
        if (!current || canonicalJson(RuntimeGitCheckpointSchema.parse(JSON.parse(current.checkpoint))) !== canonicalJson(previous)) throw new Error('Cloud snapshot predecessor changed before lease acquisition');
        this.storage.sql.exec('UPDATE runtime_cloud_writer SET fence=fence+1,attempt=? WHERE singleton=1', input.attemptId);
        this.storage.sql.exec('INSERT OR IGNORE INTO runtime_cloud_files(id,input) VALUES(?,?)', input.attemptId, canonicalJson(input));
        return lease.fence + 1;
      });
      await this.storage.sync();
      const read = async () => {
        const blob = await this.code.readFile(artifactsWorkspaceRepository(this.workspaceId), previous.worktreeCommit, path);
        if (!blob) throw new Error(`File not found: ${args.path}`);
        return new Uint8Array(await blob.arrayBuffer());
      };
      if (input.tool === 'read') {
        const parsed = ReadSchema.parse(input.args), bytes = await read();
        const prefix = new TextDecoder().decode(bytes.subarray(0, 12));
        const mimeType = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 ? 'image/png' : bytes[0] === 0xff && bytes[1] === 0xd8 ? 'image/jpeg' : prefix.startsWith('GIF8') ? 'image/gif' : prefix.startsWith('RIFF') && prefix.slice(8, 12) === 'WEBP' ? 'image/webp' : null;
        let completed: RuntimeToolResult;
        if (mimeType) {
          let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
          completed = { ...result('completed', ''), content: [{ type: 'image', mimeType, data: btoa(binary) }] };
        } else {
          const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes), start = (parsed.offset ?? 1) - 1;
          completed = result('completed', parsed.offset === undefined && parsed.limit === undefined ? text : text.split('\n').slice(start, parsed.limit === undefined ? undefined : start + parsed.limit).join('\n'));
        }
        this.complete(input, completed, fence); return completed;
      }
      let content: string;
      if (input.tool === 'write') content = WriteSchema.parse(input.args).content;
      else {
        const edits = EditSchema.parse(input.args).edits;
        const original = new TextDecoder('utf-8', { fatal: true }).decode(await read());
        const replacements = edits.map(edit => { const index = original.indexOf(edit.oldText); if (index < 0 || original.indexOf(edit.oldText, index + 1) >= 0) throw new Error('Edit text must match exactly once'); return { ...edit, index }; }).sort((a, b) => a.index - b.index);
        let end = 0; content = '';
        for (const edit of replacements) { if (edit.index < end) throw new Error('Edit ranges overlap'); content += original.slice(end, edit.index) + edit.newText; end = edit.index + edit.oldText.length; }
        content += original.slice(end);
      }
      pending = { input, previous, path, content, fence };
      this.storage.sql.exec('UPDATE runtime_cloud_files SET pending=? WHERE id=?', JSON.stringify(pending), input.attemptId);
      await this.storage.sync();
    } catch (error) {
      const failed = result('failed', error instanceof Error ? error.message : String(error));
      this.storage.transactionSync(() => {
        const row = this.assertIdentity(input);
        if (row?.pending) throw new CloudPublicationUncertain({ attemptId: input.attemptId, message: 'Cloud publication is durably pending after a storage failure' });
        this.storage.sql.exec('INSERT OR IGNORE INTO runtime_cloud_files(id,input,result) VALUES(?,?,?)', input.attemptId, canonicalJson(input), JSON.stringify(failed));
        this.storage.sql.exec('UPDATE runtime_cloud_files SET result=? WHERE id=? AND pending IS NULL', JSON.stringify(failed), input.attemptId);
        this.storage.sql.exec('UPDATE runtime_cloud_writer SET attempt=NULL WHERE singleton=1 AND attempt=?', input.attemptId);
      });
      return failed;
    }
    return this.finish(pending, signal);
  }
  private async finish(pending: z.infer<typeof PendingSchema>, signal?: AbortSignal): Promise<RuntimeToolResult> {
    const { input, fence, previous } = pending;
    const lease = this.storage.sql.exec<{ fence: number; attempt: string | null }>('SELECT fence,attempt FROM runtime_cloud_writer WHERE singleton=1').toArray()[0];
    if (lease?.attempt !== input.attemptId || lease.fence !== fence) throw new Error('Cloud writer fence is stale');
    const written = await this.code.writeSnapshot({ repository: artifactsWorkspaceRepository(this.workspaceId), workspaceId: this.workspaceId, previous, mutations: [{ path: pending.path, content: new TextEncoder().encode(pending.content) }], ...(signal ? { signal } : {}) });
    if (written.isErr()) {
      if (written.error.certainty === 'unknown') throw new CloudPublicationUncertain({ attemptId: input.attemptId, message: written.error.message });
      const failed: RuntimeToolResult = { requestId: input.requestId, attemptId: input.attemptId, status: 'failed', content: [{ type: 'text', text: written.error.message }], error: { code: 'HOST_OPERATION_FAILED', message: written.error.message } };
      this.complete(input, failed, fence);
      await this.storage.sync();
      return failed;
    }
    const completed: RuntimeToolResult = { requestId: input.requestId, attemptId: input.attemptId, status: 'completed', content: [{ type: 'text', text: `${input.tool === 'write' ? 'Wrote' : 'Edited'} ${PathSchema.parse(input.args).path}` }] };
    this.storage.transactionSync(() => {
      const row = this.storage.sql.exec<{ checkpoint: string }>('SELECT checkpoint FROM runtime_code_snapshot WHERE singleton=1').toArray()[0];
      if (!row || canonicalJson(RuntimeGitCheckpointSchema.parse(JSON.parse(row.checkpoint))) !== canonicalJson(previous)) throw new Error('Cloud snapshot predecessor changed');
      if (canonicalJson(written.value) !== canonicalJson(previous)) this.recordCommit(written.value, previous.worktreeCommit);
      this.complete(input, completed, fence);
      this.storage.sql.exec('UPDATE runtime_code_snapshot SET checkpoint=? WHERE singleton=1', JSON.stringify(written.value));
    });
    await this.storage.sync(); this.publish(); return completed;
  }
  private recordCommit(checkpoint: Checkpoint, predecessor: string | null): void {
    const encoded = canonicalJson(checkpoint);
    const prior = this.storage.sql.exec<{ predecessor: string | null; checkpoint: string }>('SELECT predecessor,checkpoint FROM runtime_code_commits WHERE commit_id=?', checkpoint.worktreeCommit).toArray()[0];
    if (prior) {
      if (prior.predecessor !== predecessor || prior.checkpoint !== encoded) throw new Error('Immutable checkpoint publication changed');
      return;
    }
    this.storage.sql.exec('INSERT INTO runtime_code_commits(commit_id,predecessor,checkpoint) VALUES(?,?,?)', checkpoint.worktreeCommit, predecessor, encoded);
  }
  private complete(input: Invocation, result: RuntimeToolResult, fence: number): void {
    this.storage.transactionSync(() => {
      const lease = this.storage.sql.exec<{ fence: number; attempt: string | null }>('SELECT fence,attempt FROM runtime_cloud_writer WHERE singleton=1').toArray()[0];
      if (lease?.attempt !== input.attemptId || lease.fence !== fence) throw new Error('Cloud writer fence is stale');
      this.storage.sql.exec('UPDATE runtime_cloud_files SET pending=NULL,result=? WHERE id=?', JSON.stringify(result), input.attemptId);
      this.storage.sql.exec('UPDATE runtime_cloud_writer SET attempt=NULL WHERE singleton=1');
    });
  }
}
