import { env, runInDurableObject } from 'cloudflare:test';
import { expect, test, vi } from 'vitest';
import { createModels, createAssistantMessageEventStream, type ToolCall, type AssistantMessage } from '@earendil-works/pi-ai';
import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context';
import { Result } from 'better-result';
import { RuntimeAttachmentSchema, RuntimeGitCheckpointSchema, RuntimeIdentitySchema, WORKSPACE_TOOL_RESULTS_MAX_BYTES, type RuntimeToolResult } from '@gitspace/protocol-runtime';
import { credentialProtocolBase64 } from '@gitspace/protocol';
import { ArtifactsCodeStore, createToolResultStore, createWorkspaceRuntime, type WorkspaceRuntime, type WorkspaceRuntimeOptions } from '@gitspace/runtime-workspace-do';
import { z } from 'zod';
import { createRuntimeServices } from '../src/runtime-services.js';
import { createDispatchSelector } from '../src/runtime-dispatch-selection.js';
import { executorCapabilities } from '../src/runtime-attachments.js';
import { QuestionsDoc, WorkspaceDoc } from '@gitspace/runtime-core';

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
    const attachRequests: string[] = [];
    const services = createRuntimeServices({ ctx, env, identity, images: { store: async image => image }, runtime: () => { if (!runtime) throw new Error('Runtime not initialized'); return runtime; }, schedule: async () => {}, model: unsupported, generateImage: unsupported, judge: unsupported, instructionLoader: { read: unsupported, loadInstructions: async () => '' }, async requestAttachment(machineId) {
      if (!runtime) throw new Error('Runtime not initialized');
      attachRequests.push(machineId);
      return runtime.attachments.requestCache({ ...identity, machineId, checkout: { kind: 'shared', branch: 'main' }, capabilities: [...executorCapabilities] }, true);
    }, documentMarkdown: async () => null });
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
    runtime = await createWorkspaceRuntime({ ...services, onReport: error => { reports.push(error); }, storage: ctx.storage, identity, code, initialCheckpoint: async () => checkpoint, models, model: { provider: 'fixture', modelId: 'fixture' }, lfs: { has: unsupported, get: unsupported, put: unsupported }, retainLfs: async () => {}, retainedRules: { loadRules: async () => [], judge: unsupported, matchAst: unsupported }, editTool: () => 'edit', admitInference: unsupported, bindInferenceConversation: async () => undefined, session: { catalog: async () => ({ models: [], roles: [] }), reload: unsupported }, qa: { list: async () => [], act: unsupported }, attachments: { seal: async value => value, open: async value => value, dispatch: unsupported }, waitUntil: value => ctx.waitUntil(value), schedule: async () => {} });
    const root = await runtime.harness.root(BACKGROUND_CONTEXT);
    const invoke = (tool: string, args: Parameters<typeof services.tools.invoke>[0]['args']) => services.tools.invoke({ tool, args, conversationId: String(root.id), taskId: 'proof', requestId: crypto.randomUUID(), attemptId: crypto.randomUUID(), replay: 'unsafe', signal: AbortSignal.timeout(500) });
    const text = (result: RuntimeToolResult) => result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
    return { runtime, services, root, invoke, text, identity, checkpoint, calls, reports, attachRequests };
}

