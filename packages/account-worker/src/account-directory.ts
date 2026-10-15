import { z } from 'zod';
import { cloudProjectSummarySchema, cloudWorkspaceDefinitionSchema, type CloudWorkspaceDefinition } from '@gitspace/protocol/project-authority';
import { accountDirectorySnapshotSchema, type AccountDirectorySnapshot } from '@gitspace/protocol/account-directory';
import { streamCursorSchema } from '@gitspace/protocol-sync';
import { SpaceAuthorityRecordSchema } from '@gitspace/protocol-workspace';
import { RuntimeIdentitySchema } from '@gitspace/protocol-runtime';
import type { CloudProjectSummary } from '@gitspace/protocol';
import type { UserProjectIndexDO } from './project-authority.js';

export const directoryPublicationSchema = z.discriminatedUnion('source', [
  z.object({ source: z.literal('project'), cursor: streamCursorSchema, project: cloudProjectSummarySchema, workspaces: z.array(cloudWorkspaceDefinitionSchema) }),
  /** `runtime` is set once the space has cloud runtime state; such a workspace lives in the cloud and its legacy placement is ignored. */
  z.object({ source: z.literal('space'), cursor: streamCursorSchema, state: SpaceAuthorityRecordSchema.nullable(), runtime: RuntimeIdentitySchema.nullable().default(null) }),
  z.object({ source: z.literal('fleet'), cursor: streamCursorSchema, machines: accountDirectorySnapshotSchema.shape.machines }),
]);
export type DirectoryPublication = z.infer<typeof directoryPublicationSchema>;
export type DirectorySource = DirectoryPublication extends infer P ? P extends DirectoryPublication ? Omit<P, 'cursor'> : never : never;
interface SourceRow extends Record<string, SqlStorageValue> { cursor: number; value_json: string }

/** Sends this source's current directory entry to the account's socket object after each change. A failed send is
 * logged; the source's next change sends its whole entry again. */
export class DirectoryPublisher {
  constructor(private readonly ctx: DurableObjectState, private readonly env: Env) {
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS directory_version(id INTEGER PRIMARY KEY CHECK(id=1), cursor INTEGER NOT NULL)');
    // One-time: the version continues from the retired outbox's, so the directory keeps accepting this source.
    if (ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='directory_outbox'").toArray().length) {
      ctx.storage.sql.exec('INSERT OR IGNORE INTO directory_version(id,cursor) SELECT 1,cursor FROM directory_outbox WHERE singleton=1');
      ctx.storage.sql.exec('DROP TABLE directory_outbox');
    }
  }
  version(): number {
    return this.ctx.storage.sql.exec<{ cursor: number }>('SELECT cursor FROM directory_version WHERE id=1').toArray()[0]?.cursor ?? 0;
  }
  /** After the source's change committed. */
  publish(source: DirectorySource): void {
    const cursor = streamCursorSchema.parse(this.ctx.storage.sql.exec<{ cursor: number }>('INSERT INTO directory_version(id,cursor) VALUES(1,1) ON CONFLICT(id) DO UPDATE SET cursor=cursor+1 RETURNING cursor').one().cursor);
    const publication: DirectoryPublication = { ...source, cursor };
    this.ctx.waitUntil((this.env.USER_PROJECTS as DurableObjectNamespace<UserProjectIndexDO>).getByName(this.env.ACCOUNT_ID).publishDirectory(publication)
      .then(() => undefined, (error: unknown) => console.error(JSON.stringify({ event: 'directory_publication_failed', source: source.source, message: error instanceof Error ? error.message : String(error) }))));
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
    const id = publication.source === 'project' ? publication.project.id : publication.source === 'space' ? publication.state?.spaceId ?? publication.runtime?.workspaceId : 'fleet';
    if (id === undefined) return false;
    return this.storage.sql.exec(`INSERT INTO directory_sources(source,source_id,cursor,value_json) VALUES(?,?,?,?)
      ON CONFLICT(source,source_id) DO UPDATE SET cursor=excluded.cursor,value_json=excluded.value_json WHERE excluded.cursor>directory_sources.cursor`,
    publication.source, id, publication.cursor, JSON.stringify(publication)).rowsWritten > 0;
  }
  snapshot(projects: CloudProjectSummary[]): AccountDirectorySnapshot {
    const visible = projects.filter((project) => project.lifecycle !== 'deleting');
    const ids = new Set(visible.map((project) => project.id));
    const sources = this.storage.sql.exec<SourceRow>('SELECT cursor,value_json FROM directory_sources ORDER BY source,source_id').toArray()
      .map((row) => JSON.parse(row.value_json) as DirectoryPublication);
    const definitions: CloudWorkspaceDefinition[] = [];
    const projectRevisions: Record<string, number> = Object.fromEntries(visible.map((project) => [project.id, 0]));
    let machines: AccountDirectorySnapshot['machines'] = [];
    for (const source of sources) {
      if (source.source === 'fleet') machines = source.machines;
      if (source.source === 'project' && ids.has(source.project.id)) {
        projectRevisions[source.project.id] = source.cursor;
        definitions.push(...source.workspaces.filter((workspace) => workspace.projectId === source.project.id));
      }
    }
    // Rows stored before `runtime` existed decode without it.
    const cloud = new Set<string>(sources.flatMap((source) => source.source === 'space' && source.runtime ? [source.runtime.workspaceId] : []));
    const workspaces = definitions.map((workspace) => ({ ...workspace, cloudRuntime: cloud.has(workspace.id) }));
    const bySpace = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
    const byMachine = new Map(machines.map((machine) => [machine.id, machine]));
    const placements: AccountDirectorySnapshot['placements'] = [];
    for (const source of sources) {
      if (source.source !== 'space' || !source.state) continue;
      const state = source.state;
      const definition = bySpace.get(state.spaceId);
      // A cloud workspace has no placement: machines only attach to it as execution caches.
      if (!definition || definition.projectId !== state.projectId || definition.cloudRuntime) continue;
      const machine = state.machineId ? byMachine.get(state.machineId) : undefined;
      placements.push({ spaceId: state.spaceId, projectId: state.projectId, kind: definition.kind, holderId: state.machineId ?? 'unassigned', state: state.state, generation: state.generation,
        endpoint: machine?.state === 'online' && machine.desiredState === 'online' ? machine.rpcEndpoint : null });
    }
    return { projects: visible, workspaces, placements, machines, projectRevisions };
  }
}
