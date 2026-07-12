import { describe, expect, it, beforeAll, afterAll } from 'bun:test';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Isolate the agent db in a fresh workspace root before any query opens it
// (the db handle is a module singleton keyed to the first path it sees).
const ROOT = join(tmpdir(), `agent-db-cap-${Date.now()}-${Math.random().toString(36).slice(2)}`);
let previousRoot: string | undefined;

beforeAll(() => {
  previousRoot = process.env.GITSPACE_WORKSPACE_ROOT;
  process.env.GITSPACE_WORKSPACE_ROOT = ROOT;
  mkdirSync(ROOT, { recursive: true });
});

afterAll(() => {
  if (previousRoot === undefined) delete process.env.GITSPACE_WORKSPACE_ROOT;
  else process.env.GITSPACE_WORKSPACE_ROOT = previousRoot;
  rmSync(ROOT, { recursive: true, force: true });
});

describe('getArchivedSessions cap + count (ticket #42)', () => {
  it('returns newest-first, honors the limit, and reports the true total', async () => {
    const { upsertArchivedSession, getArchivedSessions, countArchivedSessions } = await import('../agent-db.js');
    const workspaceId = 'demo:ws-cap';
    for (let i = 0; i < 30; i++) {
      upsertArchivedSession({
        workspaceId,
        sessionId: `sess-${String(i).padStart(2, '0')}`,
        title: `Session ${i}`,
        // archived_at increases with i, so higher i == newer.
        archivedAt: new Date(1_700_000_000_000 + i * 1000).toISOString(),
      });
    }

    expect(countArchivedSessions(workspaceId)).toBe(30);

    const capped = getArchivedSessions(workspaceId, 20);
    expect(capped).toHaveLength(20);
    // Newest first: sess-29 down to sess-10.
    expect(capped[0]?.sessionId).toBe('sess-29');
    expect(capped[19]?.sessionId).toBe('sess-10');

    // No limit == all rows.
    expect(getArchivedSessions(workspaceId)).toHaveLength(30);
  });
});
