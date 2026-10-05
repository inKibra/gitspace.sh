import { describe, expect, it } from 'bun:test';
import { machineOperationalTools } from '../src/runtime-operations.js';
import type { RuntimeToolDispatch } from '@gitspace/protocol-runtime';

const goal = { id: 'goal', title: 'Task', summary: 'Implement the task', phase: 'code', requirements: [], updatedBy: 'agent' };


describe('Machine workspace control admission', () => {
  function machine() {
    let creations = 0;
    let lifecycleRuns = 0;
    const options = {
      controls: { create: async () => { creations += 1; return { workspace: { id: 'new', projectId: 'project-a' }, operation: {} }; }, instructionsChanged: async () => undefined },
      authority: { putInspectorGoal: async () => ({ id: 'goal', revision: 1 }), appendProjectEvent: async () => undefined, putInspectorWorkflow: async () => { throw new Error('Workflow authority unavailable'); } },
      environments: { acceptRun: async () => { lifecycleRuns += 1; } },
    } as unknown as Parameters<typeof machineOperationalTools>[0];
    const tools = machineOperationalTools(options);
    const run = (tool: string, args: RuntimeToolDispatch['args']) => tools[tool]!({ projectId: 'project-a', workspaceId: 'workspace-a', args } as RuntimeToolDispatch, { attachment: { role: 'primary' } } as Parameters<typeof tools[string]>[1], new AbortController().signal);
    return { run, creations: () => creations, lifecycleRuns: () => lifecycleRuns };
  }
  it('validates every draft before workspace creation', async () => {
    const { run, creations } = machine();
    await expect(run('create', { method: 'create', name: 'New', branch: 'new', sourceKind: 'base', sourceRef: 'main', goal, workflow: { id: 'invalid' } })).rejects.toThrow();
    expect(creations()).toBe(0);
  });
  it('retains created identity and committed instructions after a later write fails', async () => {
    const { run, creations } = machine();
    const result = await run('create', { method: 'create', name: 'New', branch: 'new', sourceKind: 'base', sourceRef: 'main', goal, workflow: { id: 'workflow', title: 'Workflow', description: '', nodes: [], edges: [], updatedBy: 'agent' } });
    const content = result[0];
    if (!content || content.type !== 'text') throw new Error('Expected structured creation result');
    expect(JSON.parse(content.text)).toMatchObject({ ready: false, identity: { spaceId: 'new' }, initialized: ['goal'], error: { operation: 'workflow.put' } });
    expect(creations()).toBe(1);
  });
  it('rejects self-close and protected lifecycle effects before execution', async () => {
    const { run, lifecycleRuns } = machine();
    for (const method of ['close', 'archive']) await expect(run('create', { method, expectedRevision: 1, expectedGeneration: 1 })).rejects.toThrow('own workspace');
    await expect(run('lifecycle', { runId: 'destroy', phase: 'cloud/destroy' })).rejects.toThrow();
    await expect(run('lifecycle', { runId: 'private', phase: 'machine/prepare', interactive: true })).rejects.toThrow();
    expect(lifecycleRuns()).toBe(0);
  });
});
