import { z } from 'zod';
import { cloudProjectSummarySchema, cloudWorkspaceDefinitionSchema } from '@gitspace/protocol/project-authority';
import { accountDirectorySnapshotSchema, type AccountDirectorySnapshot } from '@gitspace/protocol/account-directory';
import { streamCursorSchema } from '@gitspace/protocol-sync';
import { SpaceAuthorityRecordSchema } from '@gitspace/protocol-workspace';
import type { CloudProjectSummary } from '@gitspace/protocol';
import type { UserProjectIndexDO } from './project-authority.js';

export const directoryPublicationSchema = z.discriminatedUnion('source', [
  z.object({ source: z.literal('project'), cursor: streamCursorSchema, project: cloudProjectSummarySchema, workspaces: z.array(cloudWorkspaceDefinitionSchema) }),
  z.object({ source: z.literal('space'), cursor: streamCursorSchema, state: SpaceAuthorityRecordSchema }),
  z.object({ source: z.literal('fleet'), cursor: streamCursorSchema, machines: accountDirectorySnapshotSchema.shape.machines }),
]);
export type DirectoryPublication = z.infer<typeof directoryPublicationSchema>;
export type DirectorySource = DirectoryPublication extends infer P ? P extends DirectoryPublication ? Omit<P, 'cursor'> : never : never;
interface SourceRow extends Record<string, SqlStorageValue> { cursor: number; value_json: string }
interface OutboxRow extends SourceRow { attempts: number }

