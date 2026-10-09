import { env, runInDurableObject } from 'cloudflare:test';
import { expect, test, vi } from 'vitest';
import { createModels, createAssistantMessageEventStream, type ToolCall, type AssistantMessage } from '@earendil-works/pi-ai';
import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context';
import { Result } from 'better-result';
import { RuntimeAttachmentSchema, RuntimeGitCheckpointSchema, RuntimeIdentitySchema, type RuntimeToolResult } from '@gitspace/protocol-runtime';
import { credentialProtocolBase64 } from '@gitspace/protocol';
import { ArtifactsCodeStore, createWorkspaceRuntime, type WorkspaceRuntime, type WorkspaceRuntimeOptions } from '@gitspace/runtime-workspace-do';
import { z } from 'zod';
import { createRuntimeServices } from '../src/runtime-services.js';
import { createDispatchSelector } from '../src/runtime-dispatch-selection.js';
import { QuestionsDoc, WorkspaceDoc } from '@gitspace/runtime-core';
import { SessionControlsDoc } from '@gitspace/runtime-core/session-controls';

const unsupported = async (): Promise<never> => { throw new Error('Unexpected external operation'); };

async function ownerFixture(ctx: DurableObjectState) {
    const identity = RuntimeIdentitySchema.parse({ projectId: 'owner-project', workspaceId: 'owner-workspace' });
    const checkpoint = RuntimeGitCheckpointSchema.parse({ checkpointRef: 'refs/gitspace/checkpoints', headCommit: 'a'.repeat(40), branch: 'main', indexCommit: 'b'.repeat(40), trackedWorktreeCommit: 'c'.repeat(40), worktreeCommit: 'c'.repeat(40), indexTree: 'd'.repeat(40), worktreeTree: 'e'.repeat(40) });
    const files = new Map([['hello.txt', 'cloud original\n'], ['src/a.ts', 'one\n'], ['src/nested/b.md', 'two\n'], ['other/c.ts', 'three\n']]);
    let revision = 1;
    const blobs = new Map<string, Blob>();
    const code: WorkspaceRuntimeOptions['code'] = {
      async readFile(_repository, _commit, path) { const value = files.get(path); return value === undefined ? null : new Blob([value]); },
      async listSnapshotPaths() { return [...files.keys()]; },
      async listSnapshotEntries() {
        const entries = new Map<string, { oid: string; mode: string; type: 'blob' | 'commit' }>();
        for (const [path, content] of files) {
          const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(content));
          const oid = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
          blobs.set(oid, new Blob([content]));
          entries.set(path, { oid, mode: '100644', type: 'blob' });
        }
        return entries;
      },
      async readBlob(_repository, oid) { return blobs.get(oid) ?? null; },
      mergeSnapshot: unsupported,
      async writeSnapshot(input) {
        for (const mutation of input.mutations) if (mutation.content === null) files.delete(mutation.path); else files.set(mutation.path, new TextDecoder().decode(mutation.content));
        const commit = (++revision).toString(16).padStart(40, '0');
        return Result.ok({ ...input.previous, worktreeCommit: commit, trackedWorktreeCommit: commit, worktreeTree: commit });
      },
    };
    let runtime: WorkspaceRuntime | undefined;
    const services = createRuntimeServices({ ctx, env, identity, runtime: () => { if (!runtime) throw new Error('Runtime not initialized'); return runtime; }, schedule: async () => {}, model: unsupported, generateImage: unsupported, judge: unsupported, instructionLoader: { read: unsupported, loadInstructions: async () => '' } });
    services.tools.instructions = async () => 'Local codemode fixture instructions.';
    const models = createModels();
    const calls: ToolCall[] = [];
    const reports: unknown[] = [];
    const streamFixture = () => {
      const call = calls.shift();
      const message: AssistantMessage = { role: 'assistant', content: call ? [call] : [{ type: 'text', text: 'Complete.' }], api: 'fixture', provider: 'fixture', model: 'fixture', stopReason: call ? 'toolUse' : 'stop', timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: 'done', reason: call ? 'toolUse' : 'stop', message });
      stream.end(message);
      return stream;
    };
    models.setProvider({ id: 'fixture', name: 'Fixture', auth: { apiKey: { name: 'Fixture', resolve: async () => ({ auth: { apiKey: 'fixture' } }) } }, getModels: () => [{ id: 'fixture', name: 'Fixture', provider: 'fixture', api: 'fixture', baseUrl: 'https://fixture.invalid', input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, reasoning: false, contextWindow: 200000, maxTokens: 1024 }], stream: streamFixture, streamSimple: streamFixture });
    runtime = await createWorkspaceRuntime({ ...services, onReport: error => { reports.push(error); }, storage: ctx.storage, identity, code, initialCheckpoint: async () => checkpoint, models, model: { provider: 'fixture', modelId: 'fixture' }, lfs: { has: unsupported, get: unsupported, put: unsupported }, retainLfs: async () => {}, retainedRules: { loadRules: async () => [], judge: unsupported, matchAst: unsupported }, editTool: () => 'edit', admitInference: unsupported, bindInferenceConversation: async () => [], session: { catalog: async () => ({ models: [], roles: [] }), reload: unsupported }, qa: { list: async () => [], act: unsupported }, attachments: { seal: async value => value, open: async value => value, dispatch: unsupported }, waitUntil: value => ctx.waitUntil(value), schedule: async () => {} });
    const root = await runtime.harness.root(BACKGROUND_CONTEXT);
    const invoke = (tool: string, args: Parameters<typeof services.tools.invoke>[0]['args']) => services.tools.invoke({ tool, args, conversationId: String(root.id), taskId: 'proof', requestId: crypto.randomUUID(), attemptId: crypto.randomUUID(), replay: 'unsafe', signal: AbortSignal.timeout(500) });
    const text = (result: RuntimeToolResult) => result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
    return { runtime, services, root, invoke, text, identity, checkpoint, calls, reports, code };
}

