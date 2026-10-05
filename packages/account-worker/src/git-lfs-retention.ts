import { z } from 'zod';
import { GitLfsObjectSchema, GitLfsSnapshotSchema, type GitLfsObject, type GitLfsLocation, type GitLfsSnapshot } from '@gitspace/protocol-workspace';

export const RetainedLfsSnapshotSchema = z.object({
  snapshotId: z.string().min(1), workspaceId: z.string().min(1), kind: z.enum(['runtime', 'portable']),
  objects: GitLfsSnapshotSchema.shape.objects,
});
export type RetainedLfsSnapshot = z.infer<typeof RetainedLfsSnapshotSchema>;

/** Project-owned inventory and pins; historical inventories are not restore roots. */
export class GitLfsRetention {
  constructor(private readonly storage: DurableObjectStorage) {
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS lfs_objects(oid TEXT PRIMARY KEY, size INTEGER NOT NULL, deleting INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS lfs_references(owner TEXT NOT NULL, oid TEXT NOT NULL, PRIMARY KEY(owner,oid));
      CREATE TABLE IF NOT EXISTS lfs_snapshots(snapshot_id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,kind TEXT NOT NULL,inventory TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS lfs_origin_sources(oid TEXT NOT NULL,size INTEGER NOT NULL,origin TEXT NOT NULL,endpoint TEXT NOT NULL,PRIMARY KEY(origin,endpoint,oid));`);
  }

  retain(owner: string, objects: readonly GitLfsObject[]): void {
    if (!owner) throw new Error('LFS retention owner is required');
    const verified = objects.map(object => GitLfsObjectSchema.parse(object));
    this.storage.transactionSync(() => {
      for (const object of verified) {
        const previous = this.storage.sql.exec<{ size: number; deleting: number }>('SELECT size,deleting FROM lfs_objects WHERE oid=?', object.oid).toArray()[0];
        if (previous?.deleting) throw new Error('LFS object deletion must finish before a new publication');
        if (previous && previous.size !== object.size) throw new Error('LFS object size conflicts with retained identity');
        this.storage.sql.exec('INSERT OR IGNORE INTO lfs_objects(oid,size) VALUES(?,?)', object.oid, object.size);
        this.storage.sql.exec('INSERT OR IGNORE INTO lfs_references(owner,oid) VALUES(?,?)', owner, object.oid);
      }
    });
  }

  snapshot(input: RetainedLfsSnapshot): void {
    const snapshot = RetainedLfsSnapshotSchema.parse(input);
    this.storage.transactionSync(() => {
      const previous = this.storage.sql.exec<{ inventory: string }>('SELECT inventory FROM lfs_snapshots WHERE snapshot_id=?', snapshot.snapshotId).toArray()[0];
      if (previous) {
        const accepted = RetainedLfsSnapshotSchema.parse(JSON.parse(previous.inventory));
        if (accepted.workspaceId !== snapshot.workspaceId || accepted.kind !== snapshot.kind || accepted.objects.length !== snapshot.objects.length || accepted.objects.some(object => !snapshot.objects.some(candidate => candidate.oid === object.oid && candidate.size === object.size))) throw new Error('LFS snapshot identity changed');
        snapshot.objects = snapshot.objects.map(object => {
          const previousObject = accepted.objects.find(candidate => candidate.oid === object.oid);
          return previousObject?.source === 'origin' ? previousObject : object;
        });
      }
      this.retain(`snapshot:${snapshot.snapshotId}`, snapshot.objects.filter(object => object.source === 'r2'));
      this.storage.sql.exec('INSERT INTO lfs_snapshots VALUES(?,?,?,?) ON CONFLICT(snapshot_id) DO UPDATE SET inventory=excluded.inventory', snapshot.snapshotId, snapshot.workspaceId, snapshot.kind, JSON.stringify(snapshot));
    });
  }

  snapshots(): RetainedLfsSnapshot[] {
    return this.storage.sql.exec<{ inventory: string }>('SELECT inventory FROM lfs_snapshots').toArray().map(row => RetainedLfsSnapshotSchema.parse(JSON.parse(row.inventory)));
  }

  reconcile(roots: ReadonlySet<string>): void {
    this.storage.transactionSync(() => {
      for (const snapshot of this.snapshots()) {
        this.release(`snapshot:${snapshot.snapshotId}`);
        if (roots.has(snapshot.snapshotId)) this.retain(`snapshot:${snapshot.snapshotId}`, snapshot.objects.filter(object => object.source === 'r2'));
      }
    });
  }

  origin(objects: readonly (GitLfsObject & { location: GitLfsLocation })[]): void {
    const confirmed = new Map(objects.map(object => [object.oid, object]));
    this.storage.transactionSync(() => {
      for (const object of objects) this.storage.sql.exec('INSERT INTO lfs_origin_sources VALUES(?,?,?,?) ON CONFLICT(origin,endpoint,oid) DO UPDATE SET size=excluded.size', object.oid, object.size, object.location.origin, object.location.endpoint);
      for (const snapshot of this.snapshots()) {
        snapshot.objects = snapshot.objects.map(object => {
          const source = confirmed.get(object.oid);
          return source?.size === object.size ? { ...object, source: 'origin', location: source.location } : object;
        });
        this.storage.sql.exec('UPDATE lfs_snapshots SET inventory=? WHERE snapshot_id=?', JSON.stringify(snapshot), snapshot.snapshotId);
        for (const object of objects) this.storage.sql.exec('DELETE FROM lfs_references WHERE owner=? AND oid=?', `snapshot:${snapshot.snapshotId}`, object.oid);
      }
    });
  }

  resolve(objects: GitLfsSnapshot['objects'], origin: string | null): GitLfsSnapshot['objects'] {
    return objects.map(object => {
      const source = this.storage.sql.exec<{ origin: string; endpoint: string }>('SELECT origin,endpoint FROM lfs_origin_sources WHERE oid=? AND size=? AND origin=? LIMIT 1', object.oid, object.size, origin).toArray()[0];
      return source ? { ...object, source: 'origin', location: source } : object;
    });
  }

  release(owner: string): void { this.storage.sql.exec('DELETE FROM lfs_references WHERE owner=?', owner); }
  objects(): GitLfsObject[] { return this.storage.sql.exec<{ oid: string; size: number }>('SELECT oid,size FROM lfs_objects').toArray().map(object => GitLfsObjectSchema.parse(object)); }
  candidates(): GitLfsObject[] { return this.storage.sql.exec<{ oid: string; size: number }>('SELECT oid,size FROM lfs_objects WHERE NOT EXISTS(SELECT 1 FROM lfs_references WHERE lfs_references.oid=lfs_objects.oid)').toArray().map(object => GitLfsObjectSchema.parse(object)); }
  beginDelete(object: GitLfsObject): boolean {
    this.storage.sql.exec('UPDATE lfs_objects SET deleting=1 WHERE oid=? AND size=? AND NOT EXISTS(SELECT 1 FROM lfs_references WHERE lfs_references.oid=lfs_objects.oid)', object.oid, object.size);
    return this.storage.sql.exec('SELECT 1 FROM lfs_objects WHERE oid=? AND size=? AND deleting=1 AND NOT EXISTS(SELECT 1 FROM lfs_references WHERE lfs_references.oid=lfs_objects.oid)', object.oid, object.size).toArray().length === 1;
  }
  forget(object: GitLfsObject): void { this.storage.sql.exec('DELETE FROM lfs_objects WHERE oid=? AND deleting=1 AND NOT EXISTS(SELECT 1 FROM lfs_references WHERE lfs_references.oid=lfs_objects.oid)', object.oid); }
}
