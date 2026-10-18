import { z } from 'zod';
import { TaggedError } from 'better-result';
import { applyTextEdits, canonicalJson, RuntimeGitCheckpointSchema, RuntimeToolResultSchema, RuntimeReadArgumentsSchema, RuntimeWriteArgumentsSchema, RuntimeEditArgumentsSchema, RuntimeFindArgumentsSchema, ApplyPatchArgumentsSchema, prepareV4APatch, type RuntimeToolResult } from '@gitspace/protocol-runtime';
import { collectBytes, parseGitLfsPointer, type GitLfsConfirmedObject, type GitLfsStore } from '@gitspace/protocol-workspace';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { AttachmentStore } from './attachments.js';
import { ArtifactsCodeStore, artifactsWorkspaceRepository } from './artifacts.js';
import { validateSnapshotPath } from './artifacts-snapshot.js';
import { parseEnvironmentBundleJson } from '@gitspace/protocol-environment';

const InvocationSchema = z.object({ tool: z.enum(['read', 'edit', 'write', 'find', 'apply_patch']), args: z.unknown(), requestId: z.string(), attemptId: z.string() });
const PathSchema = z.object({ path: z.string().min(1) });
type Checkpoint = z.infer<typeof RuntimeGitCheckpointSchema>;
type Invocation = z.infer<typeof InvocationSchema>;
const PendingSchema = z.object({ input: InvocationSchema, previous: RuntimeGitCheckpointSchema, mutations: z.array(z.object({ path: z.string(), content: z.string().nullable() })) });
const MachinePendingSchema = z.object({ checkpoint: RuntimeGitCheckpointSchema, previous: z.string().nullable(), current: RuntimeGitCheckpointSchema.nullable(), base: RuntimeGitCheckpointSchema.nullable(), machineId: z.string() });
const RetentionCheckpointSchema = RuntimeGitCheckpointSchema.extend({ publicationId: z.string().optional(), acceptedPublicationIds: z.array(z.string()).optional() });
const CLOUD_FILE_READ_LIMIT = 8 * 1024 * 1024;
const LFS_POINTER_LIMIT = 1024;

function assertCloudReadSize(size: number, path: string): void {
  if (size > CLOUD_FILE_READ_LIMIT) throw new Error(`File ${path} (${size} bytes) exceeds the 8 MiB cloud read limit; use a machine to read its content.`);
}

/** The committed environment definition must stay loadable: an edit that breaks its schema never reaches the working copy. */
function assertValidMutations(mutations: z.infer<typeof PendingSchema>['mutations']): void {
  for (const mutation of mutations) if (mutation.path === '.gitspace/bundle.json' && mutation.content !== null) parseEnvironmentBundleJson(mutation.content);
}

const checkpointIdentity = (checkpoint: Checkpoint) => canonicalJson({ ...checkpoint, ...(checkpoint.lfs ? { lfs: { ...checkpoint.lfs, objects: checkpoint.lfs.objects.map(({ oid, size }) => ({ oid, size })) } } : {}) });
/** A text page without a range: at most this many lines and characters. With the blank line and note after it, a page
 * is 2,000 lines, which the agent harness keeps whole. */
const TEXT_PAGE_LINES = 1_998;
const TEXT_PAGE_CHARACTERS = 40_000;
/** The lines a text read asked for; with no limit, one page and a note naming where the rest starts, so a long file or
 * converted document never fills a context. */
