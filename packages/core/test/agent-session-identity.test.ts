import { afterEach, expect, it } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
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

it('migrates an existing machine database without losing session state or space uniqueness', () => {
  const root = mkdtempSync(join(tmpdir(), 'gitspace-session-upgrade-'));
  roots.push(root);
  const source = fileURLToPath(new URL('../drizzle', import.meta.url));
  const migrationsFolder = join(root, 'legacy-migrations');
  mkdirSync(join(migrationsFolder, 'meta'), { recursive: true });
  const journal = z.object({
    version: z.string(), dialect: z.string(),
    entries: z.array(z.object({ idx: z.number(), version: z.string(), when: z.number(), tag: z.string(), breakpoints: z.boolean() })),
  }).parse(JSON.parse(readFileSync(join(source, 'meta/_journal.json'), 'utf8')));
  const legacyEntries = journal.entries.filter(entry => entry.idx < 8);
  for (const entry of legacyEntries) cpSync(join(source, `${entry.tag}.sql`), join(migrationsFolder, `${entry.tag}.sql`));
  writeFileSync(join(migrationsFolder, 'meta/_journal.json'), JSON.stringify({ ...journal, entries: legacyEntries }));
  const path = join(root, 'gitspace.db');
  let database = new GitSpaceDatabase(path, { migrationsFolder });
  try {
    expect(database.createProject({ id: 'project-a', name: 'A', repositoryPath: '/repo/a' }).status).toBe('ok');
    expect(database.createProject({ id: 'project-b', name: 'B', repositoryPath: '/repo/b' }).status).toBe('ok');
    const now = new Date().toISOString();
    database.orm.insert(agentSessions).values({
      id: 'agent-a', spaceId: 'project-a', ompSessionId: '1', sessionFile: 'cloud-session://project-a/project-a/1',
      state: 'active', lastEventOffset: 42, resumePending: true, activity: { active: true, reasons: [{ kind: 'turn' }] },
      createdAt: now, updatedAt: now,
    }).run();
    const [original] = database.orm.select().from(agentSessions).all();
    const second = { ...original, id: 'agent-b', spaceId: 'project-b' };
    expect(() => database.orm.insert(agentSessions).values(second).run()).toThrow();
    database.close();
    database = new GitSpaceDatabase(path);
    expect(database.orm.select().from(agentSessions).all()).toEqual([original]);
    database.orm.insert(agentSessions).values(second).run();
    expect(() => database.orm.insert(agentSessions).values({ ...second, id: 'duplicate', ompSessionId: '2' }).run()).toThrow();
    const sessions = database.orm.select().from(agentSessions).all();
    database.close();
    database = new GitSpaceDatabase(path);
    expect(database.orm.select().from(agentSessions).all()).toEqual(sessions);
    expect(() => database.orm.insert(agentSessions).values({ ...second, id: 'duplicate-reopen', ompSessionId: '3' }).run()).toThrow();
  } finally {
    database.close();
  }
});