test('the agent machines list and dispatch see only live attachments whose machine is connected', async () => {
  await runInDurableObject(env.SPACE_AUTHORITY.getByName(`machines-list:${crypto.randomUUID()}`), async (_instance, ctx) => {
    const { runtime, invoke, text, identity } = await ownerFixture(ctx);
    const now = new Date().toISOString();
    const live = RuntimeAttachmentSchema.parse({ ...identity, attachmentId: 'live', machineId: 'live', generation: 1, state: 'ready', checkout: { kind: 'shared', branch: 'main' }, capabilities: ['bash'], updatedAt: now, online: true });
    // Removed while ready and connected.
    const destroyed = RuntimeAttachmentSchema.parse({ ...live, attachmentId: 'destroyed', machineId: 'destroyed', state: 'detached' });
    const silent = RuntimeAttachmentSchema.parse({ ...live, attachmentId: 'silent', machineId: 'silent', online: false });
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
      // Conversations migrated from the removed eval tool call a `space` object; the error names the tools that replaced it.
      const legacy = await execute('return await space.create({ name: "x" });');
      expect(legacy.error).toBe(true);
      expect(legacy.text).toContain('tools.space_workspace');
      // Only the project agent starts other workspaces; this fixture runs in a workspace.
      const started = await invoke('space_workspace', { method: 'start', workspaceId: 'sibling', instruction: 'Begin.' });
      expect(started.status).toBe('failed');
      expect(text(started)).toContain('Only the project agent');
      const child = await runtime.harness.commit(async tx => (await tx.createConversation({ ownership: { kind: 'ownerless' } })).id, BACKGROUND_CONTEXT);
      const denied = await services.tools.invoke({ tool: 'codemode', args: { code: 'return 1' }, conversationId: String(child), taskId: 'subagent', requestId: 'subagent', attemptId: 'subagent', replay: 'unsafe' });
      expect(denied.status).toBe('failed');
      expect(text(denied)).toContain('subagent cannot use codemode');
    } finally { await runtime.snapshot(); await runtime.harness.close(BACKGROUND_CONTEXT); }
  });
});

test('only the project agent manages automations: a workspace agent is refused every method', async () => {
  const draft = { name: 'Nightly audit', trigger: { kind: 'schedule', cron: '0 6 * * *' }, action: { kind: 'messageProjectAgent', instruction: 'Audit dependencies.' } };
  await runInDurableObject(env.SPACE_AUTHORITY.getByName(`automations-workspace:${crypto.randomUUID()}`), async (_instance, ctx) => {
    const { runtime, invoke, text } = await ownerFixture(ctx);
    try {
      for (const args of [{ method: 'list' }, { method: 'test', draft }, { method: 'propose', draft, asked: 'Audit nightly', reason: 'Requested' }]) {
        const refused = await invoke('space_automations', args);
        expect(refused.status).toBe('failed');
        expect(text(refused)).toContain('Only the project agent can change automations');
      }
    } finally { await runtime.harness.close(BACKGROUND_CONTEXT); }
  });
  const projectId = `automations-project-${crypto.randomUUID()}`;
  await runInDurableObject(env.SPACE_AUTHORITY.getByName(`automations-project:${crypto.randomUUID()}`), async (_instance, ctx) => {
    const { runtime, invoke, text } = await ownerFixture(ctx, RuntimeIdentitySchema.parse({ projectId, workspaceId: projectId }));
    try {
      const listed = await invoke('space_automations', { method: 'list' });
      expect(listed.status, text(listed)).toBe('completed');
      expect(JSON.parse(text(listed))).toEqual({ automations: [], settings: { concurrency: 2, dailyRunCap: 50, trusted: [] }, links: [], modelRoles: ['default', 'deep', 'fast', 'taste'] });
    } finally { await runtime.harness.close(BACKGROUND_CONTEXT); }
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
      await expect(services.tools.preflight({ tool: 'grep', args: { pattern: 'cloud' }, conversationId: String(root.id), taskId: 'proof', requestId: 'preflight', attemptId: 'preflight', replay: 'safe' })).rejects.toThrow('Meanwhile, code_search searches the cloud copy without a machine.');
      expect(machine).not.toHaveBeenCalled();
      const now = new Date().toISOString();
      const cache = RuntimeAttachmentSchema.parse({ ...identity, attachmentId: 'search-cache', machineId: 'search-machine', generation: 1, state: 'ready', checkout: { kind: 'shared', branch: 'main' }, capabilities: ['grep'], updatedAt: now, online: true });
      ctx.storage.sql.exec('INSERT OR REPLACE INTO runtime_attachments(id,record,secret) VALUES(?,?,?)', cache.attachmentId, JSON.stringify(cache), 'fixture');
      expect(text(await invoke('grep', { pattern: 'cloud' }))).toBe('ripgrep result');
      expect(machine.mock.calls.at(-1)?.[0]).toMatchObject({ tool: 'grep', machineId: cache.machineId, snapshot: checkpoint });
    } finally { machine.mockRestore(); await runtime.harness.close(BACKGROUND_CONTEXT); }
  });
});