export function textPage(text: string, offset?: number, limit?: number): string {
  const lines = text.split('\n');
  const start = (offset ?? 1) - 1;
  let end = start + (limit ?? TEXT_PAGE_LINES);
  if (limit === undefined) {
    let characters = 0;
    for (let index = start; index < Math.min(end, lines.length); index++) {
      characters += lines[index]!.length + 1;
      if (characters > TEXT_PAGE_CHARACTERS) { end = Math.max(index, start + 1); break; }
    }
  }
  const page = lines.slice(start, end).join('\n');
  return lines.length > end ? `${page}\n\n[${lines.length - end} more lines; read again with offset ${end + 1}]` : page;
}
export class CloudPublicationUncertain extends TaggedError('CloudPublicationUncertain')<{ attemptId: string; message: string }> {}
/** The provider proved the machine publication never reached the checkpoint ref. */
export class MachinePublicationRejected extends TaggedError('MachinePublicationRejected')<{ attemptId: string; message: string }> {}

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
/** Durable publication serialization belongs to the cloud, never to a machine. */
export class CloudFileStore {
  private readonly running = new Map<string, Promise<RuntimeToolResult>>();
  private readonly machineRunning = new Map<string, Promise<Checkpoint>>();
  private retaining: Promise<void> | undefined;
  private admission: Promise<void> = Promise.resolve();
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.admission.then(operation);
    this.admission = result.then(() => {}, () => {});
    return result;
  }
  constructor(private readonly storage: DurableObjectStorage, _attachments: Pick<AttachmentStore, 'list'>, private readonly code: Pick<ArtifactsCodeStore, 'readFile' | 'writeSnapshot' | 'mergeSnapshot' | 'listSnapshotPaths'>, private readonly workspaceId: string, private readonly publish: (source?: string) => void, private readonly lfs: GitLfsStore, private readonly retainLfs: (checkpoint: Checkpoint, publicationId?: string) => Promise<void>, private readonly initialCheckpoint?: () => Promise<Checkpoint | null>, private readonly documentMarkdown?: (name: string, bytes: Uint8Array<ArrayBuffer>) => Promise<string | null>) {
    storage.sql.exec('DROP TABLE IF EXISTS runtime_cloud_writer');
    storage.sql.exec('CREATE TABLE IF NOT EXISTS runtime_cloud_files(id TEXT PRIMARY KEY, input TEXT NOT NULL, pending TEXT, result TEXT)');
    storage.sql.exec('CREATE INDEX IF NOT EXISTS runtime_cloud_files_pending ON runtime_cloud_files(id) WHERE pending IS NOT NULL');
    storage.sql.exec('CREATE TABLE IF NOT EXISTS runtime_code_snapshot(singleton INTEGER PRIMARY KEY CHECK(singleton=1), checkpoint TEXT NOT NULL)');
    storage.sql.exec('CREATE TABLE IF NOT EXISTS runtime_code_commits(commit_id TEXT PRIMARY KEY, predecessor TEXT, checkpoint TEXT NOT NULL)');
    storage.sql.exec('CREATE TABLE IF NOT EXISTS runtime_lfs_retention_outbox(commit_id TEXT PRIMARY KEY, checkpoint TEXT NOT NULL, previous TEXT)');
    storage.sql.exec('CREATE TABLE IF NOT EXISTS runtime_machine_publications(id TEXT PRIMARY KEY, input TEXT NOT NULL, pending TEXT, checkpoint TEXT)');
    if (storage.sql.exec<{ name: string }>('PRAGMA table_info(runtime_machine_publications)').toArray().some(column => column.name === 'abandoned')) storage.sql.exec('ALTER TABLE runtime_machine_publications DROP COLUMN abandoned');
    storage.sql.exec('CREATE INDEX IF NOT EXISTS runtime_machine_publications_pending ON runtime_machine_publications(id) WHERE pending IS NOT NULL');
    storage.sql.exec('CREATE TABLE IF NOT EXISTS runtime_snapshot_paths(commit_id TEXT PRIMARY KEY, paths TEXT NOT NULL)');
  }
  snapshot(): Promise<Checkpoint | null> { return readCurrentCheckpoint(this.storage); }
  /** Snapshots published from `ancestor` to `descendant` along recorded predecessors; null past `limit` or across an
   * unrecorded history. */
  snapshotDistance(ancestor: string, descendant: string, limit: number): number | null {
    let commit: string | null = descendant;
    for (let steps = 0; commit !== null && steps <= limit; steps++) {
      if (commit === ancestor) return steps;
      commit = this.storage.sql.exec<{ predecessor: string | null }>('SELECT predecessor FROM runtime_code_commits WHERE commit_id=?', commit).toArray()[0]?.predecessor ?? null;
    }
    return null;
  }
  /** A base-branch change runs in the same queue as cloud edits and cache publications. */
  changeBranch<T>(input: {
    checkpoint: Checkpoint;
    validate(current: Checkpoint): Promise<void>;
    prepare(current: Checkpoint): Promise<void>;
    publish(current: Checkpoint): Promise<void>;
    commit(): Promise<T>;
  }): Promise<T> {
    return this.serialize(async () => {
      const current = await this.initializeSnapshot();
      if (!current) throw new Error('Base workspace has no committed checkout');
      await input.validate(current);
      await input.prepare(current);
      await input.publish(current);
      if (checkpointIdentity(current) !== checkpointIdentity(input.checkpoint)) this.storage.transactionSync(() => {
        this.recordCommit(input.checkpoint, current.worktreeCommit);
        this.enqueueRetention(input.checkpoint, current);
        this.storage.sql.exec('UPDATE runtime_code_snapshot SET checkpoint=? WHERE singleton=1', JSON.stringify(input.checkpoint));
      });
      await this.flushRetention();
      const result = await input.commit();
      this.publish();
      return result;
    });
  }
  /** Explicit source initialization for file execution and attachment admission; snapshot stays read-only. */
  async initializeSnapshot(): Promise<Checkpoint | null> {
    const current = await this.snapshot();
    if (current) {
      if (!this.storage.sql.exec('SELECT commit_id FROM runtime_code_commits WHERE commit_id=?', current.worktreeCommit).toArray().length) this.recordCommit(current, null);
      await this.flushRetention(); return current;
    }
    if (!this.initialCheckpoint) return null;
    const source = await this.initialCheckpoint();
    if (!source) return null;
    const checkpoint = RuntimeGitCheckpointSchema.parse(source);
    const accepted = this.storage.transactionSync(() => {
      const row = this.storage.sql.exec<{ checkpoint: string }>('SELECT checkpoint FROM runtime_code_snapshot WHERE singleton=1').toArray()[0];
      if (row) return { checkpoint: RuntimeGitCheckpointSchema.parse(JSON.parse(row.checkpoint)), created: false };
      this.recordCommit(checkpoint, null);
      this.enqueueRetention(checkpoint, null);
      this.storage.sql.exec('INSERT INTO runtime_code_snapshot(singleton,checkpoint) VALUES(1,?)', JSON.stringify(checkpoint));
      return { checkpoint, created: true };
    });
    // The first snapshot is published like every later one: its projection, its indexing and its machines follow it.
    if (accepted?.created) this.publish();
    await this.flushRetention();
    return accepted?.checkpoint ?? null;
  }
  /** Authorization precedes durable intent; accepted publication recovery is noncancellable. */
  commitMachine(checkpoint: Checkpoint, previous: string | null, machineId: string, authorize?: () => void): Promise<Checkpoint> {
    const id = `${machineId}:${checkpoint.checkpointRef}:${checkpoint.worktreeCommit}`;
    const identity = canonicalJson({ checkpoint, previous, machineId });
    const active = this.machineRunning.get(id);
    if (active) return active.then(accepted => {
      const saved = this.storage.sql.exec<{ input: string }>('SELECT input FROM runtime_machine_publications WHERE id=?', id).toArray()[0];
      if (saved?.input !== identity) throw new Error('Machine snapshot publication identity changed');
      return accepted;
    });
    const publication = this.serialize(() => this.publishMachine(id, identity, checkpoint, previous, machineId, authorize)).finally(() => this.machineRunning.delete(id));
    this.machineRunning.set(id, publication);
    return publication;
  }
  private async publishMachine(id: string, identity: string, checkpoint: Checkpoint, previous: string | null, machineId: string, authorize?: () => void): Promise<Checkpoint> {
    const saved = this.storage.sql.exec<{ input: string; pending: string | null; checkpoint: string | null }>('SELECT input,pending,checkpoint FROM runtime_machine_publications WHERE id=?', id).toArray()[0];
    if (saved && saved.input !== identity) throw new Error('Machine snapshot publication identity changed');
    if (saved?.checkpoint) { await this.flushRetention(); return RuntimeGitCheckpointSchema.parse(JSON.parse(saved.checkpoint)); }
    const stored = saved?.pending ? MachinePendingSchema.parse(JSON.parse(saved.pending)) : null;
    const current = await this.snapshot();
    // A cloud version accepted after a stored plan was made proves the plan never landed: every write moves the
    // checkpoint ref from the recorded version, so the cloud's write would have been refused had this one moved it.
    // Resuming it would fail on the moved ref forever; it is planned again against the current version.
    const stale = stored !== null && (stored.current ? checkpointIdentity(stored.current) : null) !== (current ? checkpointIdentity(current) : null);
    let pending: z.infer<typeof MachinePendingSchema>;
    if (stored && !stale) pending = stored;
    else {
      const row = previous ? this.storage.sql.exec<{ checkpoint: string }>('SELECT checkpoint FROM runtime_code_commits WHERE commit_id=?', previous).toArray()[0] : undefined;
      const base = previous === current?.worktreeCommit ? current : row ? RuntimeGitCheckpointSchema.parse(JSON.parse(row.checkpoint)) : null;
      if (current && (!previous || !base)) throw new Error('Snapshot publication has an unknown predecessor');
      if (!current && previous !== null) throw new Error('Initial snapshot publication requires a null predecessor');
      pending = { checkpoint, previous, current, base, machineId };
      this.storage.transactionSync(() => {
        authorize?.();
        const latest = this.storage.sql.exec<{ checkpoint: string }>('SELECT checkpoint FROM runtime_code_snapshot WHERE singleton=1').toArray()[0];
        if ((latest ? checkpointIdentity(RuntimeGitCheckpointSchema.parse(JSON.parse(latest.checkpoint))) : null) !== (current ? checkpointIdentity(current) : null)) throw new Error('Canonical snapshot changed before machine publication');
        this.storage.sql.exec('INSERT OR REPLACE INTO runtime_machine_publications(id,input,pending) VALUES(?,?,?)', id, identity, JSON.stringify(pending));
      });
    }
    try { await this.storage.sync(); return await this.finishMachine(id, pending); }
    catch (error) { throw error instanceof CloudPublicationUncertain ? error : new CloudPublicationUncertain({ attemptId: `machine:${id}`, message: error instanceof Error ? error.message : String(error) }); }
  }

  /** Before a machine's attachment is released, settle every publication it admitted: one in flight finishes, one left
   * durably pending resumes, and one the provider proved unpublished is forgotten and reported.
   * Returns why a publication did not settle, for the released attachment's record. */
  async settleMachine(machineId: string): Promise<string | null> {
    await Promise.allSettled([...this.machineRunning].filter(([id]) => id.startsWith(`${machineId}:refs/`)).map(([, publication]) => publication));
    let failure: string | null = null;
    for (const row of this.storage.sql.exec<{ id: string; pending: string }>('SELECT id,pending FROM runtime_machine_publications WHERE pending IS NOT NULL').toArray()) {
      const pending = MachinePendingSchema.parse(JSON.parse(row.pending));
      if (pending.machineId !== machineId) continue;
      try { await this.resumeMachine(row.id, pending); }
      catch (error) {
        if (!(error instanceof MachinePublicationRejected)) {
          failure = `Snapshot publication ${row.id} remains pending recovery: ${error instanceof Error ? error.message : String(error)}`;
          continue;
        }
        failure = `Snapshot publication ${row.id} was not published: ${error.message}`;
        this.storage.sql.exec('DELETE FROM runtime_machine_publications WHERE id=? AND pending IS NOT NULL', row.id);
        await this.storage.sync();
      }
    }
    return failure;
  }
  private resumeMachine(id: string, pending: z.infer<typeof MachinePendingSchema>): Promise<Checkpoint> {
    const active = this.machineRunning.get(id);
    if (active) return active;
    const resumed = this.finishMachine(id, pending).finally(() => this.machineRunning.delete(id));
    this.machineRunning.set(id, resumed);
    return resumed;
  }
  private async finishMachine(id: string, pending: z.infer<typeof MachinePendingSchema>): Promise<Checkpoint> {
    const { checkpoint, previous, current, base, machineId } = pending;
    const merged = await this.code.mergeSnapshot({ repository: artifactsWorkspaceRepository(this.workspaceId), workspaceId: this.workspaceId, previous: current ?? checkpoint, base: base ?? checkpoint, machine: checkpoint, forcePublication: current === null });
    // The step is named in the message: the provider's own errors ("An internal error occurred.") do not say which call failed.
    if (merged.isErr()) {
      const message = `${merged.error.operation}: ${merged.error.message}`;
      throw merged.error.certainty === 'not-published' ? new MachinePublicationRejected({ attemptId: `machine:${id}`, message }) : new CloudPublicationUncertain({ attemptId: `machine:${id}`, message });
    }
    const accepted = merged.value;
    const paths = await this.code.listSnapshotPaths(artifactsWorkspaceRepository(this.workspaceId), accepted.worktreeTree).catch((error: unknown) => {
      throw new Error(`listSnapshotPaths: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    });
    this.storage.transactionSync(() => {
      if (current && !this.storage.sql.exec('SELECT commit_id FROM runtime_code_commits WHERE commit_id=?', current.worktreeCommit).toArray().length) this.recordCommit(current, null);
      if (accepted.worktreeCommit !== current?.worktreeCommit) this.recordCommit(accepted, current?.worktreeCommit ?? previous);
      if (accepted.worktreeCommit !== checkpoint.worktreeCommit && checkpoint.worktreeCommit !== current?.worktreeCommit) this.recordCommit(checkpoint, previous);
      this.enqueueRetention(accepted, current);
      this.enqueueRetention(checkpoint, current, `${machineId}:${checkpoint.checkpointRef}`);
      this.storage.sql.exec('INSERT OR REPLACE INTO runtime_code_snapshot(singleton,checkpoint) VALUES(1,?)', JSON.stringify(accepted));
      this.storage.sql.exec('INSERT INTO runtime_snapshot_paths(commit_id,paths) VALUES(?,?) ON CONFLICT(commit_id) DO UPDATE SET paths=excluded.paths WHERE paths IS NOT excluded.paths', accepted.worktreeCommit, JSON.stringify(paths));
      this.storage.sql.exec('UPDATE runtime_machine_publications SET pending=NULL,checkpoint=? WHERE id=?', JSON.stringify(accepted), id);
    });
    // The publishing machine installs the accepted snapshot from this answer.
    await this.storage.sync(); await this.flushRetention(); this.publish(machineId); return accepted;
  }
  execute(raw: Invocation, signal?: AbortSignal): Promise<RuntimeToolResult> {
    const input = InvocationSchema.parse(raw);
    const active = this.running.get(input.attemptId);
    if (active) return active.then(result => { this.assertIdentity(input); return result; });
    const operation = () => this.run(input, signal);
    // Reads wait for every mutation admitted before them, so an agent reads its own writes; they never hold the queue.
    const promise = (input.tool === 'read' || input.tool === 'find' ? this.admission.then(operation) : this.serialize(operation)).catch(error => {
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
    if (saved?.result) { await this.flushRetention(); return RuntimeToolResultSchema.parse(JSON.parse(saved.result)); }
    if (saved?.pending) return this.finish(PendingSchema.parse(JSON.parse(saved.pending)));
    const result = (status: 'completed' | 'failed', text: string): RuntimeToolResult => {
      const content: RuntimeToolResult['content'] = [{ type: 'text', text }];
      return status === 'failed'
        ? { requestId: input.requestId, attemptId: input.attemptId, status, content, error: { code: 'HOST_OPERATION_FAILED', message: text } }
        : { requestId: input.requestId, attemptId: input.attemptId, status, content };
    };
    let pending: z.infer<typeof PendingSchema> | undefined;
    try {
      signal?.throwIfAborted();
      const readOnly = input.tool === 'read' || input.tool === 'find';
      const previous = readOnly ? await this.snapshot() ?? await this.initializeSnapshot() : await this.initializeSnapshot();
      if (!previous) throw new Error('Workspace has no committed source snapshot');
      const path = input.tool === 'find' || input.tool === 'apply_patch' ? '' : PathSchema.parse(input.args).path.replace(/^\.\//u, '');
      if (path) validateSnapshotPath(path);
      this.storage.sql.exec('INSERT OR IGNORE INTO runtime_cloud_files(id,input) VALUES(?,?)', input.attemptId, canonicalJson(input));
      if (input.tool === 'find') {
        const args = RuntimeFindArgumentsSchema.parse(input.args);
        const root = args.path.replace(/^\.\//u, '').replace(/\/$/u, '');
        if (root && root !== '.') validateSnapshotPath(root);
        const paths = await this.paths(previous);
        const matches = paths.filter(candidate => (!root || root === '.' || candidate === root || candidate.startsWith(`${root}/`)) && attributeMatches(args.pattern, candidate));
        const completed = result('completed', matches.join('\n'));
        this.complete(input, completed); return completed;
      }
      if (input.tool === 'apply_patch') {
        const args = ApplyPatchArgumentsSchema.parse(input.args);
        const changes = await prepareV4APatch(args.patch, {
          exists: async candidate => { validateSnapshotPath(candidate); return (await this.code.readFile(artifactsWorkspaceRepository(this.workspaceId), previous.worktreeCommit, candidate)) !== null; },
          read: async candidate => {
            validateSnapshotPath(candidate);
            const blob = await this.code.readFile(artifactsWorkspaceRepository(this.workspaceId), previous.worktreeCommit, candidate);
            if (!blob) throw new Error(`File not found: ${candidate}`);
            assertCloudReadSize(blob.size, candidate);
            return new TextDecoder('utf-8', { fatal: true }).decode(await blob.arrayBuffer());
          },
        });
        const mutations: z.infer<typeof PendingSchema>['mutations'] = [];
        for (const change of changes) {
          for (const candidate of [change.path, ...(change.destination ? [change.destination] : [])]) {
            validateSnapshotPath(candidate);
            if (await this.isLfsPath(previous, candidate) || await this.hasLfsPointer(previous, candidate) || previous.lfs?.heldBack.some(entry => entry.path === candidate)) throw new Error(`LFS file ${candidate} cannot be patched in the cloud; use a machine.`);
          }
          if (change.destination) mutations.push({ path: change.path, content: null });
          mutations.push({ path: change.destination ?? change.path, content: change.after });
        }
        assertValidMutations(mutations);
        pending = { input, previous, mutations };
        this.storage.sql.exec('UPDATE runtime_cloud_files SET pending=? WHERE id=?', JSON.stringify(pending), input.attemptId);
        await this.storage.sync();
        return this.finish(pending);
      }
      const trackedLfs = await this.isLfsPath(previous, path);
      const read = async () => {
        const blob = await this.code.readFile(artifactsWorkspaceRepository(this.workspaceId), previous.worktreeCommit, path);
        if (!blob) throw new Error(`File not found: ${path}`);
        assertCloudReadSize(blob.size, path);
        return new Uint8Array(await blob.arrayBuffer());
      };
      if (input.tool === 'read') {
        const parsed = RuntimeReadArgumentsSchema.parse(input.args);
        let bytes: Uint8Array<ArrayBuffer> = await read();
        const pointer = bytes.byteLength <= LFS_POINTER_LIMIT ? parseGitLfsPointer(bytes) : null;
        if (pointer) {
          assertCloudReadSize(pointer.size, path);
          const payload = await this.lfs.get(pointer);
          if (!payload) throw new Error(`LFS file ${path} (${pointer.size} bytes) needs a machine to download its content from origin.`);
          const hash = sha256.create();
          const expected = pointer;
          async function* verified(source: AsyncIterable<Uint8Array>) {
            let size = 0;
            for await (const chunk of source) {
              signal?.throwIfAborted();
              size += chunk.byteLength;
              if (size > expected.size) throw new Error(`LFS content verification failed for ${path}`);
              hash.update(chunk);
              yield chunk;
            }
            signal?.throwIfAborted();
            if (size !== expected.size || bytesToHex(hash.digest()) !== expected.oid) throw new Error(`LFS content verification failed for ${path}`);
          }
          bytes = await collectBytes(verified(payload), expected.size);
        } else if (trackedLfs) throw new Error(`LFS file ${path} needs a machine to restore committed content.`);
        const prefix = new TextDecoder().decode(bytes.subarray(0, 12));
        const mimeType = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 ? 'image/png' : bytes[0] === 0xff && bytes[1] === 0xd8 ? 'image/jpeg' : prefix.startsWith('GIF8') ? 'image/gif' : prefix.startsWith('RIFF') && prefix.slice(8, 12) === 'WEBP' ? 'image/webp' : null;
        let completed: RuntimeToolResult;
        const document = mimeType ? null : await this.documentMarkdown?.(path.split('/').at(-1) ?? path, bytes);
        if (mimeType) {
          let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
          completed = { ...result('completed', ''), content: [{ type: 'image', mimeType, data: btoa(binary) }] };
        } else {
          completed = result('completed', textPage(document ?? new TextDecoder('utf-8', { fatal: true }).decode(bytes), parsed.offset, parsed.limit));
        }
        this.complete(input, completed); return completed;
      }
      if (trackedLfs || await this.hasLfsPointer(previous, path) || previous.lfs?.heldBack.some(entry => entry.path === path)) throw new Error(`LFS file ${path} cannot be ${input.tool === 'write' ? 'written' : 'edited'} in the cloud; use a machine and commit the LFS change.`);
      let content: string;
      if (input.tool === 'write') content = RuntimeWriteArgumentsSchema.parse(input.args).content;
      else {
        const { edits } = RuntimeEditArgumentsSchema.parse(input.args);
        content = applyTextEdits(new TextDecoder('utf-8', { fatal: true }).decode(await read()), edits);
      }
      const mutations = [{ path, content }];
      assertValidMutations(mutations);
      pending = { input, previous, mutations };
      this.storage.sql.exec('UPDATE runtime_cloud_files SET pending=? WHERE id=?', JSON.stringify(pending), input.attemptId);
      await this.storage.sync();
    } catch (error) {
      const failed = result('failed', error instanceof Error ? error.message : String(error));
      this.storage.transactionSync(() => {
        const row = this.assertIdentity(input);
        if (row?.pending) throw new CloudPublicationUncertain({ attemptId: input.attemptId, message: 'Cloud publication is durably pending after a storage failure' });
        this.storage.sql.exec('INSERT OR IGNORE INTO runtime_cloud_files(id,input,result) VALUES(?,?,?)', input.attemptId, canonicalJson(input), JSON.stringify(failed));
        this.storage.sql.exec('UPDATE runtime_cloud_files SET result=? WHERE id=? AND pending IS NULL', JSON.stringify(failed), input.attemptId);
      });
      return failed;
    }
    return this.finish(pending);
  }
  private async finish(pending: z.infer<typeof PendingSchema>): Promise<RuntimeToolResult> {
    const { input, previous } = pending;
    // Derived only from the durable pending record, so a recovered publication reproduces the same commit.
    const supplied = input.tool === 'write' ? RuntimeWriteArgumentsSchema.parse(input.args).message : input.tool === 'edit' ? RuntimeEditArgumentsSchema.parse(input.args).message : input.tool === 'apply_patch' ? ApplyPatchArgumentsSchema.parse(input.args).message : undefined;
    const changed = [...new Set(pending.mutations.map(mutation => mutation.path))];
    const subject = supplied ?? `${input.tool} ${changed.length <= 3 ? changed.join(', ') : `${changed.slice(0, 3).join(', ')} and ${changed.length - 3} more`}`;
    const written = await this.code.writeSnapshot({ repository: artifactsWorkspaceRepository(this.workspaceId), workspaceId: this.workspaceId, previous, message: `${subject}\n\nGitSpace-Tool: ${input.tool}\n`, mutations: pending.mutations.map(mutation => ({ path: mutation.path, content: mutation.content === null ? null : new TextEncoder().encode(mutation.content) })) });
    if (written.isErr()) {
      if (written.error.certainty === 'unknown') throw new CloudPublicationUncertain({ attemptId: input.attemptId, message: written.error.message });
      const failed: RuntimeToolResult = { requestId: input.requestId, attemptId: input.attemptId, status: 'failed', content: [{ type: 'text', text: written.error.message }], error: { code: 'HOST_OPERATION_FAILED', message: written.error.message } };
      this.complete(input, failed);
      await this.storage.sync();
      return failed;
    }
    const completed: RuntimeToolResult = { requestId: input.requestId, attemptId: input.attemptId, status: 'completed', content: [{ type: 'text', text: `${input.tool === 'write' ? 'Wrote' : input.tool === 'apply_patch' ? 'Patched' : 'Edited'} ${pending.mutations.map(mutation => mutation.path).join(', ')}` }] };
    const paths = new Set(await this.paths(previous));
    for (const mutation of pending.mutations) { if (mutation.content === null) paths.delete(mutation.path); else paths.add(mutation.path); }
    this.storage.transactionSync(() => {
      const row = this.storage.sql.exec<{ checkpoint: string }>('SELECT checkpoint FROM runtime_code_snapshot WHERE singleton=1').toArray()[0];
      const current = row ? RuntimeGitCheckpointSchema.parse(JSON.parse(row.checkpoint)) : null;
      if (!current || checkpointIdentity(current) !== checkpointIdentity(previous)) throw new Error('Cloud snapshot predecessor changed');
      const origin = new Map(current.lfs?.objects.filter(object => object.source === 'origin').map(object => [object.oid, object]));
      const accepted = { ...written.value, ...(written.value.lfs ? { lfs: { ...written.value.lfs, objects: written.value.lfs.objects.map(object => { const confirmed = origin.get(object.oid); return confirmed?.size === object.size ? confirmed : object; }) } } : {}) };
      if (checkpointIdentity(accepted) !== checkpointIdentity(previous)) this.recordCommit(accepted, previous.worktreeCommit);
      this.enqueueRetention(accepted, current);
      this.complete(input, completed);
      this.storage.sql.exec('UPDATE runtime_code_snapshot SET checkpoint=? WHERE singleton=1', JSON.stringify(accepted));
      this.storage.sql.exec('INSERT INTO runtime_snapshot_paths(commit_id,paths) VALUES(?,?) ON CONFLICT(commit_id) DO UPDATE SET paths=excluded.paths WHERE paths IS NOT excluded.paths', accepted.worktreeCommit, JSON.stringify([...paths].sort()));
    });
    await this.storage.sync(); await this.flushRetention(); this.publish(); return completed;
  }
  private async paths(checkpoint: Checkpoint): Promise<string[]> {
    const saved = this.storage.sql.exec<{ paths: string }>('SELECT paths FROM runtime_snapshot_paths WHERE commit_id=?', checkpoint.worktreeCommit).toArray()[0];
    if (saved) return z.array(z.string()).parse(JSON.parse(saved.paths));
    const paths = await this.code.listSnapshotPaths(artifactsWorkspaceRepository(this.workspaceId), checkpoint.worktreeTree);
    this.storage.sql.exec('INSERT OR IGNORE INTO runtime_snapshot_paths(commit_id,paths) VALUES(?,?)', checkpoint.worktreeCommit, JSON.stringify(paths));
    return paths;
  }
  private async hasLfsPointer(checkpoint: Checkpoint, path: string): Promise<boolean> {
    const blob = await this.code.readFile(artifactsWorkspaceRepository(this.workspaceId), checkpoint.worktreeCommit, path);
    return blob !== null && blob.size <= LFS_POINTER_LIMIT && parseGitLfsPointer(new Uint8Array(await blob.arrayBuffer())) !== null;
  }
  private async isLfsPath(checkpoint: Checkpoint, path: string): Promise<boolean> {
    if (!checkpoint.headCommit) return false;
    const parts = path.split('/');
    let filter: string | null = null;
    const macros = new Map<string, string[]>();
    for (let depth = 0; depth < parts.length; depth++) {
      const directory = parts.slice(0, depth).join('/');
      const blob = await this.code.readFile(artifactsWorkspaceRepository(this.workspaceId), checkpoint.headCommit, `${directory ? `${directory}/` : ''}.gitattributes`);
      if (!blob) continue;
      assertCloudReadSize(blob.size, `${directory ? `${directory}/` : ''}.gitattributes`);
      for (const line of (await blob.text()).split(/\r?\n/u)) {
        const tokens = attributeTokens(line);
        const pattern = tokens.shift();
        if (!pattern || pattern.startsWith('#') || pattern.startsWith('!')) continue;
        if (pattern.startsWith('[attr]')) { if (depth === 0) macros.set(pattern.slice(6), tokens); continue; }
        if (!attributeMatches(pattern, parts.slice(depth).join('/'))) continue;
        const apply = (attributes: string[], expanded = new Set<string>()) => {
          for (const attribute of attributes) {
            if (attribute.startsWith('filter=')) filter = attribute.slice(7);
            else if (attribute === '-filter' || attribute === '!filter' || attribute === 'filter') filter = null;
            else if (macros.has(attribute)) {
              if (expanded.has(attribute)) throw new Error('Recursive HEAD attributes require a machine before cloud editing');
              expanded.add(attribute); apply(macros.get(attribute)!, expanded); expanded.delete(attribute);
            }
          }
        };
        apply(tokens);
      }
    }
    return filter === 'lfs';
  }
  private recordCommit(checkpoint: Checkpoint, predecessor: string | null): void {
    const encoded = canonicalJson(checkpoint);
    const prior = this.storage.sql.exec<{ predecessor: string | null; checkpoint: string }>('SELECT predecessor,checkpoint FROM runtime_code_commits WHERE commit_id=?', checkpoint.worktreeCommit).toArray()[0];
    if (prior) {
      if (prior.predecessor !== predecessor || checkpointIdentity(RuntimeGitCheckpointSchema.parse(JSON.parse(prior.checkpoint))) !== checkpointIdentity(checkpoint)) throw new Error('Immutable checkpoint publication changed');
      return;
    }
    this.storage.sql.exec('INSERT INTO runtime_code_commits(commit_id,predecessor,checkpoint) VALUES(?,?,?)', checkpoint.worktreeCommit, predecessor, encoded);
  }
  private enqueueRetention(checkpoint: Checkpoint, previous: Checkpoint | null, publicationId?: string): void {
    this.storage.sql.exec('INSERT OR IGNORE INTO runtime_lfs_retention_outbox(commit_id,checkpoint,previous) VALUES(?,?,?)', publicationId ? `${checkpoint.worktreeCommit}:${publicationId}` : checkpoint.worktreeCommit, JSON.stringify({ ...checkpoint, ...(publicationId ? { publicationId } : {}) }), previous ? JSON.stringify(previous) : null);
  }
  async flushRetention(): Promise<void> {
    do {
      this.retaining ??= this.drainRetention().finally(() => { this.retaining = undefined; });
      await this.retaining;
    } while (this.storage.sql.exec('SELECT commit_id FROM runtime_lfs_retention_outbox LIMIT 1').toArray().length > 0);
  }
  private async drainRetention(): Promise<void> {
    await this.storage.sync();
    for (;;) {
      const row = this.storage.sql.exec<{ commit_id: string; checkpoint: string }>('SELECT commit_id,checkpoint FROM runtime_lfs_retention_outbox ORDER BY rowid LIMIT 1').toArray()[0];
      if (!row) return;
      const { publicationId, acceptedPublicationIds: _acceptedPublicationIds, ...checkpoint } = RetentionCheckpointSchema.parse(JSON.parse(row.checkpoint));
      await this.retainLfs(checkpoint, publicationId);
      this.storage.sql.exec('DELETE FROM runtime_lfs_retention_outbox WHERE commit_id=? AND checkpoint=?', row.commit_id, row.checkpoint);
      await this.storage.sync();
    }
  }
  lfsRoots(): Checkpoint[] { return readRuntimeLfsRoots(this.storage); }
  reconcileLfsSources(objects: readonly GitLfsConfirmedObject[]): Promise<void> { return reconcileRuntimeLfsSources(this.storage, objects); }
  private complete(input: Invocation, result: RuntimeToolResult): void {
    this.storage.sql.exec('UPDATE runtime_cloud_files SET pending=NULL,result=? WHERE id=?', JSON.stringify(result), input.attemptId);
  }
}

/** Inspect durable roots without constructing a runtime or executing retention callbacks. */
export function readRuntimeLfsRoots(storage: DurableObjectStorage): Checkpoint[] {
  const tables = new Set(storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'").toArray().map(row => row.name));
  const roots: Checkpoint[] = [];
  const add = (encoded: string | null) => { if (encoded) roots.push(RuntimeGitCheckpointSchema.parse(JSON.parse(encoded))); };
  if (tables.has('runtime_code_snapshot')) for (const row of storage.sql.exec<{ checkpoint: string }>('SELECT checkpoint FROM runtime_code_snapshot')) add(row.checkpoint);
  if (tables.has('runtime_lfs_retention_outbox')) for (const row of storage.sql.exec<{ checkpoint: string; previous: string | null }>('SELECT checkpoint,previous FROM runtime_lfs_retention_outbox')) { add(row.checkpoint); add(row.previous); }
  if (tables.has('runtime_cloud_files')) for (const row of storage.sql.exec<{ pending: string }>('SELECT pending FROM runtime_cloud_files WHERE pending IS NOT NULL')) roots.push(PendingSchema.parse(JSON.parse(row.pending)).previous);
  if (tables.has('runtime_machine_publications')) for (const row of storage.sql.exec<{ pending: string }>('SELECT pending FROM runtime_machine_publications WHERE pending IS NOT NULL')) {
    const pending = MachinePendingSchema.parse(JSON.parse(row.pending));
    roots.push(pending.checkpoint);
    if (pending.current) roots.push(pending.current);
    if (pending.base) roots.push(pending.base);
  }
  return roots;
}

/** Persist source transitions without recovery, inference, or cross-authority callbacks. */
export async function reconcileRuntimeLfsSources(storage: DurableObjectStorage, objects: readonly GitLfsConfirmedObject[]): Promise<void> {
  const tables = new Set(storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'").toArray().map(row => row.name));
  const confirmed = new Map(objects.map(object => [object.oid, object]));
  const transition = (checkpoint: Checkpoint): Checkpoint => ({ ...checkpoint, ...(checkpoint.lfs ? { lfs: { ...checkpoint.lfs, objects: checkpoint.lfs.objects.map(object => { const origin = confirmed.get(object.oid); return origin?.size === object.size ? { ...object, source: 'origin' as const, location: origin.location } : object; }) } } : {}) });
  const encoded = (value: string) => JSON.stringify(transition(RetentionCheckpointSchema.parse(JSON.parse(value))));
  // Only rows whose encoding changes are written; a row already transitioned reads the same.
  storage.transactionSync(() => {
    if (tables.has('runtime_code_snapshot')) for (const row of storage.sql.exec<{ checkpoint: string }>('SELECT checkpoint FROM runtime_code_snapshot').toArray()) {
      const checkpoint = encoded(row.checkpoint);
      if (checkpoint !== row.checkpoint) storage.sql.exec('UPDATE runtime_code_snapshot SET checkpoint=? WHERE singleton=1', checkpoint);
    }
    if (tables.has('runtime_code_commits')) for (const row of storage.sql.exec<{ commit_id: string; checkpoint: string }>('SELECT commit_id,checkpoint FROM runtime_code_commits').toArray()) {
      const checkpoint = encoded(row.checkpoint);
      if (checkpoint !== row.checkpoint) storage.sql.exec('UPDATE runtime_code_commits SET checkpoint=? WHERE commit_id=?', checkpoint, row.commit_id);
    }
    if (tables.has('runtime_lfs_retention_outbox')) for (const row of storage.sql.exec<{ commit_id: string; checkpoint: string; previous: string | null }>('SELECT commit_id,checkpoint,previous FROM runtime_lfs_retention_outbox').toArray()) {
      const checkpoint = encoded(row.checkpoint), previous = row.previous ? encoded(row.previous) : null;
      if (checkpoint !== row.checkpoint || previous !== row.previous) storage.sql.exec('UPDATE runtime_lfs_retention_outbox SET checkpoint=?,previous=? WHERE commit_id=?', checkpoint, previous, row.commit_id);
    }
    if (tables.has('runtime_cloud_files')) for (const row of storage.sql.exec<{ id: string; pending: string }>('SELECT id,pending FROM runtime_cloud_files WHERE pending IS NOT NULL').toArray()) {
      const pending = PendingSchema.parse(JSON.parse(row.pending));
      const next = JSON.stringify({ ...pending, previous: transition(pending.previous) });
      if (next !== row.pending) storage.sql.exec('UPDATE runtime_cloud_files SET pending=? WHERE id=?', next, row.id);
    }
    if (tables.has('runtime_machine_publications')) for (const row of storage.sql.exec<{ id: string; pending: string | null; checkpoint: string | null }>('SELECT id,pending,checkpoint FROM runtime_machine_publications').toArray()) {
      const checkpoint = row.checkpoint && encoded(row.checkpoint);
      if (checkpoint !== row.checkpoint) storage.sql.exec('UPDATE runtime_machine_publications SET checkpoint=? WHERE id=?', checkpoint, row.id);
      if (row.pending) {
        const pending = MachinePendingSchema.parse(JSON.parse(row.pending));
        const next = JSON.stringify({ ...pending, checkpoint: transition(pending.checkpoint), current: pending.current && transition(pending.current), base: pending.base && transition(pending.base) });
        if (next !== row.pending) storage.sql.exec('UPDATE runtime_machine_publications SET pending=? WHERE id=?', next, row.id);
      }
    }
  });
  await storage.sync();
}

/** Git attributes use C-quoted patterns and whitespace-delimited attributes. */
function attributeTokens(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return [];
  if (!trimmed.startsWith('"')) {
    const match = /^((?:\\.|[^\s])+)(?:\s+(.*))?$/u.exec(trimmed);
    if (!match) throw new Error('Unsupported HEAD attributes require a machine before cloud editing');
    return [match[1]!, ...(match[2]?.split(/\s+/u) ?? [])];
  }
  const quoted = /^("(?:\\.|[^"\\])*")\s*(.*)$/u.exec(trimmed);
  if (!quoted) throw new Error('Unsupported quoted HEAD attributes require a machine before cloud editing');
  try { return [z.string().parse(JSON.parse(quoted[1]!.replace(/\\([0-7]{1,3})/gu, (_match, octal: string) => `\\u${Number.parseInt(octal, 8).toString(16).padStart(4, '0')}`))), ...quoted[2]!.split(/\s+/u)]; }
  catch { throw new Error('Unsupported quoted HEAD attributes require a machine before cloud editing'); }
}
function attributeMatches(pattern: string, path: string): boolean {
  if (pattern.endsWith('/')) return false;
  const anchored = pattern.includes('/');
  if (pattern.startsWith('/')) pattern = pattern.slice(1);
  const candidate = anchored ? path : path.slice(path.lastIndexOf('/') + 1);
  let expression = '^';
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index]!;
    if (char === '*') {
      if (pattern[index + 1] === '*' && (index === 0 || pattern[index - 1] === '/') && (index + 2 === pattern.length || pattern[index + 2] === '/')) {
        index++;
        if (pattern[index + 1] === '/') { expression += '(?:.*/)?'; index++; } else expression += '.*';
      } else expression += '[^/]*';
    } else if (char === '?') expression += '[^/]';
    else if (char === '[') {
      const end = pattern.indexOf(']', index + 1);
      if (end < 0) throw new Error('Unsupported HEAD attribute pattern requires a machine before cloud editing');
      const group = pattern.slice(index + 1, end);
      if (!group || group.includes('[') || group.includes('\\') || group.includes('/')) throw new Error('Unsupported HEAD attribute class requires a machine before cloud editing');
      expression += `[${group.startsWith('!') ? `^${group.slice(1)}` : group}]`; index = end;
    } else if (char === '\\' && index + 1 < pattern.length) { index++; expression += pattern[index]!.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'); }
    else expression += char.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  }
  try { return new RegExp(`${expression}$`, 'u').test(candidate); }
  catch { throw new Error('Unsupported HEAD attribute pattern requires a machine before cloud editing'); }
}
