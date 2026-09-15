import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { and, eq } from 'drizzle-orm';
import {
  ArtifactPromoter,
  GitSpaceDatabase,
  LocalArtifactResolver,
  MemoryArtifactObjectStore,
  artifactEntries,
  artifactPromotions,
} from '../src/index.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('ArtifactPromoter', () => {
  it('re-encrypts committed workspace bytes into a generation-checked base manifest', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gitspace-promotion-'));
    roots.push(root);
    const database = new GitSpaceDatabase(join(root, 'gitspace.db'));
    expect(database.createProject({ id: 'project-a', name: 'A', repositoryPath: '/repo/a' }).status).toBe('ok');
    expect(database.createWorkspace({
      id: 'workspace-a', projectId: 'project-a', name: 'A', branch: 'a', rootPath: '/repo/a/workspaces/a',
    }).status).toBe('ok');
    const store = new MemoryArtifactObjectStore();
    const resolver = new LocalArtifactResolver(
      database,
      store,
      join(root, 'cache'),
      Uint8Array.from({ length: 32 }, (_, index) => index + 20),
    );
    const workspace = { kind: 'workspace', projectId: 'project-a', workspaceId: 'workspace-a' } as const;
    const project = { kind: 'project', projectId: 'project-a', currentWorkspaceId: 'workspace-a' } as const;
    expect((await resolver.write(
      workspace,
      'local://workspace/apps/demo/index.html',
      new TextEncoder().encode('<h1>promoted</h1>'),
      'text/html',
    )).status).toBe('ok');
    expect((await resolver.commit(workspace, 'local://workspace/')).status).toBe('ok');
    const workspaceEntry = database.orm.select().from(artifactEntries).where(and(
      eq(artifactEntries.scopeId, 'space:workspace-a'),
      eq(artifactEntries.path, 'apps/demo/index.html'),
    )).get()!;

    const promoter = new ArtifactPromoter(database, resolver);
    const promoted = await promoter.promote({
      capability: project,
      workspaceId: 'workspace-a',
      paths: ['apps/demo'],
      expectedBaseGeneration: 0,
    });
    expect(promoted.status).toBe('ok');
    if (promoted.status === 'error') throw promoted.error;
    expect(promoted.value).toMatchObject({
      sourceGeneration: 1,
      expectedBaseGeneration: 0,
      committedBaseGeneration: 1,
      state: 'committed',
    });

    const baseEntry = database.orm.select().from(artifactEntries).where(and(
      eq(artifactEntries.scopeId, 'space:project-a'),
      eq(artifactEntries.path, 'apps/demo/index.html'),
    )).get()!;
    expect(baseEntry.blobHash).not.toBe(workspaceEntry.blobHash);
    const baseBytes = await resolver.read(workspace, 'local://base/apps/demo/index.html');
    expect(baseBytes.status).toBe('ok');
    if (baseBytes.status === 'error') throw baseBytes.error;
    expect(new TextDecoder().decode(baseBytes.value)).toBe('<h1>promoted</h1>');

    const stale = await promoter.promote({
      capability: project,
      workspaceId: 'workspace-a',
      paths: ['apps/demo'],
      expectedBaseGeneration: 0,
    });
    expect(stale.status).toBe('error');
    expect(database.orm.select().from(artifactPromotions).orderBy(artifactPromotions.createdAt).all().map((row) => row.state))
      .toEqual(['committed', 'conflict']);
    database.close();
  });
});
