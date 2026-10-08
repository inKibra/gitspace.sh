import { afterEach, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GitSpaceDatabase, agentSessions } from '../src/index.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// pi-durable numbers each workspace's main conversation 1, so cloud conversation ids repeat across spaces.
it('lets every space hold its own main conversation even when cloud conversation ids repeat', () => {
  const root = mkdtempSync(join(tmpdir(), 'gitspace-session-identity-'));
  roots.push(root);
  const database = new GitSpaceDatabase(join(root, 'gitspace.db'));
  try {
    expect(database.createProject({ id: 'project-a', name: 'A', repositoryPath: '/repo/a' }).status).toBe('ok');
    expect(database.createProject({ id: 'project-b', name: 'B', repositoryPath: '/repo/b' }).status).toBe('ok');
    const now = new Date().toISOString();
    for (const spaceId of ['project-a', 'project-b']) {
      database.orm.insert(agentSessions).values({
        id: `agent-${spaceId}`, spaceId, ompSessionId: '1', sessionFile: `cloud-session://${spaceId}/${spaceId}/1`, state: 'active',
        lastEventOffset: 0, createdAt: now, updatedAt: now,
      }).run();
    }
    expect(database.orm.select().from(agentSessions).all().map(session => session.spaceId).sort()).toEqual(['project-a', 'project-b']);
    expect(() => database.orm.insert(agentSessions).values({
      id: 'agent-duplicate', spaceId: 'project-a', ompSessionId: '2', sessionFile: 'cloud-session://project-a/project-a/2', state: 'active',
      lastEventOffset: 0, createdAt: now, updatedAt: now,
    }).run()).toThrow();
  } finally {
    database.close();
  }
});