test('cloud file ownership survives attached caches; machine calls select the workspace default and fail immediately when unavailable', async () => {
  await runInDurableObject(env.SPACE_AUTHORITY.getByName(`owner-proof:${crypto.randomUUID()}`), async (_instance, ctx) => {
    const { runtime, services, root, invoke, text, identity, checkpoint } = await ownerFixture(ctx);
    const a = RuntimeAttachmentSchema.parse({ ...identity, attachmentId: 'a', machineId: 'a', generation: 1, role: 'cache', state: 'ready', checkout: { kind: 'shared', branch: 'main' }, capabilities: ['bash'], updatedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString() });
    const b = RuntimeAttachmentSchema.parse({ ...a, attachmentId: 'b', machineId: 'b' });
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
      expect(text(await invoke('bash', { command: 'pwd' }))).toBe(`a:${current?.worktreeCommit}`);
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
      expect(unavailableDefault.status).toBe('completed');
      expect(text(unavailableDefault)).toBe('a:undefined');
      expect(machine.mock.calls).toHaveLength(executed + 1);
      expect(text(await invoke('grep', { pattern: 'cloud', on: 'a', at: 'current' }))).toBe('a:undefined');
      expect(machine.mock.calls.at(-1)?.[0].attachmentId).toBe('runner-a');
      await runtime.setExecutionMachine(null);
      const selector = createDispatchSelector({ storage: ctx.storage, env, identity, runtime: () => { if (!runtime) throw new Error('Runtime not initialized'); return runtime; } });
      expect((await selector.cache({ at: 'current' }, [runnerB, a])).attachmentId).toBe(a.attachmentId);
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
      await expect(services.operations.observeProcess(control)).rejects.toThrow(/unreachable/i);
      expect(machine.mock.calls).toHaveLength(beforeOffline);
      seed({ ...replacement, generation: 4 });
      const replayedObservation = await services.operations.observeProcess(control);
      expect(replayedObservation.attemptId).toBe(machine.mock.calls.at(-1)?.[0].attemptId);
      expect(replayedObservation.attemptId).not.toBe(control.attemptId);
      expect(machine.mock.calls.at(-1)?.[0]).toMatchObject({ machineId: a.machineId, attachmentId: replacement.attachmentId, generation: 4, args: control.args });
      await services.operations.stopProcess({ ...control, requestId: 'stop-after-reattach', attemptId: 'stop-after-reattach', args: { op: 'stop', name: 'survivor', instanceId, timeoutMs: 5000 } });
      expect(machine.mock.calls.at(-1)?.[0]).toMatchObject({ machineId: a.machineId, generation: 4, args: { op: 'stop', instanceId } });
      seed({ ...replacement, attachmentId: 'a-third', generation: 5 });
      await services.operations.stopProcess({ ...control, requestId: 'stop-after-reattach', attemptId: 'stop-after-reattach', args: { op: 'stop', name: 'survivor', instanceId, timeoutMs: 5000 } });
      expect(machine.mock.calls.at(-1)?.[0]).toMatchObject({ machineId: a.machineId, attachmentId: 'a-third', generation: 5, args: { op: 'stop', instanceId } });
      await expect(services.operations.observeProcess({ ...control, args: { ...control.args, name: 'another-process' } })).rejects.toThrow(/identity changed/i);
      seed({ ...replacement, attachmentId: 'a-third', generation: 5, state: 'lost' });
      seed({ ...replacement, state: 'lost' });
      seed({ ...a, state: 'lost' });
      const onlyRunners = await invoke('bash', { command: 'pwd', at: 'current' });
      expect(onlyRunners.status).toBe('failed');
      expect(text(onlyRunners)).toContain('No machine attached');
    } finally { machine.mockRestore(); await runtime.harness.close(BACKGROUND_CONTEXT); }
  });
});

