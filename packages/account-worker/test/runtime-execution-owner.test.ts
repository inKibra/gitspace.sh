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

async function ownerFixture(ctx: DurableObjectState, identity = RuntimeIdentitySchema.parse({ projectId: 'owner-project', workspaceId: 'owner-workspace' })) {
    const files = new Map([['hello.txt', 'cloud original\n'], ['src/a.ts', 'one\n'], ['src/nested/b.md', 'two\n'], ['other/c.ts', 'three\n']]);
    const trees = new Map<string, ArtifactsTreeEntry[]>();
    const blobs = new Map<string, Blob>();
    const digest = async (value: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-1', new TextEncoder().encode(value)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
    /** Content-addressed trees of the current files, as Artifacts serves them. */
    const writeTree = async (prefix = ''): Promise<string> => {
      const names = new Map<string, boolean>();
      for (const path of files.keys()) if (path.startsWith(prefix)) { const rest = path.slice(prefix.length), slash = rest.indexOf('/'); names.set(slash < 0 ? rest : rest.slice(0, slash), slash >= 0); }
      const entries: ArtifactsTreeEntry[] = [];
      for (const [name, directory] of [...names].sort(([left], [right]) => left < right ? -1 : 1)) {
        if (directory) { entries.push({ name, type: 'tree', mode: '40000', hash: await writeTree(`${prefix}${name}/`) }); continue; }
        const content = files.get(prefix + name) ?? '', hash = await digest(`blob ${content}`);
        blobs.set(hash, new Blob([content]));
        entries.push({ name, type: 'blob', mode: '100644', hash });
      }
      const hash = await digest(`tree ${JSON.stringify(entries)}`);
      trees.set(hash, entries);
      return hash;
    };
    const checkpoint = RuntimeGitCheckpointSchema.parse({ checkpointRef: 'refs/gitspace/checkpoints', headCommit: 'a'.repeat(40), branch: 'main', indexCommit: 'b'.repeat(40), trackedWorktreeCommit: 'c'.repeat(40), worktreeCommit: 'c'.repeat(40), indexTree: 'd'.repeat(40), worktreeTree: await writeTree() });
    let revision = 1;
    const code: WorkspaceRuntimeOptions['code'] = {
      async readFile(_repository, _commit, path) { const value = files.get(path); return value === undefined ? null : new Blob([value]); },
      async listSnapshotPaths() { return [...files.keys()]; },
      reader: () => ({ readTree: async oid => trees.get(oid) ?? null, readBlob: async oid => blobs.get(oid) ?? null, close: async () => {} }),
      mergeSnapshot: unsupported,
      async writeSnapshot(input) {
        for (const mutation of input.mutations) if (mutation.content === null) files.delete(mutation.path); else files.set(mutation.path, new TextDecoder().decode(mutation.content));
        const commit = (++revision).toString(16).padStart(40, '0');
        return Result.ok({ ...input.previous, worktreeCommit: commit, trackedWorktreeCommit: commit, worktreeTree: await writeTree() });
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
    return { runtime, services, root, invoke, text, identity, checkpoint, calls, reports };
}

test('the agent machines list and dispatch see only live attachments heard from recently', async () => {
  await runInDurableObject(env.SPACE_AUTHORITY.getByName(`machines-list:${crypto.randomUUID()}`), async (_instance, ctx) => {
    const { runtime, invoke, text, identity } = await ownerFixture(ctx);
    const now = new Date().toISOString();
    const live = RuntimeAttachmentSchema.parse({ ...identity, attachmentId: 'live', machineId: 'live', generation: 1, state: 'ready', checkout: { kind: 'shared', branch: 'main' }, capabilities: ['bash'], updatedAt: now, heartbeatAt: now });
    // Removed while ready: its last heartbeat is fresh.
    const destroyed = RuntimeAttachmentSchema.parse({ ...live, attachmentId: 'destroyed', machineId: 'destroyed', state: 'detached' });
    const silent = RuntimeAttachmentSchema.parse({ ...live, attachmentId: 'silent', machineId: 'silent', heartbeatAt: new Date(Date.now() - 60_000).toISOString() });
    for (const attachment of [destroyed, silent, live]) ctx.storage.sql.exec('INSERT OR REPLACE INTO runtime_attachments(id,record,secret) VALUES(?,?,?)', attachment.attachmentId, JSON.stringify(attachment), 'fixture');
    const machine = vi.spyOn(runtime.attachments, 'execute').mockImplementation(async dispatch => ({ status: 'completed', requestId: dispatch.requestId, attemptId: dispatch.attemptId, content: [{ type: 'text', text: dispatch.machineId }] }));
    try {
      expect(RuntimeAttachmentSchema.array().parse(JSON.parse(text(await invoke('machines', { op: 'list' })))).map(item => item.attachmentId)).toEqual(['live']);
      await invoke('bash', { command: 'pwd', on: 'destroyed' });
      ctx.storage.sql.exec('DELETE FROM runtime_attachments WHERE id=?', live.attachmentId);
      await invoke('bash', { command: 'pwd' });
      expect(machine).not.toHaveBeenCalled();
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

test('grep runs only on an attached machine and points at code_search without one', async () => {
  await runInDurableObject(env.SPACE_AUTHORITY.getByName(`grep-machine:${crypto.randomUUID()}`), async (_instance, ctx) => {
    const { runtime, services, root, invoke, text, identity, checkpoint } = await ownerFixture(ctx);
    const machine = vi.spyOn(runtime.attachments, 'execute').mockImplementation(async dispatch => ({ status: 'completed', requestId: dispatch.requestId, attemptId: dispatch.attemptId, content: [{ type: 'text', text: 'ripgrep result' }] }));
    try {
      const unattached = await invoke('grep', { pattern: 'cloud' });
      expect(unattached.status).toBe('failed');
      expect(text(unattached)).toBe('grep runs on an attached machine; use code_search, or attach a machine');
      // The same refusal comes before any approval question.
      await expect(services.tools.preflight({ tool: 'grep', args: { pattern: 'cloud' }, conversationId: String(root.id), taskId: 'proof', requestId: 'preflight', attemptId: 'preflight', replay: 'safe' })).rejects.toThrow('grep runs on an attached machine; use code_search, or attach a machine');
      expect(machine).not.toHaveBeenCalled();
      const now = new Date().toISOString();
      const cache = RuntimeAttachmentSchema.parse({ ...identity, attachmentId: 'search-cache', machineId: 'search-machine', generation: 1, state: 'ready', checkout: { kind: 'shared', branch: 'main' }, capabilities: ['grep'], updatedAt: now, heartbeatAt: now });
      ctx.storage.sql.exec('INSERT OR REPLACE INTO runtime_attachments(id,record,secret) VALUES(?,?,?)', cache.attachmentId, JSON.stringify(cache), 'fixture');
      expect(text(await invoke('grep', { pattern: 'cloud' }))).toBe('ripgrep result');
      expect(machine.mock.calls.at(-1)?.[0]).toMatchObject({ tool: 'grep', machineId: cache.machineId, snapshot: checkpoint });
    } finally { machine.mockRestore(); await runtime.harness.close(BACKGROUND_CONTEXT); }
  });
});

test('code_search answers from the cloud index with no machine and says how far the index trails', async () => {
  await runInDurableObject(env.SPACE_AUTHORITY.getByName(`code-search:${crypto.randomUUID()}`), async (_instance, ctx) => {
    const { runtime, invoke, text, checkpoint } = await ownerFixture(ctx);
    const SearchResult = z.object({ matches: z.array(z.string()), partial: z.boolean(), indexedCommit: z.string(), behind: z.number().nullable() });
    const search = async (args: Parameters<typeof invoke>[1]) => {
      const result = await invoke('code_search', args);
      expect(result.status, text(result)).toBe('completed');
      return SearchResult.parse(JSON.parse(text(result)));
    };
    try {
      const building = await invoke('code_search', { pattern: 'cloud' });
      expect(building.status).toBe('failed');
      expect(text(building)).toContain('still building');
      await runtime.codeSearch.drive();
      expect(await search({ pattern: '(?i)CLOUD', path: '.' })).toEqual({ matches: ['hello.txt:1:cloud original'], partial: false, indexedCommit: checkpoint.worktreeCommit, behind: 0 });
      expect((await search({ pattern: 'one|two', path: 'src' })).matches).toEqual(['src/a.ts:1:one', 'src/nested/b.md:1:two']);
      await invoke('write', { path: 'hello.txt', content: 'updated cloud snapshot\n' });
      // Indexing waits for an alarm; until then the indexed snapshot answers and says it is one behind.
      expect(await search({ pattern: 'cloud' })).toMatchObject({ matches: ['hello.txt:1:cloud original'], indexedCommit: checkpoint.worktreeCommit, behind: 1 });
      await runtime.codeSearch.drive();
      expect(await search({ pattern: 'cloud' })).toMatchObject({ matches: ['hello.txt:1:updated cloud snapshot'], indexedCommit: (await runtime.cloudFiles.snapshot())?.worktreeCommit, behind: 0 });
    } finally { await runtime.harness.close(BACKGROUND_CONTEXT); }
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

test('agents write and edit their own workspace artifacts through local:// in the cloud', async () => {
  const projectId = 'artifact-project';
  const workspaceId = 'artifact-workspace';
  await env.CREDENTIALS.getByName(env.ACCOUNT_ID).bootstrap({ userId: env.ACCOUNT_ID, rootPublicKey: env.AUTH_PUBLIC_KEY, vaultKey: credentialProtocolBase64.encode(new Uint8Array(32).fill(19)) });
  const authority = env.PROJECT_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${projectId}`);
  const project = await authority.bootstrap({ id: projectId, name: 'Artifact owner', repositoryReference: null, baseBranch: 'main', createdBy: 'test' });
  await env.USER_PROJECTS.getByName(env.ACCOUNT_ID).put(await authority.setProjectLifecycle(project.revision, 'active'));
  await authority.putWorkspace({ id: workspaceId, projectId, kind: 'worktree', name: 'Artifacts', branch: 'artifacts', phase: 'code', sourceKind: 'base', sourceRef: 'main', sourceCommit: null, lifecycle: 'active', goalId: null, expectedRevision: 0 });
  await runInDurableObject(env.SPACE_AUTHORITY.getByName(`artifact-proof:${crypto.randomUUID()}`), async (_instance, ctx) => {
    const { runtime, invoke, text } = await ownerFixture(ctx, RuntimeIdentitySchema.parse({ projectId, workspaceId }));
    try {
      const url = 'local://workspace/notes/a.md';
      const written = await invoke('write', { path: url, content: 'first draft\n', message: 'Record notes' });
      expect(written.status, text(written)).toBe('completed');
      expect(text(await invoke('read', { path: url }))).toBe('first draft\n');
      const edited = await invoke('edit', { path: url, edits: [{ oldText: 'first', newText: 'final' }], message: 'Finalize notes' });
      expect(edited.status, text(edited)).toBe('completed');
      expect(text(await invoke('read', { path: url }))).toBe('final draft\n');
      const missed = await invoke('edit', { path: url, edits: [{ oldText: 'first', newText: 'again' }], message: 'Stale edit' });
      expect(missed.status).toBe('failed');
      expect(text(await invoke('read', { path: url }))).toBe('final draft\n');

      const base = await invoke('write', { path: 'local://base/notes/a.md', content: 'shared', message: 'Write project notes' });
      expect(base.status).toBe('failed');
      expect(text(base)).toBe('This workspace can write local://workspace/<path>; local://base/ is written from the project session');
    } finally { await runtime.snapshot(); await runtime.harness.close(BACKGROUND_CONTEXT); }
  });
  expect((await authority.listArtifactScopes()).map(scope => [scope.workspaceId, scope.generation])).toEqual([[workspaceId, 2]]);
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
        expect((await runtime.harness.snapshot(QuestionsDoc, BACKGROUND_CONTEXT))?.items ?? []).toEqual([]);
      }
    } finally { await runtime.snapshot(); await runtime.harness.close(BACKGROUND_CONTEXT); }
  });
});