/** One coalescing outbox per authority. Full source snapshots make supersession safe. */
export class DirectoryOutbox {
  private running: Promise<void> | null = null;
  constructor(private readonly ctx: DurableObjectState, private readonly env: Env) {
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS directory_outbox(
      singleton INTEGER PRIMARY KEY CHECK(singleton=1), cursor INTEGER NOT NULL, value_json TEXT, attempts INTEGER NOT NULL DEFAULT 0
    )`);
  }
  head(): number {
    return this.ctx.storage.sql.exec<{ cursor: number }>('SELECT cursor FROM directory_outbox WHERE singleton=1').toArray()[0]?.cursor ?? 0;
  }
  /** Must be called inside the authoritative mutation's transaction. */
  enqueue(value: DirectorySource): void {
    const cursor = streamCursorSchema.parse(this.head() + 1);
    this.ctx.storage.sql.exec('INSERT INTO directory_outbox(singleton,cursor,value_json,attempts) VALUES(1,?,?,0) ON CONFLICT(singleton) DO UPDATE SET cursor=excluded.cursor,value_json=excluded.value_json,attempts=0', cursor, JSON.stringify({ ...value, cursor }));
  }
  private pending(): OutboxRow | undefined {
    return this.ctx.storage.sql.exec<OutboxRow>('SELECT cursor,value_json,attempts FROM directory_outbox WHERE singleton=1 AND value_json IS NOT NULL').toArray()[0];
  }
  /** No await between the source commit and this alarm write: storage coalesces both atomically. */
  kick(): void {
    if (!this.pending()) return;
    const armed = this.ctx.storage.setAlarm(Date.now() + 1_000);
    this.ctx.waitUntil(armed.then(() => this.flush()));
  }
  async flush(): Promise<void> {
    if (this.running) return this.running;
    this.running = (async () => {
      // Drain a coalesced burst, but yield sustained writers to the durable alarm.
      for (let delivered = 0; delivered < 8; delivered++) {
        const pending = this.pending();
        if (!pending || !await this.deliver(pending)) return;
      }
    })().finally(() => { this.running = null; });
    return this.running;
  }
  private async deliver(pending: OutboxRow): Promise<boolean> {
    try {
      await (this.env.USER_PROJECTS as DurableObjectNamespace<UserProjectIndexDO>).getByName(this.env.ACCOUNT_ID)
        .publishDirectory(JSON.parse(pending.value_json) as DirectoryPublication);
      // A delayed acknowledgement may only clear the publication it acknowledged.
      this.ctx.storage.sql.exec('UPDATE directory_outbox SET value_json=NULL,attempts=0 WHERE singleton=1 AND cursor=?', pending.cursor);
      if (this.pending()) await this.ctx.storage.setAlarm(Date.now() + 1_000);
      else await this.ctx.storage.deleteAlarm();
      return true;
    } catch {
      this.ctx.storage.sql.exec('UPDATE directory_outbox SET attempts=MIN(attempts+1,6) WHERE singleton=1 AND cursor=?', pending.cursor);
      const current = this.pending();
      if (current) await this.ctx.storage.setAlarm(Date.now() + Math.min(60_000, 1_000 * 2 ** current.attempts));
      return false;
    }
  }
}

/** Projection only: source cursors fence duplicates, reordering and late migration reads. */
export class AccountDirectoryProjection {
  constructor(private readonly storage: DurableObjectStorage) {
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS directory_sources(source TEXT NOT NULL,source_id TEXT NOT NULL,cursor INTEGER NOT NULL,value_json TEXT NOT NULL,PRIMARY KEY(source,source_id));
      CREATE TABLE IF NOT EXISTS directory_metadata(name TEXT PRIMARY KEY,value INTEGER NOT NULL);`);
  }
  hydrated(): boolean {
    return this.storage.sql.exec('SELECT value FROM directory_metadata WHERE name=\'hydrated\'').toArray().length > 0;
  }
  finishHydration(): void { this.storage.sql.exec('INSERT OR IGNORE INTO directory_metadata(name,value) VALUES(\'hydrated\',1)'); }
  apply(publication: DirectoryPublication): boolean {
    const id = publication.source === 'project' ? publication.project.id : publication.source === 'space' ? publication.state.spaceId : 'fleet';
    return this.storage.sql.exec(`INSERT INTO directory_sources(source,source_id,cursor,value_json) VALUES(?,?,?,?)
      ON CONFLICT(source,source_id) DO UPDATE SET cursor=excluded.cursor,value_json=excluded.value_json WHERE excluded.cursor>directory_sources.cursor`,
    publication.source, id, publication.cursor, JSON.stringify(publication)).rowsWritten > 0;
  }
  snapshot(projects: CloudProjectSummary[]): AccountDirectorySnapshot {
    const visible = projects.filter((project) => project.lifecycle !== 'deleting');
    const ids = new Set(visible.map((project) => project.id));
    const sources = this.storage.sql.exec<SourceRow>('SELECT cursor,value_json FROM directory_sources ORDER BY source,source_id').toArray()
      .map((row) => JSON.parse(row.value_json) as DirectoryPublication);
    const workspaces: AccountDirectorySnapshot['workspaces'] = [];
    const projectRevisions: Record<string, number> = Object.fromEntries(visible.map((project) => [project.id, 0]));
    let machines: AccountDirectorySnapshot['machines'] = [];
    for (const source of sources) {
      if (source.source === 'fleet') machines = source.machines;
      if (source.source === 'project' && ids.has(source.project.id)) {
        projectRevisions[source.project.id] = source.cursor;
        workspaces.push(...source.workspaces.filter((workspace) => workspace.projectId === source.project.id));
      }
    }
    const bySpace = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
    const byMachine = new Map(machines.map((machine) => [machine.id, machine]));
    const placements: AccountDirectorySnapshot['placements'] = [];
    for (const source of sources) {
      if (source.source !== 'space') continue;
      const state = source.state;
      const definition = bySpace.get(state.spaceId);
      if (!definition || definition.projectId !== state.projectId) continue;
      const machine = state.machineId ? byMachine.get(state.machineId) : undefined;
      placements.push({ spaceId: state.spaceId, projectId: state.projectId, kind: definition.kind, holderId: state.machineId ?? 'unassigned', state: state.state, generation: state.generation,
        endpoint: machine?.state === 'online' && machine.desiredState === 'online' ? machine.rpcEndpoint : null });
    }
    return { projects: visible, workspaces, placements, machines, projectRevisions };
  }
}