test('a long tool output is kept in the workspace; read and grep page and search it with no machine', async () => {
  await runInDurableObject(env.SPACE_AUTHORITY.getByName(`kept-output:${crypto.randomUUID()}`), async (_instance, ctx) => {
    const { runtime, services, root, invoke, text, calls, reports, identity } = await ownerFixture(ctx);
    try {
      await runtime.harness.commit(async tx => { (await tx.doc(WorkspaceDoc)).phase = 'code'; }, BACKGROUND_CONTEXT);
      const rows = Array.from({ length: 6000 }, (_, index) => `row ${index + 1}${index + 1 === 5555 ? ' needle' : ''}`).join('\n');
      expect((await invoke('write', { path: 'rows.txt', content: rows })).status).toBe('completed');
      calls.push({ type: 'toolCall', id: 'every-row', name: 'read', arguments: { path: 'rows.txt', limit: 6000 } });
      await root.submit({ type: 'input', requestId: 'every-row', content: 'Read every row.' }, BACKGROUND_CONTEXT);
      await root.waitForIdle(withAbortSignal(AbortSignal.timeout(10000), BACKGROUND_CONTEXT));
      if (reports.length) throw new AggregateError(reports, 'Runtime fixture reported errors');
      const result = (await root.context(BACKGROUND_CONTEXT)).messages.find(message => message.role === 'toolResult' && message.toolCallId === 'every-row');
      const shown = result?.role === 'toolResult' ? result.content.flatMap(item => item.type === 'text' ? [item.text] : []).join('\n') : '';
      const reference = `result://${identity.workspaceId}/${String(root.id)}/every-row`;
      expect(shown).toContain(reference);
      expect(shown).not.toContain('needle');
      expect(text(await invoke('read', { path: reference, offset: 5554, limit: 2 })).split('\n').slice(0, 2)).toEqual(['row 5554', 'row 5555 needle']);
      // No machine is attached: grep of a kept output runs in the cloud, and asks for none before an approval.
      await services.tools.preflight({ tool: 'grep', args: { pattern: 'needle', path: reference }, conversationId: String(root.id), taskId: 'proof', requestId: 'preflight', attemptId: 'preflight', replay: 'safe' });
      expect(text(await invoke('grep', { pattern: 'needle', path: reference }))).toBe('5555:row 5555 needle');
    } finally { await runtime.snapshot(); await runtime.harness.close(BACKGROUND_CONTEXT); }
  });
});

