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

  it('records ok (with the session id) when the run session goes idle', async () => {
    await saveTrigger(projectDir, workspaceDir, {
      name: 'closes loop', kind: 'cron', when: 'every 1h',
      writes: [], runs: { type: 'skill', ref: 'agent-prompt', prompt: 'do it' },
    });
    const ws = { id: 'demo:ws1', name: 'ws1', path: workspaceDir, projectName: 'demo' };
    let complete: (() => void) | null = null;
    await tickTriggerScheduler([ws], {
      runAgent: async () => 'sess-ok',
      watchSessionIdle: (_w, _sid, onIdle) => { complete = onIdle; },
    }, new Date('2026-07-07T12:00:00Z'));

    expect(listTriggers(workspaceDir)[0]!.status).toBe('pending');
    expect(complete).not.toBeNull();
    complete!();
    // ok-record is async fire-and-forget — give it a beat
    await new Promise((r) => setTimeout(r, 400));
    const after = listTriggers(workspaceDir)[0]!;
    expect(after.status).toBe('ok');
    const last = after.runLog![after.runLog!.length - 1]!;
    expect(last.status).toBe('ok');
    expect(last.sessionId).toBe('sess-ok');
    // and the NEXT tick within the interval does not re-fire (cadence restored)
    const again = await tickTriggerScheduler([ws], { runAgent: async () => 'sess-2' }, new Date('2026-07-07T12:30:00Z'));
    expect(again).toBe(0);
  });

  it('reverts out-of-scope writes at completion and marks the run failed; clean runs stay ok', async () => {
    const { completeTriggerRun } = await import('../../../core/triggers.js');
    await saveTrigger(projectDir, workspaceDir, {
      name: 'scoped', kind: 'cron', when: 'every 1h',
      writes: ['data/**'], runs: { type: 'skill', ref: 'agent-prompt', prompt: 'refresh data' },
    });
    const ws = { id: 'demo:ws1', name: 'ws1', path: workspaceDir, projectName: 'demo' };
    const mount = join(workspaceDir, '.gitspace', 'artifacts');
    const g = (args: string): string => execFileSync('bash', ['-c', `git -C ${JSON.stringify(mount)} -c user.name=t -c user.email=t@t -c commit.gpgsign=false ${args}`], { encoding: 'utf8' }).trim();

    let complete: (() => void) | null = null;
    await tickTriggerScheduler([ws], {
      runAgent: async () => 'sess-scoped',
      watchSessionIdle: (_w, _sid, onIdle) => { complete = onIdle; },
    }, new Date('2026-07-07T12:00:00Z'));

    // Simulate the run's agent: one in-scope write, one out-of-scope write.
    mkdirSync(join(mount, 'data'), { recursive: true });
    writeFileSync(join(mount, 'data', 'metrics.json'), '{"ok":true}');
    writeFileSync(join(mount, 'README.md'), 'HIJACKED');
    g('add -A');
    g('commit -q -m "run writes"');

    complete!();
    await new Promise((r) => setTimeout(r, 800));

    const after = listTriggers(workspaceDir).find((t) => t.id === 'scoped')!;
    expect(after.status).toBe('failed');
    expect(after.runLog![after.runLog!.length - 1]!.note).toContain('README.md');
    // out-of-scope file restored; in-scope write kept
    expect(g('show HEAD:README.md')).not.toContain('HIJACKED');
    expect(g('show HEAD:data/metrics.json')).toContain('ok');

    // clean run: only in-scope writes → ok. (Completion stamps REAL time, so
    // the second due-check must be relative to real now, not the fake clock.)
    let complete2: (() => void) | null = null;
    await tickTriggerScheduler([ws], {
      runAgent: async () => 'sess-clean',
      watchSessionIdle: (_w, _sid, onIdle) => { complete2 = onIdle; },
    }, new Date(Date.now() + 2 * 3_600_000));
    writeFileSync(join(mount, 'data', 'metrics.json'), '{"ok":2}');
    g('add -A');
    g('commit -q -m "clean run"');
    complete2!();
    await new Promise((r) => setTimeout(r, 800));
    const after2 = listTriggers(workspaceDir).find((t) => t.id === 'scoped')!;
    expect(after2.status).toBe('ok');
    expect(g('show HEAD:data/metrics.json')).toContain('2');
  });

  it('saveTrigger rejects an unfireable cron schedule', async () => {
    await expect(saveTrigger(projectDir, workspaceDir, {
      name: 'bad clock', kind: 'cron', when: 'Mon 09:00',
      writes: [], runs: { type: 'skill', ref: 'agent-prompt', prompt: 'x' },
    })).rejects.toThrow('never fire');
    // event/manual kinds carry free-form condition labels — no schedule check
    await saveTrigger(projectDir, workspaceDir, {
      name: 'on push', kind: 'event', when: 'on push',
      writes: [], runs: { type: 'skill', ref: 'agent-prompt', prompt: 'x' },
    });
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