test('the agent machines list and dispatch see only live attachments heard from recently', async () => {
  await runInDurableObject(env.SPACE_AUTHORITY.getByName(`machines-list:${crypto.randomUUID()}`), async (_instance, ctx) => {
    const { runtime, invoke, text, identity } = await ownerFixture(ctx);
    const now = new Date().toISOString();
    const cache = { state: 'paused', platform: 'linux', activity: [], lastActivityAt: now, pausedAt: now, reclaimAt: null, lastSyncAt: now, localWorkOptIn: false, setup: [] };
    const live = RuntimeAttachmentSchema.parse({ ...identity, attachmentId: 'live', machineId: 'live', generation: 1, role: 'cache', state: 'ready', checkout: { kind: 'shared', branch: 'main' }, capabilities: ['bash'], updatedAt: now, heartbeatAt: now });
    // Destroyed while ready: its last heartbeat is fresh and its cache observation still reads paused.
    const destroyed = RuntimeAttachmentSchema.parse({ ...live, attachmentId: 'destroyed', machineId: 'destroyed', state: 'lost', lossReason: 'machine-destroyed', cache });
    const silent = RuntimeAttachmentSchema.parse({ ...live, attachmentId: 'silent', machineId: 'silent', heartbeatAt: new Date(Date.now() - 60_000).toISOString() });
    for (const attachment of [destroyed, silent, live]) ctx.storage.sql.exec('INSERT OR REPLACE INTO runtime_attachments(id,record,secret) VALUES(?,?,?)', attachment.attachmentId, JSON.stringify(attachment), 'fixture');
    const machine = vi.spyOn(runtime.attachments, 'execute').mockImplementation(async dispatch => ({ status: 'completed', requestId: dispatch.requestId, attemptId: dispatch.attemptId, content: [{ type: 'text', text: dispatch.machineId }] }));
    try {
      expect(RuntimeAttachmentSchema.array().parse(JSON.parse(text(await invoke('machines', { op: 'list' })))).map(item => item.attachmentId)).toEqual(['live']);
      expect(text(await invoke('bash', { command: 'pwd', on: 'destroyed' }))).toContain('No machine attached');
      ctx.storage.sql.exec('DELETE FROM runtime_attachments WHERE id=?', live.attachmentId);
      expect(text(await invoke('bash', { command: 'pwd' }))).toContain('No machine attached');
      expect(machine).not.toHaveBeenCalled();
    } finally { machine.mockRestore(); await runtime.harness.close(BACKGROUND_CONTEXT); }
  });
});

