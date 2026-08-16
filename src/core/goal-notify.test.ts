import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  flushGoalChangeNotify,
  pendingGoalChangeNotifyCount,
  queueGoalChangeNotify,
  resetGoalChangeNotifyForTests,
  suppressGoalChangeNotify,
} from './goal-notify.js';
import { addGoalNearWorkspace } from './goal-chain.js';

const envKey = 'GITSPACE_WORKSPACE_ROOT';

describe('goal-changed notify', () => {
  beforeEach(() => {
    resetGoalChangeNotifyForTests();
  });

  afterEach(() => {
    resetGoalChangeNotifyForTests();
  });

  it('queues once per project and flushes through the sender', async () => {
    queueGoalChangeNotify('demo');
    queueGoalChangeNotify('demo');
    queueGoalChangeNotify('other');
    expect(pendingGoalChangeNotifyCount()).toBe(2);

    const sent: string[] = [];
    await flushGoalChangeNotify({
      sender: async (projectName) => {
        sent.push(projectName);
      },
    });
    expect(sent.sort()).toEqual(['demo', 'other']);
    expect(pendingGoalChangeNotifyCount()).toBe(0);
  });

  it('swallows sender failures (fire-and-forget)', async () => {
    queueGoalChangeNotify('demo');
    await flushGoalChangeNotify({
      sender: async () => {
        throw new Error('daemon unreachable');
      },
    });
    expect(pendingGoalChangeNotifyCount()).toBe(0);
  });

  it('suppression (daemon process) disables queueing', async () => {
    suppressGoalChangeNotify();
    queueGoalChangeNotify('demo');
    expect(pendingGoalChangeNotifyCount()).toBe(0);
    const sent: string[] = [];
    await flushGoalChangeNotify({ sender: async (p) => { sent.push(p); } });
    expect(sent).toEqual([]);
  });

  describe('goal writes queue the notify', () => {
    let root: string;
    let previousRoot: string | undefined;

    beforeEach(() => {
      root = join(tmpdir(), `goal-notify-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      previousRoot = process.env[envKey];
      process.env[envKey] = root;
      mkdirSync(join(root, 'demo', 'workspaces', 'api'), { recursive: true });
      writeFileSync(join(root, 'demo', '.config.json'), JSON.stringify({ name: 'demo', githubRepo: 'demo/repo', baseBranch: 'main', workspaces: [] }), 'utf-8');
    });

    afterEach(() => {
      if (previousRoot === undefined) delete process.env[envKey];
      else process.env[envKey] = previousRoot;
      rmSync(root, { recursive: true, force: true });
    });

    it('writeGoalRecord (via addGoalNearWorkspace) queues the project', async () => {
      addGoalNearWorkspace('demo', 'api', 'New goal', 'after');
      expect(pendingGoalChangeNotifyCount()).toBeGreaterThan(0);

      const sent: string[] = [];
      await flushGoalChangeNotify({ sender: async (p) => { sent.push(p); } });
      expect(sent).toEqual(['demo']);
    });
  });
});