test('the project agent and a workspace read another workspace\'s kept output of the project through its object; others are refused', async () => {
  const project = async (projectId: string, workspaceIds: string[]) => {
    const authority = env.PROJECT_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${projectId}`);
    const created = await authority.bootstrap({ id: projectId, name: projectId, repositoryReference: null, baseBranch: 'main', createdBy: 'machine-a' });
    await authority.setProjectLifecycle(created.revision, 'active');
    for (const id of workspaceIds) await authority.putWorkspace({ id, projectId, kind: 'worktree', name: id, branch: id, phase: 'code', sourceKind: 'branch', sourceRef: 'main', sourceCommit: null, lifecycle: 'active', goalId: null, expectedRevision: 0 });
  };
  /** A long output of call `callId` in conversation 1, kept by the workspace's own object. */
  const keep = (workspaceId: string, callId: string, text: string) => runInDurableObject(env.SPACE_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${workspaceId}`), async (_instance, ctx) => createToolResultStore(ctx.storage.sql, workspaceId, WORKSPACE_TOOL_RESULTS_MAX_BYTES).put({ conversationId: '1', callId, text }));
  const projectId = `kept-project-${crypto.randomUUID()}`, otherProjectId = `kept-other-${crypto.randomUUID()}`;
  await project(projectId, [`${projectId}-worker`, `${projectId}-sibling`]);
  await project(otherProjectId, [`${otherProjectId}-worker`]);
  const reference = await keep(`${projectId}-worker`, 'toolu_figma', Array.from({ length: 3000 }, (_, index) => `comment ${index + 1}${index + 1 === 2999 ? ' needle' : ''}`).join('\n'));
  const elsewhere = await keep(`${otherProjectId}-worker`, 'toolu_secret', 'another project\'s output');
  for (const workspaceId of [projectId, `${projectId}-sibling`]) {
    await runInDurableObject(env.SPACE_AUTHORITY.getByName(`kept-reader:${crypto.randomUUID()}`), async (_instance, ctx) => {
      const { runtime, invoke, text } = await ownerFixture(ctx, RuntimeIdentitySchema.parse({ projectId, workspaceId }));
      try {
        const read = await invoke('read', { path: reference, offset: 2998, limit: 2 });
        expect(read.status, text(read)).toBe('completed');
        expect(text(read).split('\n').slice(0, 2)).toEqual(['comment 2998', 'comment 2999 needle']);
        expect(text(await invoke('grep', { pattern: 'needle', path: reference }))).toBe('2999:comment 2999 needle');
        for (const outside of [elsewhere, `result://${projectId}-deleted/1/toolu_figma`]) {
          const refused = await invoke('read', { path: outside });
          expect(refused.status).toBe('failed');
          expect(text(refused)).toMatch(/^Workspace .* is outside this project$/u);
        }
      } finally { await runtime.harness.close(BACKGROUND_CONTEXT); }
    });
  }
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
      expect(text(building)).toMatch(/^code_search is building the first index: .*; retry shortly, or use grep on an attached machine$/u);
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
      expect(value).toMatchObject({ ready: true, initialized: ['goal'], workspace: { projectId, name: 'Agent child', branch: 'agent-child', phase: 'plan', lifecycle: 'active' }, operation: { kind: 'workspace.create', state: 'succeeded' } });
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

test('agents write and edit their own workspace artifacts through drive:// in the cloud', async () => {
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
      const url = 'drive://workspace/notes/a.md';
      const written = await invoke('write', { path: url, content: 'first draft\n', message: 'Record notes' });
      expect(written.status, text(written)).toBe('completed');
      expect(text(await invoke('read', { path: url }))).toBe('first draft\n');
      const edited = await invoke('edit', { path: url, edits: [{ oldText: 'first', newText: 'final' }], message: 'Finalize notes' });
      expect(edited.status, text(edited)).toBe('completed');
      expect(text(await invoke('read', { path: url }))).toBe('final draft\n');
      const missed = await invoke('edit', { path: url, edits: [{ oldText: 'first', newText: 'again' }], message: 'Stale edit' });
      expect(missed.status).toBe('failed');
      expect(text(await invoke('read', { path: url }))).toBe('final draft\n');

      // A text file far over one page reads in pages, and a ':' in its name is encoded rather than read as a selector.
      const log = 'drive://workspace/uploads/log%2010%3A30.txt';
      expect((await invoke('write', { path: log, content: Array.from({ length: 30_000 }, (_, index) => `line ${index + 1}`).join('\n'), message: 'Upload log' })).status).toBe('completed');
      const first = text(await invoke('read', { path: log }));
      expect(first.split('\n')).toHaveLength(2_000);
      expect(first).toMatch(/line 1998\n\n\[28002 more lines; read again with offset 1999\]$/u);
      expect(text(await invoke('read', { path: log, offset: 29_999 }))).toBe('line 29999\nline 30000');

      const base = await invoke('write', { path: 'drive://base/notes/a.md', content: 'shared', message: 'Write project notes' });
      expect(base.status).toBe('failed');
      expect(text(base)).toBe('This workspace can write drive://workspace/<path>; drive://base/ is written from the project session');
    } finally { await runtime.snapshot(); await runtime.harness.close(BACKGROUND_CONTEXT); }
  });
  expect((await authority.listArtifactScopes()).map(scope => [scope.workspaceId, scope.generation])).toEqual([[workspaceId, 3]]);
});