test('equal canonical caches fall back from stale defaults and require readiness after reconnect', async () => {
  await runInDurableObject(env.SPACE_AUTHORITY.getByName(`cache-offline:${crypto.randomUUID()}`), async (_instance, ctx) => {
    const { runtime, invoke, text, identity } = await ownerFixture(ctx);
    const now = new Date().toISOString();
    const cache = { state: 'live', platform: 'linux', activity: [], lastActivityAt: now, pausedAt: null, reclaimAt: null, lastSyncAt: now, localWorkOptIn: false, setup: [] };
    const a = RuntimeAttachmentSchema.parse({ ...identity, attachmentId: 'cache-a', machineId: 'cache-a', generation: 1, role: 'cache', state: 'ready', checkout: { kind: 'shared', branch: 'main' }, capabilities: ['bash'], updatedAt: now, heartbeatAt: now, cache });
    const b = RuntimeAttachmentSchema.parse({ ...a, attachmentId: 'cache-b', machineId: 'cache-b' });
    const seed = (attachment: typeof a) => ctx.storage.sql.exec('INSERT OR REPLACE INTO runtime_attachments(id,record,secret) VALUES(?,?,?)', attachment.attachmentId, JSON.stringify(attachment), 'fixture');
    const machine = vi.spyOn(runtime.attachments, 'execute').mockImplementation(async dispatch => ({ status: 'completed', requestId: dispatch.requestId, attemptId: dispatch.attemptId, content: [{ type: 'text', text: dispatch.machineId }] }));
    try {
      seed(a); seed(b);
      await runtime.setExecutionMachine(b.machineId);
      seed({ ...b, heartbeatAt: new Date(Date.now() - 31_000).toISOString() });
      expect(text(await invoke('bash', { command: 'pwd' }))).toBe(a.machineId);
      seed({ ...a, heartbeatAt: new Date(Date.now() - 31_000).toISOString() });
      const before = machine.mock.calls.length;
      expect((await invoke('bash', { command: 'pwd' })).status).toBe('failed');
      expect(machine.mock.calls.length).toBe(before);
      const resumed = runtime.attachments.heartbeat({ ...identity, machineId: a.machineId, attachmentId: a.attachmentId, generation: a.generation, executionObservation: { activeExecutions: 0, observedAt: now } });
      expect(resumed.state).toBe('attaching');
      expect((await invoke('bash', { command: 'pwd' })).status).toBe('failed');
    } finally { machine.mockRestore(); await runtime.harness.close(BACKGROUND_CONTEXT); }
  });
});

