import { env, runInDurableObject } from 'cloudflare:test';
import { expect, test, vi } from 'vitest';
import { createModels } from '@earendil-works/pi-ai';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { Result } from 'better-result';
import { RuntimeAttachmentSchema, RuntimeGitCheckpointSchema, RuntimeIdentitySchema, type RuntimeToolResult } from '@gitspace/protocol-runtime';
import { createWorkspaceRuntime, type WorkspaceRuntime, type WorkspaceRuntimeOptions } from '@gitspace/runtime-workspace-do';
import { createRuntimeServices } from '../src/runtime-services.js';
import { createDispatchSelector } from '../src/runtime-dispatch-selection.js';

const unsupported = async (): Promise<never> => { throw new Error('Unexpected external operation'); };

test('cloud file ownership survives attached replicas; machine calls select the workspace default and fail immediately when unavailable', async () => {
  await runInDurableObject(env.SPACE_AUTHORITY.getByName(`owner-proof:${crypto.randomUUID()}`), async (_instance, ctx) => {
    const identity = RuntimeIdentitySchema.parse({ projectId: 'owner-project', workspaceId: 'owner-workspace' });
    const checkpoint = RuntimeGitCheckpointSchema.parse({ checkpointRef: 'refs/gitspace/checkpoints', headCommit: 'a'.repeat(40), branch: 'main', indexCommit: 'b'.repeat(40), trackedWorktreeCommit: 'c'.repeat(40), worktreeCommit: 'c'.repeat(40), indexTree: 'd'.repeat(40), worktreeTree: 'e'.repeat(40) });
    const files = new Map([['hello.txt', 'cloud original\n'], ['src/a.ts', 'one\n'], ['src/nested/b.md', 'two\n'], ['other/c.ts', 'three\n']]);
    let revision = 1;
    const code: WorkspaceRuntimeOptions['code'] = {
      async readFile(_repository, _commit, path) { const value = files.get(path); return value === undefined ? null : new Blob([value]); },
      async listSnapshotPaths() { return [...files.keys()]; },
      mergeSnapshot: unsupported,
      async writeSnapshot(input) {
        for (const mutation of input.mutations) if (mutation.content === null) files.delete(mutation.path); else files.set(mutation.path, new TextDecoder().decode(mutation.content));
        const commit = (++revision).toString(16).padStart(40, '0');
        return Result.ok({ ...input.previous, worktreeCommit: commit, trackedWorktreeCommit: commit, worktreeTree: commit });
      },
    };
    let runtime: WorkspaceRuntime | undefined;
    const services = createRuntimeServices({ ctx, env, identity, runtime: () => { if (!runtime) throw new Error('Runtime not initialized'); return runtime; }, schedule: async () => {}, generateImage: unsupported, judge: unsupported, instructionLoader: { read: unsupported, loadInstructions: async () => '' } });
    const models = createModels();
    models.setProvider({ id: 'fixture', name: 'Fixture', auth: { apiKey: { name: 'Fixture', resolve: async () => ({ auth: { apiKey: 'fixture' } }) } }, getModels: () => [{ id: 'fixture', name: 'Fixture', provider: 'fixture', api: 'fixture', baseUrl: 'https://fixture.invalid', input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, reasoning: false, contextWindow: 8192, maxTokens: 1024 }], stream: () => { throw new Error('Inference forbidden'); }, streamSimple: () => { throw new Error('Inference forbidden'); } });
    runtime = await createWorkspaceRuntime({ ...services, storage: ctx.storage, identity, code, initialCheckpoint: async () => checkpoint, models, model: { provider: 'fixture', modelId: 'fixture' }, lfs: { has: unsupported, get: unsupported, put: unsupported }, retainLfs: async () => {}, retainedRules: { loadRules: async () => [], judge: unsupported, matchAst: unsupported }, editTool: () => 'edit', admitInference: unsupported, bindInferenceConversation: async () => [], session: { catalog: async () => ({ models: [], roles: [] }), reload: unsupported }, qa: { list: async () => [], act: unsupported }, modelProxy: unsupported, attachments: { seal: async value => value, open: async value => value, dispatch: unsupported }, waitUntil: value => ctx.waitUntil(value), schedule: async () => {} });
    const root = await runtime.harness.root(BACKGROUND_CONTEXT);
    const invoke = (tool: string, args: Parameters<typeof services.tools.invoke>[0]['args']) => services.tools.invoke({ tool, args, conversationId: String(root.id), taskId: 'proof', requestId: crypto.randomUUID(), attemptId: crypto.randomUUID(), replay: 'unsafe', signal: AbortSignal.timeout(500) });
    const text = (result: RuntimeToolResult) => result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
    const a = RuntimeAttachmentSchema.parse({ ...identity, attachmentId: 'a', machineId: 'a', generation: 1, role: 'primary', state: 'ready', checkout: { kind: 'shared', branch: 'main' }, capabilities: ['bash'], updatedAt: new Date().toISOString() });
    const b = RuntimeAttachmentSchema.parse({ ...a, attachmentId: 'b', machineId: 'b', role: 'replica', checkout: { kind: 'branch', branch: 'replica-b', commit: checkpoint.worktreeCommit } });
    const seed = (attachment: typeof a) => ctx.storage.sql.exec('INSERT OR REPLACE INTO runtime_attachments(id,record,secret) VALUES(?,?,?)', attachment.attachmentId, JSON.stringify(attachment), 'fixture');
    const machine = vi.spyOn(runtime.attachments, 'execute').mockImplementation(async dispatch => ({ status: 'completed', requestId: dispatch.requestId, attemptId: dispatch.attemptId, content: [{ type: 'text', text: `${dispatch.machineId}:${dispatch.snapshot?.worktreeCommit}` }] }));
    try {
      const missing = await invoke('bash', { command: 'pwd' });
      expect(missing.status).toBe('failed'); expect(text(missing)).toContain('No machine attached');
      await expect(services.operations.jobScope({ command: 'pwd', background: true })).rejects.toThrow('No machine attached');
      seed(a); seed(b);
      expect((await invoke('write', { path: 'hello.txt', content: 'cloud write\n' })).status).toBe('completed');
      expect((await invoke('edit', { path: 'hello.txt', edits: [{ oldText: 'write', newText: 'edit' }] })).status).toBe('completed');
      expect((await invoke('apply_patch', { patch: '*** Begin Patch\n*** Add File: added.txt\n+cloud patch\n*** End Patch' })).status).toBe('completed');
      expect(text(await invoke('read', { path: 'hello.txt' }))).toContain('cloud edit');
      expect(text(await invoke('find', { pattern: '*.txt' }))).toContain('added.txt');
      expect(text(await invoke('find', { pattern: '*.ts', path: 'src' }))).toBe('src/a.ts');
      expect(text(await invoke('find', { pattern: '*.md', path: 'src' }))).toBe('src/nested/b.md');
      expect(text(await invoke('find', { pattern: '*.ts', path: 'other' }))).toBe('other/c.ts');
      expect((await invoke('find', { pattern: '*.ts', glob: '*.md' })).status).toBe('failed');
      const childId = await runtime.harness.commit(async tx => (await tx.createConversation({ ownership: { kind: 'ownerless' } })).id, BACKGROUND_CONTEXT);
      for (const tool of ['write', 'edit', 'apply_patch', 'bash', 'proc', 'environment', 'codemode']) {
        const result = await services.tools.invoke({ tool, args: { path: 'hello.txt', content: 'forged write', command: 'touch forged' }, conversationId: String(childId), taskId: 'forged', requestId: crypto.randomUUID(), attemptId: crypto.randomUUID(), replay: 'unsafe', signal: AbortSignal.timeout(500) });
        expect(result.status).toBe('failed');
        expect(text(result)).toContain('Subagent');
      }
      expect(text(await invoke('read', { path: 'hello.txt' }))).toContain('cloud edit');
      expect(machine).not.toHaveBeenCalled();
      const current = await runtime.cloudFiles.snapshot();
      expect(text(await invoke('bash', { command: 'pwd' }))).toBe(`a:${current?.worktreeCommit}`);
      await runtime.setExecutionMachine('b');
      expect(text(await invoke('bash', { command: 'pwd' }))).toBe(`b:${current?.worktreeCommit}`);
      expect(text(await invoke('bash', { command: 'pwd', on: 'a' }))).toBe(`a:${current?.worktreeCommit}`);
      expect(text(await invoke('rule_match_ast', { pattern: '$A', text: 'value' }))).toBe(`b:${current?.worktreeCommit}`);
      seed({ ...b, state: 'lost' });
      expect((await invoke('bash', { command: 'pwd' })).status).toBe('failed');
      expect(text(await invoke('read', { path: 'hello.txt' }))).toContain('cloud edit');
      await runtime.setExecutionMachine(null);
      expect(text(await invoke('bash', { command: 'pwd' }))).toBe(`a:${current?.worktreeCommit}`);
      if (!current) throw new Error('Missing canonical snapshot');
      const runnerA = RuntimeAttachmentSchema.parse({ ...a, attachmentId: 'runner-a', generation: 2, role: 'runner', checkout: { kind: 'snapshot', commit: current.worktreeCommit } });
      const runnerB = RuntimeAttachmentSchema.parse({ ...b, attachmentId: 'runner-b', generation: 2, role: 'runner', checkout: { kind: 'snapshot', commit: current.worktreeCommit } });
      seed(runnerA); seed(runnerB); seed(b);
      await runtime.setExecutionMachine('b');
      expect(text(await invoke('grep', { pattern: 'cloud', at: 'current' }))).toBe('b:undefined');
      expect(machine.mock.calls.at(-1)?.[0].attachmentId).toBe('runner-b');
      expect(text(await invoke('environment', { method: 'runPhase', runId: 'prepare-selected', phase: 'machine/prepare', rerun: true, on: 'a' }))).toBe(`a:${current.worktreeCommit}`);
      expect(text(await invoke('environment', { method: 'runChecks', runId: 'checks-selected', at: 'current', on: 'a' }))).toBe('a:undefined');
      const beforeExpired = machine.mock.calls.length;
      expect((await invoke('environment', { method: 'runChecks', runId: 'expired-checks', deadlineAt: '2000-01-01T00:00:00.000Z' })).status).toBe('interrupted');
      expect(machine.mock.calls).toHaveLength(beforeExpired);
      seed({ ...b, state: 'lost' });
      const executed = machine.mock.calls.length;
      const unavailableDefault = await invoke('bash', { command: 'pwd', at: 'current' });
      expect(unavailableDefault.status).toBe('failed');
      expect(text(unavailableDefault)).toContain('No machine attached');
      expect(machine.mock.calls).toHaveLength(executed);
      expect(text(await invoke('grep', { pattern: 'cloud', on: 'a', at: 'current' }))).toBe('a:undefined');
      expect(machine.mock.calls.at(-1)?.[0].attachmentId).toBe('runner-a');
      await runtime.setExecutionMachine(null);
      const selector = createDispatchSelector({ storage: ctx.storage, env, identity, runtime: () => { if (!runtime) throw new Error('Runtime not initialized'); return runtime; } });
      expect((await selector.replica({ at: 'current' }, [runnerB, a])).attachmentId).toBe(a.attachmentId);
      const explicitMissing = await invoke('bash', { command: 'pwd', on: 'b', at: 'current' });
      expect(explicitMissing.status).toBe('failed');
      expect(text(explicitMissing)).toContain('No machine attached');
      const admitted = await invoke('proc', { op: 'start', spec: { name: 'survivor', application: '/bin/sleep', args: ['30'] }, on: 'a' });
      const instanceId = crypto.randomUUID();
      seed({ ...a, state: 'lost' });
      const replacement = RuntimeAttachmentSchema.parse({ ...a, attachmentId: 'a-next', generation: 3, capabilities: ['bash', 'proc'] });
      seed(replacement);
      const control = { originAttemptId: admitted.attemptId, conversationId: String(root.id), taskId: 'process-watch', requestId: 'observe-next-generation', attemptId: 'observe-next-generation', args: { op: 'status', name: 'survivor', instanceId, restartCount: 0 } };
      await services.operations.observeProcess(control);
      expect(machine.mock.calls.at(-1)?.[0]).toMatchObject({ machineId: a.machineId, attachmentId: replacement.attachmentId, generation: replacement.generation, args: control.args });
      seed({ ...replacement, state: 'lost' });
      const beforeOffline = machine.mock.calls.length;
      await expect(services.operations.observeProcess({ ...control, requestId: 'offline-observation', attemptId: 'offline-observation' })).rejects.toThrow(/unreachable/i);
      expect(machine.mock.calls).toHaveLength(beforeOffline);
      seed({ ...replacement, generation: 4 });
      await services.operations.observeProcess(control);
      expect(machine.mock.calls.at(-1)?.[0].generation).toBe(3);
      await services.operations.stopProcess({ ...control, requestId: 'stop-after-reattach', attemptId: 'stop-after-reattach', args: { op: 'stop', name: 'survivor', instanceId, timeoutMs: 5000 } });
      expect(machine.mock.calls.at(-1)?.[0]).toMatchObject({ machineId: a.machineId, generation: 4, args: { op: 'stop', instanceId } });
      seed({ ...replacement, state: 'lost' });
      seed({ ...a, state: 'lost' });
      const onlyRunners = await invoke('bash', { command: 'pwd', at: 'current' });
      expect(onlyRunners.status).toBe('failed');
      expect(text(onlyRunners)).toContain('No machine attached');
    } finally { machine.mockRestore(); await runtime.harness.close(BACKGROUND_CONTEXT); }
  });
});
