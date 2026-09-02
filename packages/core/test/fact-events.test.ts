import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FACT_EVENT_PAGE_SIZE, FactEventStore, GitSpaceDatabase } from '../src/index.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('FactEventStore', () => {
  it('replays by monotonic offset in bounded pages without an in-memory backlog', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gitspace-events-'));
    roots.push(root);
    const database = new GitSpaceDatabase(join(root, 'gitspace.db'));
    expect(database.createProject({ id: 'project-a', name: 'A', repositoryPath: '/repo/a' }).status).toBe('ok');
    const events = new FactEventStore(database);
    for (let revision = 1; revision <= FACT_EVENT_PAGE_SIZE + 4; revision += 1) {
      events.append({
        projectId: 'project-a',
        scope: 'workspace',
        entity: 'workspace',
        entityId: 'workspace-a',
        revision,
        operation: 'updated',
        payload: { revision },
      });
    }
    expect(events.listAfter('project-a', 0, Number.MAX_SAFE_INTEGER)).toHaveLength(FACT_EVENT_PAGE_SIZE);
    expect(events.latestOffset('project-a')).toBe(FACT_EVENT_PAGE_SIZE + 4);
    const controller = new AbortController();
    const stream = events.stream('project-a', FACT_EVENT_PAGE_SIZE, controller.signal);
    const replayed: number[] = [];
    for await (const event of stream) {
      replayed.push(event.offset);
      if (replayed.length === 4) controller.abort();
    }
    expect(replayed).toEqual([
      FACT_EVENT_PAGE_SIZE + 1,
      FACT_EVENT_PAGE_SIZE + 2,
      FACT_EVENT_PAGE_SIZE + 3,
      FACT_EVENT_PAGE_SIZE + 4,
    ]);
    database.close();
  });
});