test('codemode executes in a cloud isolate without a machine and composes cloud read/write', async () => {
  await runInDurableObject(env.SPACE_AUTHORITY.getByName(`codemode-proof:${crypto.randomUUID()}`), async (_instance, ctx) => {
    const { runtime, root, services, invoke, text, calls, reports } = await ownerFixture(ctx);
    await runtime.harness.commit(async tx => {
      (await tx.doc(WorkspaceDoc)).phase = 'code';
      (await tx.doc(SessionControlsDoc, root.id)).approvalMode = 'yolo';
    }, BACKGROUND_CONTEXT);
    const execute = async (code: string, timeoutMs = 3000) => {
      const callId = crypto.randomUUID();
      calls.push({ type: 'toolCall', id: callId, name: 'codemode', arguments: { code, timeoutMs } });
      await root.submit({ type: 'input', requestId: callId, content: 'Execute the fixture code.' }, BACKGROUND_CONTEXT);
      await root.waitForIdle(withAbortSignal(AbortSignal.timeout(10000), BACKGROUND_CONTEXT));
      if (reports.length) throw new AggregateError(reports, 'Runtime fixture reported errors');
      const result = (await root.context(BACKGROUND_CONTEXT)).messages.find(message => message.role === 'toolResult' && message.toolCallId === callId);
      if (!result || result.role !== 'toolResult') throw new Error('Missing durable codemode result');
      return { error: result.isError, text: result.content.filter(item => item.type === 'text').map(item => item.text).join('\n') };
    };
    try {
      const isolated = await execute('return { process: typeof process, require: typeof require, binding: typeof env };');
      expect(isolated.error, isolated.text).not.toBe(true);
      expect(isolated.text).toContain('"process":"undefined"');
      expect(isolated.text).toContain('"require":"undefined"');
      expect(isolated.text).toContain('"binding":"undefined"');
      const composed = await execute('await tools.write({ path: "sandbox.txt", content: "isolated cloud write" }); return await tools.read({ path: "sandbox.txt" });');
      expect(composed.error, composed.text).not.toBe(true);
      expect(composed.text).toContain('isolated cloud write');
      expect(text(await invoke('read', { path: 'sandbox.txt' }))).toContain('isolated cloud write');
      // Exercise module loading inside the untrusted isolate, not this test host.
      expect((await execute('return await import("node:fs");')).error).toBe(true);
      expect((await execute('return await fetch("https://escape.invalid");')).error).toBe(true);
      expect((await execute('return "x".repeat(100000);')).error).toBe(true);
      // Real workerd isolate timers are not controlled by host fake timers.
      const timedOut = await execute('const waiting = Promise.withResolvers(); setTimeout(waiting.resolve, 10000); await waiting.promise;', 50);
      expect(timedOut.error, timedOut.text).toBe(true);
      expect(timedOut.text).toContain('time limit');
      const child = await runtime.harness.commit(async tx => (await tx.createConversation({ ownership: { kind: 'ownerless' } })).id, BACKGROUND_CONTEXT);
      const denied = await services.tools.invoke({ tool: 'codemode', args: { code: 'return 1' }, conversationId: String(child), taskId: 'subagent', requestId: 'subagent', attemptId: 'subagent', replay: 'unsafe' });
      expect(denied.status).toBe('failed');
      expect(text(denied)).toContain('Subagent');
    } finally { await runtime.snapshot(); await runtime.harness.close(BACKGROUND_CONTEXT); }
  });
});

test('grep searches the current cloud snapshot without a machine cache', async () => {
  await runInDurableObject(env.SPACE_AUTHORITY.getByName(`grep-proof:${crypto.randomUUID()}`), async (_instance, ctx) => {
    const { runtime, invoke, text } = await ownerFixture(ctx);
    try {
      const result = await invoke('grep', { pattern: '(?i)CLOUD', path: '.' });
      expect(result.status).toBe('completed');
      expect(text(result)).toContain('hello.txt:1:cloud original');
    } finally { await runtime.harness.close(BACKGROUND_CONTEXT); }
  });
});