test('shell, structural reads, and lifecycle runs fail without an available machine', async () => {
  await runInDurableObject(env.SPACE_AUTHORITY.getByName(`preflight:${crypto.randomUUID()}`), async (_instance, ctx) => {
    const { runtime, root, calls } = await ownerFixture(ctx);
    await runtime.harness.commit(async tx => {
      (await tx.doc(WorkspaceDoc)).phase = 'code';
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

/** Account machines the attach tests choose from, removed afterwards so other tests see an empty fleet. */
async function withFleet(machines: Array<{ label: string; online?: boolean; agentsMayAttach?: boolean }>, defaultLabel: string | null, run: (ids: Record<string, string>) => Promise<void>) {
  const catalog = env.FLEET_CATALOG.getByName(env.ACCOUNT_ID);
  const settings = env.USER_SETTINGS.getByName(env.ACCOUNT_ID);
  const ids: Record<string, string> = {};
  const setDefault = async (machineId: string | null) => {
    const current = await settings.get('test');
    const result = await settings.update('test', { expectedRevision: current.revision, onboardingComplete: current.onboardingComplete, profile: current.profile, git: current.git, defaults: { ...current.defaults, machineId } });
    if (result.status !== 'ok') throw new Error('Default machine fixture conflicted');
  };
  for (const machine of machines) {
    const id = `attach-${crypto.randomUUID()}`;
    ids[machine.label] = id;
    await catalog.putMachine({ id, label: machine.label, state: machine.online === false ? 'offline' : 'online', rpcEndpoint: null, kind: 'physical', provider: 'physical', notes: '', desiredState: 'online', lifecycleRevision: 0, operationId: null, error: null, ...(machine.agentsMayAttach === undefined ? {} : { agentsMayAttach: machine.agentsMayAttach }) });
  }
  try {
    await setDefault(defaultLabel === null ? null : ids[defaultLabel] ?? null);
    await run(ids);
  } finally {
    await setDefault(null);
    for (const id of Object.values(ids)) await catalog.removeMachine(id);
  }
}
const machineId = (ids: Record<string, string>, label: string) => { const id = ids[label]; if (!id) throw new Error(`No fixture machine ${label}`); return id; };

/** One agent `machines attach` call in a fresh workspace; `earlier` attachments are this workspace's history. */
async function attachInFreshWorkspace(args: { machine?: string; needs?: string[] }, earlier: Array<{ machineId: string; capabilities: string[] }> = []) {
  let outcome: unknown;
  let error: string | null = null;
  let requested: string[] = [];
  let questions: unknown[] = [];
  await runInDurableObject(env.SPACE_AUTHORITY.getByName(`machines-attach:${crypto.randomUUID()}`), async (_instance, ctx) => {
    const fixture = await ownerFixture(ctx);
    try {
      for (const [index, item] of earlier.entries()) {
        const record = RuntimeAttachmentSchema.parse({ ...fixture.identity, attachmentId: `earlier-${index}`, machineId: item.machineId, generation: index, state: 'detached', checkout: { kind: 'shared', branch: 'main' }, capabilities: item.capabilities, updatedAt: new Date().toISOString() });
        ctx.storage.sql.exec('INSERT INTO runtime_attachments(id,record,secret) VALUES(?,?,?)', record.attachmentId, JSON.stringify(record), 'fixture');
      }
      const result = await fixture.invoke('machines', { op: 'attach', ...args });
      if (result.status === 'completed') outcome = JSON.parse(fixture.text(result));
      else error = fixture.text(result);
      requested = fixture.attachRequests;
      // The request goes out and the call returns: the attachment waits for the machine's setup.
      expect(fixture.runtime.attachments.list().filter(item => item.state === 'attaching').map(item => item.machineId)).toEqual(requested);
      questions = (await fixture.runtime.harness.snapshot(QuestionsDoc, BACKGROUND_CONTEXT))?.items ?? [];
    } finally { await fixture.runtime.snapshot(); await fixture.runtime.harness.close(BACKGROUND_CONTEXT); }
  });
  return { outcome, error, requested, questions };
}

test('machines attach picks the named machine, else the default, else an online machine offering what is needed', async () => {
  await withFleet([{ label: 'Alpha' }, { label: 'Bravo' }, { label: 'Charlie', online: false }], 'Bravo', async ids => {
    const alpha = machineId(ids, 'Alpha'), bravo = machineId(ids, 'Bravo'), charlie = machineId(ids, 'Charlie');
    expect(await attachInFreshWorkspace({ machine: 'Alpha' })).toMatchObject({ outcome: { state: 'attaching', machineId: alpha, label: 'Alpha' }, requested: [alpha] });
    expect(await attachInFreshWorkspace({})).toMatchObject({ outcome: { state: 'attaching', machineId: bravo, label: 'Bravo' }, requested: [bravo] });
    // The default does not offer a GPU and the machine that did is offline, so the online one that did is chosen.
    expect(await attachInFreshWorkspace({ needs: ['gpu'] }, [{ machineId: alpha, capabilities: ['bash', 'gpu'] }, { machineId: charlie, capabilities: ['bash', 'gpu'] }])).toMatchObject({ outcome: { state: 'attaching', machineId: alpha }, requested: [alpha] });
    expect(await attachInFreshWorkspace({ machine: 'Charlie' })).toMatchObject({ error: 'Charlie is offline. Start GitSpace on Charlie or attach another machine.', requested: [] });
    expect(await attachInFreshWorkspace({ needs: ['tpu'] })).toMatchObject({ error: 'No online machine offers tpu.', requested: [] });
  });
});

test('machines attach asks the user instead of attaching a machine agents may not attach', async () => {
  await withFleet([{ label: 'Private', agentsMayAttach: false }, { label: 'Shared' }], 'Private', async ids => {
    const privateId = machineId(ids, 'Private');
    const named = await attachInFreshWorkspace({ machine: 'Private' });
    expect(named).toMatchObject({ outcome: { state: 'awaiting-approval', machineId: privateId, label: 'Private' }, requested: [] });
    expect(named.questions).toEqual([expect.objectContaining({ kind: 'approval', answer: null, tool: { name: 'machines', args: { op: 'attach', machine: privateId } } })]);
    // Unnamed, a permitted machine is preferred over a default agents may not attach.
    expect(await attachInFreshWorkspace({})).toMatchObject({ outcome: { state: 'attaching', machineId: machineId(ids, 'Shared') }, questions: [] });
  });
});

test('a machine tool with no ready machine attaches the default one and says to retry; the conversation hears when it is ready', async () => {
  await withFleet([{ label: 'Darktop' }], 'Darktop', async ids => {
    const darktop = machineId(ids, 'Darktop');
    await runInDurableObject(env.SPACE_AUTHORITY.getByName(`first-need:${crypto.randomUUID()}`), async (_instance, ctx) => {
      const { runtime, root, calls, attachRequests } = await ownerFixture(ctx);
      const machine = vi.spyOn(runtime.attachments, 'execute');
      await runtime.harness.commit(async tx => {
        (await tx.doc(WorkspaceDoc)).phase = 'code';
      }, BACKGROUND_CONTEXT);
      try {
        calls.push({ type: 'toolCall', id: 'shell', name: 'bash', arguments: { command: 'pwd' } });
        await root.submit({ type: 'input', requestId: 'shell', content: 'Run the requested tool.' }, BACKGROUND_CONTEXT);
        await root.waitForIdle(withAbortSignal(AbortSignal.timeout(2000), BACKGROUND_CONTEXT));
        const result = (await root.context(BACKGROUND_CONTEXT)).messages.find(message => message.role === 'toolResult' && message.toolCallId === 'shell');
        if (!result || result.role !== 'toolResult') throw new Error('Missing tool result');
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain('No machine was ready, so Darktop is being attached to this workspace. Retry this call when its setup finishes');
        // Attaching happens instead of running; nothing ran.
        expect((await runtime.harness.snapshot(QuestionsDoc, BACKGROUND_CONTEXT))?.items ?? []).toEqual([]);
        expect(machine).not.toHaveBeenCalled();
        expect(attachRequests).toEqual([darktop]);
        const attachment = runtime.attachments.list().find(item => item.machineId === darktop);
        if (!attachment) throw new Error('Darktop was not attached');
        expect(attachment.state).toBe('attaching');
        ctx.storage.sql.exec("UPDATE runtime_attachments SET record=json_set(record,'$.state','ready') WHERE id=?", attachment.attachmentId);
        await runtime.cacheReady(attachment.attachmentId, attachment.generation);
        const entries = (await root.entries({}, 100, undefined, BACKGROUND_CONTEXT)).items.filter(entry => entry.kind === 'gitspace.machine-ready');
        expect(entries.map(entry => entry.data)).toEqual([expect.objectContaining({ requestId: `machine-ready:${attachment.attachmentId}:${attachment.generation}`, text: expect.stringContaining('Machine Darktop is attached and ready') })]);
      } finally { machine.mockRestore(); await runtime.snapshot(); await runtime.harness.close(BACKGROUND_CONTEXT); }
    });
  });
});

test('read, write and edit of an absolute /tmp path run on the attached machine; repository paths stay in the cloud copy', async () => {
  await runInDurableObject(env.SPACE_AUTHORITY.getByName(`machine-tmp:${crypto.randomUUID()}`), async (_instance, ctx) => {
    const { runtime, invoke, text, identity } = await ownerFixture(ctx);
    const machine = vi.spyOn(runtime.attachments, 'execute').mockImplementation(async dispatch => ({ status: 'completed', requestId: dispatch.requestId, attemptId: dispatch.attemptId, content: [{ type: 'text', text: `machine ${dispatch.tool}` }] }));
    try {
      const cache = RuntimeAttachmentSchema.parse({ ...identity, attachmentId: 'tmp-cache', machineId: 'tmp-machine', generation: 1, state: 'ready', checkout: { kind: 'shared', branch: 'main' }, capabilities: ['read', 'write', 'edit'], updatedAt: new Date().toISOString(), online: true });
      ctx.storage.sql.exec('INSERT OR REPLACE INTO runtime_attachments(id,record,secret) VALUES(?,?,?)', cache.attachmentId, JSON.stringify(cache), 'fixture');
      expect(text(await invoke('write', { path: '/tmp/frames/notes.txt', content: 'scratch' }))).toBe('machine write');
      expect(text(await invoke('edit', { path: '/tmp/frames/notes.txt', edits: [{ oldText: 'scratch', newText: 'notes' }] }))).toBe('machine edit');
      expect(text(await invoke('read', { path: '/tmp/frames/notes.txt' }))).toBe('machine read');
      expect(machine.mock.calls.map(([dispatch]) => [dispatch.tool, dispatch.machineId])).toEqual([['write', 'tmp-machine'], ['edit', 'tmp-machine'], ['read', 'tmp-machine']]);
      // A repository path, even one named like a temporary directory, is the cloud working copy's.
      expect(text(await invoke('read', { path: 'hello.txt' }))).toContain('cloud original');
      expect((await invoke('read', { path: 'tmp/absent.txt' })).status).toBe('failed');
      expect(machine).toHaveBeenCalledTimes(3);
    } finally { machine.mockRestore(); await runtime.harness.close(BACKGROUND_CONTEXT); }
  });
});
