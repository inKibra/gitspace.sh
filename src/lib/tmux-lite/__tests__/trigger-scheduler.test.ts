import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parseCronWhen, isTriggerDue, collectDueTriggers, tickTriggerScheduler } from '../trigger-scheduler.js';
import { saveTrigger, listTriggers, type TriggerRecord } from '../../../core/triggers.js';
import { ensureArtifactsRepo, ensureArtifactsMount } from '../../../core/artifacts.js';

function trig(over: Partial<TriggerRecord>): TriggerRecord {
  return { id: 't', name: 't', kind: 'cron', when: 'every 1h', status: 'idle', last: 'never', writes: ['data/'], history: [], runs: { type: 'skill', ref: 'agent-prompt', prompt: 'do the thing' }, ...over };
}

describe('parseCronWhen / isTriggerDue', () => {
  it('parses every N m/h/d and rejects the rest', () => {
    expect(parseCronWhen('every 5m')).toBe(300_000);
    expect(parseCronWhen('every 2 hours')).toBe(7_200_000);
    expect(parseCronWhen('every 1d')).toBe(86_400_000);
    expect(parseCronWhen('Mon 09:00')).toBeNull();
    expect(parseCronWhen('on push')).toBeNull();
  });

  it('due when never run, past interval, or stale pending; not due when fresh or pending-locked', () => {
    const now = new Date('2026-07-07T12:00:00Z');
    expect(isTriggerDue(trig({}), now)).toBe(true); // never run
    expect(isTriggerDue(trig({ runLog: [{ at: '2026-07-07T10:00:00Z', status: 'ok' }] }), now)).toBe(true); // 2h > 1h
    expect(isTriggerDue(trig({ runLog: [{ at: '2026-07-07T11:30:00Z', status: 'ok' }] }), now)).toBe(false); // fresh
    expect(isTriggerDue(trig({ runLog: [{ at: '2026-07-07T11:30:00Z', status: 'pending' }] }), now)).toBe(false); // pending lock
    expect(isTriggerDue(trig({ runLog: [{ at: '2026-07-07T09:00:00Z', status: 'pending' }] }), now)).toBe(true); // stale pending
    expect(isTriggerDue(trig({ kind: 'manual' }), now)).toBe(false);
    expect(isTriggerDue(trig({ kind: 'event', when: 'on push' }), now)).toBe(false);
  });
});

describe('tick against a real registry', () => {
  let root: string;
  let previousRoot: string | undefined;
  let projectDir: string;
  let workspaceDir: string;

  beforeEach(async () => {
    root = join(tmpdir(), `sched-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    previousRoot = process.env.GITSPACE_WORKSPACE_ROOT;
    process.env.GITSPACE_WORKSPACE_ROOT = root;
    projectDir = join(root, 'demo');
    workspaceDir = join(projectDir, 'workspaces', 'ws1');
    mkdirSync(workspaceDir, { recursive: true });
    writeFileSync(join(projectDir, '.config.json'), JSON.stringify({ name: 'demo', repository: 'x/y' }));
    execFileSync('git', ['init', '-q', workspaceDir]);
    await ensureArtifactsRepo(projectDir);
    await ensureArtifactsMount(projectDir, workspaceDir, 'ws1');
  });

  afterEach(() => {
    if (previousRoot === undefined) delete process.env.GITSPACE_WORKSPACE_ROOT;
    else process.env.GITSPACE_WORKSPACE_ROOT = previousRoot;
    rmSync(root, { recursive: true, force: true });
  });

  it('fires due cron triggers, records pending run, and does not double-fire', async () => {
    await saveTrigger(projectDir, workspaceDir, {
      name: 'nightly metrics', kind: 'cron', when: 'every 1h',
      writes: ['data/'], runs: { type: 'skill', ref: 'agent-prompt', prompt: 'regenerate metrics' },
    });
    const ws = { id: 'demo:ws1', name: 'ws1', path: workspaceDir, projectName: 'demo' };
    const now = new Date('2026-07-07T12:00:00Z');

    const due = collectDueTriggers([ws], now);
    expect(due).toHaveLength(1);
    expect(due[0]!.prompt).toContain('regenerate metrics');
    expect(due[0]!.prompt).toContain('data/');

    const fired: string[] = [];
    const count = await tickTriggerScheduler([ws], {
      runAgent: async (_w, title) => { fired.push(title); return 'sess-1'; },
    }, now);
    expect(count).toBe(1);
    expect(fired).toEqual(['trigger: nightly metrics']);

    const after = listTriggers(workspaceDir);
    expect(after[0]!.status).toBe('pending');
    expect(after[0]!.runLog).toHaveLength(1);

    // immediate second tick: pending lock prevents stacking
    const again = await tickTriggerScheduler([ws], { runAgent: async () => 'sess-2' }, new Date('2026-07-07T12:01:00Z'));
    expect(again).toBe(0);
  });

  it('records fail when the agent session cannot start', async () => {
    await saveTrigger(projectDir, workspaceDir, {
      name: 'broken', kind: 'cron', when: 'every 5m', writes: [], runs: { type: 'skill', ref: 'agent-prompt', prompt: 'x' },
    });
    const ws = { id: 'demo:ws1', name: 'ws1', path: workspaceDir, projectName: 'demo' };
    await tickTriggerScheduler([ws], { runAgent: async () => null }, new Date());
    const after = listTriggers(workspaceDir);
    expect(after.find((t) => t.id === 'broken')!.status).toBe('failed');
  });
});