test('grep admits only a caught-up cache and falls back to the current cloud snapshot', async () => {
  await runInDurableObject(env.SPACE_AUTHORITY.getByName(`grep-routing:${crypto.randomUUID()}`), async (_instance, ctx) => {
    const { runtime, invoke, text, identity, checkpoint } = await ownerFixture(ctx);
    const cache = RuntimeAttachmentSchema.parse({ ...identity, attachmentId: 'search-cache', machineId: 'search-machine', generation: 1, role: 'cache', state: 'ready', checkout: { kind: 'shared', branch: 'main' }, capabilities: ['grep'], updatedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString() });
    const seed = (commit: string) => ctx.storage.sql.exec('INSERT OR REPLACE INTO runtime_attachments(id,record,secret) VALUES(?,?,?)', cache.attachmentId, JSON.stringify({ ...cache, executionObservation: { activeExecutions: 0, observedAt: new Date().toISOString(), materializedCommit: commit } }), 'fixture');
    const machine = vi.spyOn(runtime.attachments, 'execute').mockImplementation(async dispatch => ({ status: 'completed', requestId: dispatch.requestId, attemptId: dispatch.attemptId, content: [{ type: 'text', text: 'cache-hit' }] }));
    try {
      seed('0'.repeat(40));
      expect(text(await invoke('grep', { pattern: 'cloud' }))).toContain('hello.txt:1:cloud original');
      expect(machine).not.toHaveBeenCalled();
      seed(checkpoint.worktreeCommit);
      expect(text(await invoke('grep', { pattern: 'cloud' }))).toBe('cache-hit');
      expect(machine.mock.calls.at(-1)?.[0]).toMatchObject({ machineId: cache.machineId, snapshot: checkpoint });
      await invoke('write', { path: 'hello.txt', content: 'updated cloud snapshot\n' });
      expect(text(await invoke('grep', { pattern: 'cloud' }))).toContain('hello.txt:1:updated cloud snapshot');
      expect(machine).toHaveBeenCalledTimes(1);
      const current = await runtime.cloudFiles.snapshot();
      if (!current) throw new Error('Expected current snapshot');
      seed(current.worktreeCommit);
      machine.mockRejectedValueOnce(new Error('Cache worktree changed after heartbeat'));
      expect(text(await invoke('grep', { pattern: 'cloud' }))).toContain('hello.txt:1:updated cloud snapshot');
      expect(machine).toHaveBeenCalledTimes(2);
    } finally { machine.mockRestore(); await runtime.harness.close(BACKGROUND_CONTEXT); }
  });
});

test('grep selects a healthy caught-up cache before a failing cloud index', async () => {
  await runInDurableObject(env.SPACE_AUTHORITY.getByName(`grep-index-failure:${crypto.randomUUID()}`), async (_instance, ctx) => {
    const { runtime, invoke, text, identity, checkpoint, code } = await ownerFixture(ctx);
    const cache = RuntimeAttachmentSchema.parse({ ...identity, attachmentId: 'search-cache', machineId: 'search-machine', generation: 1, role: 'cache', state: 'ready', checkout: { kind: 'shared', branch: 'main' }, capabilities: ['grep'], updatedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(), executionObservation: { activeExecutions: 0, observedAt: new Date().toISOString(), materializedCommit: checkpoint.worktreeCommit } });
    ctx.storage.sql.exec('INSERT OR REPLACE INTO runtime_attachments(id,record,secret) VALUES(?,?,?)', cache.attachmentId, JSON.stringify(cache), 'fixture');
    ctx.storage.sql.exec('DELETE FROM runtime_search_state');
    const index = vi.spyOn(code, 'listSnapshotEntries').mockRejectedValue(new Error('Search index unavailable'));
    const machine = vi.spyOn(runtime.attachments, 'execute').mockImplementation(async dispatch => ({ status: 'completed', requestId: dispatch.requestId, attemptId: dispatch.attemptId, content: [{ type: 'text', text: 'cache-hit' }] }));
    try {
      const result = await invoke('grep', { pattern: 'cloud' });
      expect(result.status).toBe('completed');
      expect(text(result)).toBe('cache-hit');
      expect(index).not.toHaveBeenCalled();
      expect(machine.mock.calls.at(-1)?.[0]).toMatchObject({ tool: 'grep', snapshot: checkpoint });
    } finally { index.mockRestore(); machine.mockRestore(); await runtime.harness.close(BACKGROUND_CONTEXT); }
  });
});

