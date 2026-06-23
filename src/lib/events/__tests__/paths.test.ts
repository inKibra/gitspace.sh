import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const loadPathsModule = () => import(`../paths.ts?test=${Date.now()}-${Math.random()}`);

describe('event storage paths', () => {
  it('stores process events under the workspace .gitspace runtime tree', async () => {
    const { getProcessEventsDir, getProcessSnapshotsPath } = await loadPathsModule();
    const workspacePath = join(tmpdir(), 'workspace');

    expect(getProcessEventsDir(workspacePath, 'web/api', 2)).toBe(
      join(workspacePath, '.gitspace', 'events', 'processes', 'web%2Fapi-2')
    );
    expect(getProcessSnapshotsPath(workspacePath, 'web/api', 2)).toBe(
      join(workspacePath, '.gitspace', 'events', 'processes', 'web%2Fapi-2', 'wide-snapshots.ndjson')
    );
  });

  it('lists process events from the workspace .gitspace runtime tree', async () => {
    const { listProcessEventsDirs } = await loadPathsModule();
    const tempRoot = mkdtempSync(join(tmpdir(), 'events-paths-'));
    try {
      const workspacePath = join(tempRoot, 'workspace');
      const processRoot = join(workspacePath, '.gitspace', 'events', 'processes');
      mkdirSync(join(processRoot, 'web-1'), { recursive: true });
      mkdirSync(join(processRoot, '.hidden'), { recursive: true });
      mkdirSync(join(processRoot, 'api-2'), { recursive: true });

      expect(listProcessEventsDirs(workspacePath).sort()).toEqual([
        join(processRoot, 'api-2'),
        join(processRoot, 'web-1'),
      ]);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
