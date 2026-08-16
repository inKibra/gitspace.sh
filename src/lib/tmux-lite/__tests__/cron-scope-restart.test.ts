import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { collectDueTriggers, tickTriggerScheduler } from '../trigger-scheduler.js';
import { saveTrigger, listTriggers } from '../../../core/triggers.js';
import { artifactsScope, ensureArtifactsMount, ensureArtifactsRepo } from '../../../core/artifacts.js';

describe('cron scheduler discovers project and workspace trigger scopes', () => {
  let root: string;
  let previousRoot: string | undefined;
  let projectDir: string;
  let workspaceDir: string;

  beforeEach(async () => {
    root = join(tmpdir(), `cron-scopes-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    previousRoot = process.env.GITSPACE_WORKSPACE_ROOT;
    process.env.GITSPACE_WORKSPACE_ROOT = root;
    projectDir = join(root, 'demo');
    workspaceDir = join(projectDir, 'workspaces', 'ws1');
    mkdirSync(join(workspaceDir, '.gitspace', 'workspace', 'ws1'), { recursive: true });
    writeFileSync(join(projectDir, '.config.json'), JSON.stringify({ name: 'demo', repository: 'x/y' }));
    writeFileSync(join(workspaceDir, '.gitspace', 'workspace', 'ws1', 'goal.json'), JSON.stringify({ id: 'goal-123' }));
    execFileSync('git', ['init', '-q', workspaceDir]);
    await ensureArtifactsRepo(projectDir);
    await ensureArtifactsMount(projectDir, projectDir, 'main');
    await ensureArtifactsMount(projectDir, workspaceDir, 'ws1');
  });

  afterEach(() => {
    if (previousRoot === undefined) delete process.env.GITSPACE_WORKSPACE_ROOT;
    else process.env.GITSPACE_WORKSPACE_ROOT = previousRoot;
    rmSync(root, { recursive: true, force: true });
  });

  it('loads both paths, locks duplicate ticks, completes runs, and rediscovers after restart', async () => {
    const projectTrigger = await saveTrigger(projectDir, projectDir, {
      name: 'project cron', kind: 'cron', when: 'every 1h', scope: 'project', writes: [],
      runs: { type: 'skill', ref: 'agent-prompt', prompt: 'project work' },
    });
    const workspaceTrigger = await saveTrigger(projectDir, workspaceDir, {
      name: 'workspace cron', kind: 'cron', when: 'every 1h', scope: 'workspace', writes: [],
      runs: { type: 'skill', ref: 'agent-prompt', prompt: 'workspace work' },
    });

    const projectPath = join(projectDir, '.gitspace', 'artifacts', 'triggers', `${projectTrigger.id}.trigger.json`);
    const workspacePath = join(workspaceDir, '.gitspace', 'artifacts', 'goals', 'goal-123', 'triggers', `${workspaceTrigger.id}.trigger.json`);
    expect(existsSync(projectPath)).toBe(true);
    expect(existsSync(workspacePath)).toBe(true);
    expect(artifactsScope(workspaceDir).rel(`triggers/${workspaceTrigger.id}.trigger.json`)).toBe(`goals/goal-123/triggers/${workspaceTrigger.id}.trigger.json`);
    expect(JSON.parse(readFileSync(projectPath, 'utf8')).scope).toBe('project');
    expect(JSON.parse(readFileSync(workspacePath, 'utf8')).scope).toBe('workspace');

    const now = new Date('2026-08-02T12:00:00Z');
    const freshList = () => [
      { id: 'demo:@base', name: 'demo', path: projectDir, projectName: 'demo' },
      { id: 'demo:ws1', name: 'ws1', path: workspaceDir, projectName: 'demo' },
    ];
    expect(collectDueTriggers(freshList(), now).map((d) => d.trigger.name).sort()).toEqual(['project cron', 'workspace cron']);

    const completed: Array<() => void> = [];
    const fired: string[] = [];
    expect(await tickTriggerScheduler(freshList(), {
      runAgent: async (_workspace, title) => { fired.push(title); return `${fired.length}`; },
      watchSessionIdle: (_workspace, _session, onIdle) => { completed.push(onIdle); },
    }, now)).toBe(2);
    expect(fired).toEqual(['trigger: project cron', 'trigger: workspace cron']);
    expect(await tickTriggerScheduler(freshList(), {
      runAgent: async () => 'duplicate',
    }, new Date('2026-08-02T12:01:00Z'))).toBe(0);

    for (const onIdle of completed) onIdle();
    // Completion is deliberately fire-and-forget in the scheduler seam; yield microtasks until git writes settle.
    for (let i = 0; i < 32; i += 1) await Promise.resolve();
    expect(listTriggers(projectDir)[0]!.status).toBe('ok');
    expect(listTriggers(workspaceDir)[0]!.status).toBe('ok');
    expect(listTriggers(projectDir)[0]!.runLog?.at(-1)?.sessionId).toBe('1');
    expect(listTriggers(workspaceDir)[0]!.runLog?.at(-1)?.sessionId).toBe('2');
    expect(collectDueTriggers(freshList(), new Date('2026-08-02T12:30:00Z'))).toHaveLength(0);
    expect(collectDueTriggers(freshList(), new Date(Date.now() + 3_600_001)).map((d) => d.trigger.name).sort()).toEqual(['project cron', 'workspace cron']);
  });
});