test('agent workspace creation and phase changes run in the cloud with no machine attached', async () => {
  const projectId = 'owner-project';
  const source = '1'.repeat(40);
  const repository: ArtifactsRepoInfo = { id: 'repo', name: 'repo', description: null, defaultBranch: 'main', createdAt: '', updatedAt: '', lastPushAt: null, source: null, readOnly: false, remote: 'https://artifacts.invalid/repo.git' };
  vi.spyOn(ArtifactsCodeStore.prototype, 'ensureEmptyProject').mockResolvedValue(repository);
  vi.spyOn(ArtifactsCodeStore.prototype, 'forkWorkspace').mockResolvedValue(repository);
  vi.spyOn(ArtifactsCodeStore.prototype, 'resolveRef').mockResolvedValue(source);
  const setBranch = vi.spyOn(ArtifactsCodeStore.prototype, 'setBranch').mockResolvedValue();
  await env.CREDENTIALS.getByName(env.ACCOUNT_ID).bootstrap({ userId: env.ACCOUNT_ID, rootPublicKey: env.AUTH_PUBLIC_KEY, vaultKey: credentialProtocolBase64.encode(new Uint8Array(32).fill(19)) });
  const authority = env.PROJECT_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${projectId}`);
  const project = await authority.bootstrap({ id: projectId, name: 'Agent owner', repositoryReference: null, baseBranch: 'main', createdBy: 'test' });
  await env.USER_PROJECTS.getByName(env.ACCOUNT_ID).put(await authority.setProjectLifecycle(project.revision, 'active'));
  await authority.putWorkspace({ id: 'owner-workspace', projectId, kind: 'worktree', name: 'Owner', branch: 'owner', phase: 'code', sourceKind: 'base', sourceRef: 'main', sourceCommit: null, lifecycle: 'active', goalId: null, expectedRevision: 0 });
  await runInDurableObject(env.SPACE_AUTHORITY.getByName(`owner-proof:${crypto.randomUUID()}`), async (_instance, ctx) => {
    const { runtime, invoke, text } = await ownerFixture(ctx);
    try {
      const goal = { id: 'goal', title: 'Child task', summary: 'Implement the child task', phase: 'plan', requirements: [], updatedBy: 'agent' };
      const created = await invoke('space_workspace', { method: 'create', name: 'Agent child', branch: 'agent-child', sourceKind: 'base', sourceRef: '', phase: 'plan', goal });
      expect(created.status, text(created)).toBe('completed');
      const value = z.object({ workspace: z.object({ id: z.string() }).passthrough() }).passthrough().parse(JSON.parse(text(created)));
      expect(value).toMatchObject({ ready: true, initialized: ['goal'], workspace: { projectId, name: 'Agent child', branch: 'agent-child', phase: 'plan', lifecycle: 'active' }, operation: { kind: 'workspace.create', state: 'succeeded', targetMachines: [] } });
      expect(setBranch).toHaveBeenCalledWith(`workspace-${value.workspace.id}`, 'agent-child', source);
      expect(await env.USER_PROJECTS.getByName(env.ACCOUNT_ID).locateWorkspace(value.workspace.id)).toBe(projectId);
      expect(await env.SPACE_CONTEXT.getByName(JSON.stringify([env.ACCOUNT_ID, projectId, value.workspace.id])).getGoal({ projectId, spaceId: value.workspace.id })).toMatchObject({ title: 'Child task', revision: 1 });

      const phased = await invoke('space_phase', { phase: 'review' });
      expect(phased.status, text(phased)).toBe('completed');
      expect((await runtime.harness.snapshot(WorkspaceDoc, BACKGROUND_CONTEXT))?.phase).toBe('review');
    } finally { await runtime.snapshot(); await runtime.harness.close(BACKGROUND_CONTEXT); }
  });
  expect((await authority.listWorkspaces()).find(workspace => workspace.id === 'owner-workspace')).toMatchObject({ phase: 'review' });
});

test('machine availability precedes approval for shell, structural reads, and lifecycle runs', async () => {
  await runInDurableObject(env.SPACE_AUTHORITY.getByName(`preflight:${crypto.randomUUID()}`), async (_instance, ctx) => {
    const { runtime, root, calls } = await ownerFixture(ctx);
    await runtime.harness.commit(async tx => {
      (await tx.doc(WorkspaceDoc)).phase = 'code';
      (await tx.doc(SessionControlsDoc, root.id)).approvalMode = 'always-ask';
    }, BACKGROUND_CONTEXT);
    const requests: ToolCall[] = [
      { type: 'toolCall', id: 'shell', name: 'bash', arguments: { command: 'pwd' } },
      { type: 'toolCall', id: 'structural-read', name: 'ast_grep', arguments: { pattern: '$A', path: '.' } },
      { type: 'toolCall', id: 'checks', name: 'environment', arguments: { method: 'runChecks', runId: 'no-machine-checks' } },
    ];
    try {
      for (const call of requests) {
        calls.push(call);
        await root.submit({ type: 'input', requestId: call.id, content: 'Run the requested tool.' }, BACKGROUND_CONTEXT);
        await root.waitForIdle(withAbortSignal(AbortSignal.timeout(2000), BACKGROUND_CONTEXT));
        const result = (await root.context(BACKGROUND_CONTEXT)).messages.find(message => message.role === 'toolResult' && message.toolCallId === call.id);
        expect(result).toMatchObject({ role: 'toolResult', isError: true });
        if (!result || result.role !== 'toolResult') throw new Error('Missing tool result');
        expect(result.content.filter(part => part.type === 'text').map(part => part.text).join('\n')).toContain('No machine attached');
        expect((await runtime.harness.snapshot(QuestionsDoc, BACKGROUND_CONTEXT))?.items ?? []).toEqual([]);
      }
    } finally { await runtime.snapshot(); await runtime.harness.close(BACKGROUND_CONTEXT); }
  });
});

test('a completed machine attempt replays its receipt after its cache disappears', async () => {
  await runInDurableObject(env.SPACE_AUTHORITY.getByName(`preflight-replay:${crypto.randomUUID()}`), async (_instance, ctx) => {
    const { runtime, services, root, identity } = await ownerFixture(ctx);
    const now = new Date().toISOString();
    const cache = RuntimeAttachmentSchema.parse({ ...identity, attachmentId: 'receipt-cache', machineId: 'receipt-machine', generation: 1, role: 'cache', state: 'ready', checkout: { kind: 'shared', branch: 'main' }, capabilities: ['bash'], updatedAt: now, heartbeatAt: now });
    ctx.storage.sql.exec('INSERT INTO runtime_attachments(id,record,secret) VALUES(?,?,?)', cache.attachmentId, JSON.stringify(cache), 'fixture');
    const machine = vi.spyOn(runtime.attachments, 'execute').mockImplementation(async dispatch => ({ status: 'completed', requestId: dispatch.requestId, attemptId: dispatch.attemptId, content: [{ type: 'text', text: 'receipt survives disconnect' }] }));
    const input: Parameters<typeof services.tools.invoke>[0] = { tool: 'bash', args: { command: 'pwd' }, conversationId: String(root.id), taskId: 'replay', requestId: 'replay', attemptId: 'replay', replay: 'unsafe' };
    try {
      const first = await services.tools.invoke(input);
      expect(first.status).toBe('completed');
      ctx.storage.sql.exec('DELETE FROM runtime_attachments WHERE id=?', cache.attachmentId);
      await services.tools.preflight(input);
      expect(await services.tools.invoke(input)).toEqual(first);
      expect(machine).toHaveBeenCalledTimes(1);
    } finally { machine.mockRestore(); await runtime.snapshot(); await runtime.harness.close(BACKGROUND_CONTEXT); }
  });
});
