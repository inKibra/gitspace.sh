import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { expect, test, vi } from 'vitest';
import { createModels, createAssistantMessageEventStream, type ToolCall, type AssistantMessage } from '@earendil-works/pi-ai';
import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context';
import type { JsonValue } from '@earendil-works/chord/json';
import { Result } from 'better-result';
import { RuntimeAttachmentSchema, RuntimeGitCheckpointSchema, RuntimeIdentitySchema, WORKSPACE_TOOL_RESULTS_MAX_BYTES, type RuntimeToolResult } from '@gitspace/protocol-runtime';
import { credentialProtocolBase64 } from '@gitspace/protocol';
import { ArtifactsCodeStore, createToolResultStore, createWorkspaceRuntime, type WorkspaceRuntime, type WorkspaceRuntimeOptions } from '@gitspace/runtime-workspace-do';
import { z } from 'zod';
import { createRuntimeServices } from '../src/runtime-services.js';
import { InspectorCloudArtifacts, readInspectorContext } from '../src/account-inspector-data.js';
import { ProjectAuthorityDO } from '../src/project-authority.js';
import { SpaceAuthorityDO } from '../src/space-authority.js';
import { createDispatchSelector } from '../src/runtime-dispatch-selection.js';
import { executorCapabilities } from '../src/runtime-attachments.js';
import { QuestionsDoc, WorkspaceDoc } from '@gitspace/runtime-core';
import { UI_BLOCK_BRIEF, UI_SKILL_DESCRIPTION, uiBlockPrompt } from '@gitspace/protocol/gitspace-ui';
import { emptyWorkspaceStatus } from '@gitspace/protocol-workspace';
import { ServiceTokenGrantSchema } from '@gitspace/protocol-environment';
import { decodeJwt } from 'jose';
import type { ProfileDecision } from '@gitspace/runtime-core/inference';
import { GhostDO, type GhostAgentReply, type GhostAgentRequest } from '../src/ghost.js';
import type { ChatterAuthor, ChatterPost } from '@gitspace/protocol/chatter-contract';

const unsupported = async (): Promise<never> => { throw new Error('Unexpected external operation'); };

async function ownerFixture(ctx: DurableObjectState, identity = RuntimeIdentitySchema.parse({ projectId: 'owner-project', workspaceId: 'owner-workspace' }), decide: (input: { args: JsonValue }) => Promise<ProfileDecision> = unsupported) {
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
    const services = createRuntimeServices({ ctx, env, identity, images: { store: async image => image, load: async image => image }, runtime: () => { if (!runtime) throw new Error('Runtime not initialized'); return runtime; }, schedule: async () => {}, model: unsupported, generateImage: unsupported, webSearch: unsupported, decide, judge: unsupported, profileId: async () => 'conversation-profile', instructionLoader: { read: unsupported, loadInstructions: async () => '' }, async requestAttachment(machineId) {
      if (!runtime) throw new Error('Runtime not initialized');
      attachRequests.push(machineId);
      return runtime.attachments.requestCache({ ...identity, machineId, checkout: { kind: 'shared', branch: 'main' }, capabilities: [...executorCapabilities] }, true);
    }, documentMarkdown: async () => null });
    const instructions = services.tools.instructions;
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
    runtime = await createWorkspaceRuntime({ ...services, onReport: error => { reports.push(error); }, storage: ctx.storage, identity, code, initialCheckpoint: async () => checkpoint, models, model: { provider: 'fixture', modelId: 'fixture' }, lfs: { has: unsupported, get: unsupported, put: unsupported }, retainLfs: async () => {}, retainedRules: { loadRules: async () => [] }, editTool: () => 'edit', admitInference: unsupported, bindInferenceConversation: async () => undefined, session: { catalog: async () => ({ models: [], roles: [] }), reload: unsupported }, attachments: { seal: async value => value, open: async value => value, dispatch: unsupported }, waitUntil: value => ctx.waitUntil(value), schedule: async () => {} });
    const root = await runtime.harness.root(BACKGROUND_CONTEXT);
    const invoke = (tool: string, args: Parameters<typeof services.tools.invoke>[0]['args']) => services.tools.invoke({ tool, args, conversationId: String(root.id), taskId: 'proof', requestId: crypto.randomUUID(), attemptId: crypto.randomUUID(), replay: 'unsafe', signal: AbortSignal.timeout(500) });
    const text = (result: RuntimeToolResult) => result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
    return { runtime, services, root, invoke, text, identity, checkpoint, calls, reports, attachRequests, instructions };
}

test('the agent machines list names every account machine with its platform and this workspace\'s attachment; dispatch uses only live ones', async () => {
  await withFleet([{ label: 'Live' }, { label: 'Silent' }, { label: 'Destroyed' }, { label: 'Laptop', online: false }], null, async ids => {
    const releases = env.TENANT_RELEASES.getByName(env.ACCOUNT_ID);
    await releases.machineProtocol(machineId(ids, 'Live'), { version: null, platform: 'linux-x64' });
    await releases.machineProtocol(machineId(ids, 'Laptop'), { version: null, platform: 'darwin-arm64' });
    await runInDurableObject(env.SPACE_AUTHORITY.getByName(`machines-list:${crypto.randomUUID()}`), async (_instance, ctx) => {
      const { runtime, invoke, text, identity } = await ownerFixture(ctx);
      const now = new Date().toISOString();
      const live = RuntimeAttachmentSchema.parse({ ...identity, attachmentId: 'live', machineId: machineId(ids, 'Live'), generation: 1, state: 'ready', checkout: { kind: 'shared', branch: 'main' }, capabilities: ['bash'], updatedAt: now, online: true });
      // Removed while ready and connected.
      const destroyed = RuntimeAttachmentSchema.parse({ ...live, attachmentId: 'destroyed', machineId: machineId(ids, 'Destroyed'), state: 'detached' });
      const silent = RuntimeAttachmentSchema.parse({ ...live, attachmentId: 'silent', machineId: machineId(ids, 'Silent'), online: false });
      for (const attachment of [destroyed, silent, live]) ctx.storage.sql.exec('INSERT OR REPLACE INTO runtime_attachments(id,record,secret) VALUES(?,?,?)', attachment.attachmentId, JSON.stringify(attachment), 'fixture');
      const machine = vi.spyOn(runtime.attachments, 'execute').mockImplementation(async dispatch => ({ status: 'completed', requestId: dispatch.requestId, attemptId: dispatch.attemptId, content: [{ type: 'text', text: dispatch.machineId }] }));
      try {
        const listed: unknown[] = JSON.parse(text(await invoke('machines', { op: 'list' })));
        expect(listed).toHaveLength(4);
        expect(listed).toEqual(expect.arrayContaining([
          expect.objectContaining({ label: 'Live', platform: 'linux-x64', attachment: { attachmentId: 'live', generation: 1, state: 'ready', online: true } }),
          expect.objectContaining({ label: 'Silent', platform: null, attachment: expect.objectContaining({ attachmentId: 'silent', online: false }) }),
          expect.objectContaining({ label: 'Destroyed', attachment: null }),
          // A machine never attached here, offline, still names itself and its platform.
          expect.objectContaining({ label: 'Laptop', state: 'offline', platform: 'darwin-arm64', agentsMayAttach: true, attachment: null }),
        ]));
        await invoke('bash', { command: 'pwd', on: machineId(ids, 'Destroyed') });
        ctx.storage.sql.exec('DELETE FROM runtime_attachments WHERE id=?', live.attachmentId);
        await invoke('bash', { command: 'pwd' });
        expect(machine).not.toHaveBeenCalled();
      } finally { machine.mockRestore(); await runtime.harness.close(BACKGROUND_CONTEXT); }
    });
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
      const child = await runtime.harness.commit(async tx => (await tx.createConversation({ ownership: { kind: 'ownerless' } })).id, BACKGROUND_CONTEXT);
      const denied = await services.tools.invoke({ tool: 'codemode', args: { code: 'return 1' }, conversationId: String(child), taskId: 'subagent', requestId: 'subagent', attemptId: 'subagent', replay: 'unsafe' });
      expect(denied.status).toBe('failed');
      expect(text(denied)).toContain('subagent cannot use codemode');
    } finally { await runtime.snapshot(); await runtime.harness.close(BACKGROUND_CONTEXT); }
  });
});

test('every agent carries the gitspace-ui brief and lists the skill, never the whole skill, and none once the account turns the skill off', async () => {
  const projectId = `ui-${crypto.randomUUID()}`, workspaceId = `ui-space-${crypto.randomUUID()}`;
  const authority = env.PROJECT_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${projectId}`);
  await authority.bootstrap({ id: projectId, name: 'Bakery', repositoryReference: null, baseBranch: 'main', createdBy: 'user' });
  await authority.putWorkspace({ id: workspaceId, projectId, kind: 'worktree', name: 'Menu', branch: 'menu', phase: 'code', sourceKind: 'base', sourceRef: 'main', sourceCommit: null, lifecycle: 'active', goalId: null, expectedRevision: 0 });
  const prompt = uiBlockPrompt();
  // The workspace's agent, then the project agent (the project's base workspace).
  for (const id of [workspaceId, projectId]) {
    await runInDurableObject(env.SPACE_AUTHORITY.getByName(`ui-skill:${crypto.randomUUID()}`), async (_instance, ctx) => {
      const { runtime, root, instructions } = await ownerFixture(ctx, RuntimeIdentitySchema.parse({ projectId, workspaceId: id }));
      const skills = env.USER_SKILLS.getByName(env.ACCOUNT_ID);
      const child = String(await runtime.harness.commit(async tx => (await tx.createConversation({ ownership: { kind: 'ownerless' } })).id, BACKGROUND_CONTEXT));
      try {
        for (const conversation of [String(root.id), child]) {
          const carried = await instructions(conversation, BACKGROUND_CONTEXT);
          expect(carried).toContain(UI_BLOCK_BRIEF);
          expect(carried).toContain('read skill://gitspace-ui');
          expect(carried).toContain(`- gitspace-ui: ${UI_SKILL_DESCRIPTION} (read skill://gitspace-ui)`);
          expect(carried).not.toContain(prompt);
        }
        const before = (await skills.list()).find(skill => skill.id === 'gitspace-ui');
        if (!before) throw new Error('gitspace-ui is not an account skill');
        const off = await skills.update({ id: 'gitspace-ui', expectedRevision: before.revision, enabled: false, scope: before.scope, exceptions: before.exceptions, assignments: before.assignments });
        try {
          for (const conversation of [String(root.id), child]) {
            const disabled = await instructions(conversation, BACKGROUND_CONTEXT);
            expect(disabled).not.toContain(prompt);
            expect(disabled).not.toContain(UI_BLOCK_BRIEF);
            expect(disabled).not.toContain('skill://gitspace-ui');
          }
        } finally { await skills.update({ id: 'gitspace-ui', expectedRevision: off.revision, enabled: true, scope: before.scope, exceptions: before.exceptions, assignments: before.assignments }); }
      } finally { await runtime.harness.close(BACKGROUND_CONTEXT); }
    });
  }
});

test('only the project agent manages automations: a workspace agent is refused every method', async () => {
  const draft = { name: 'Nightly audit', trigger: { kind: 'schedule', cron: '0 6 * * *' }, action: { kind: 'messageProjectAgent', instruction: 'Audit dependencies.' } };
  await runInDurableObject(env.SPACE_AUTHORITY.getByName(`automations-workspace:${crypto.randomUUID()}`), async (_instance, ctx) => {
    const { runtime, invoke, text } = await ownerFixture(ctx);
    try {
      const calls: Array<Record<string, JsonValue>> = [{ method: 'list' }, { method: 'test', draft }, { method: 'propose', draft, asked: 'Audit nightly', reason: 'Requested' }];
      for (const args of calls) {
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
      const goal = { id: 'goal', title: 'Child task', summary: 'Implement the child task', phase: 'plan', requirements: [] };
      const created = await invoke('space_workspace', { method: 'create', name: 'Agent child', branch: 'agent-child', sourceKind: 'base', sourceRef: '', phase: 'plan', goal });
      expect(created.status, text(created)).toBe('completed');
      const value = z.object({ workspace: z.object({ id: z.string() }).passthrough() }).passthrough().parse(JSON.parse(text(created)));
      expect(value).toMatchObject({ ready: true, initialized: ['goal'], workspace: { projectId, name: 'Agent child', branch: 'agent-child', phase: 'plan', lifecycle: 'active' }, operation: { kind: 'workspace.create', state: 'succeeded' } });
      expect(setBranch).toHaveBeenCalledWith(`workspace-${value.workspace.id}`, 'agent-child', source);
      expect(await env.USER_PROJECTS.getByName(env.ACCOUNT_ID).locateWorkspace(value.workspace.id)).toBe(projectId);
      expect(await env.SPACE_CONTEXT.getByName(JSON.stringify([env.ACCOUNT_ID, projectId, value.workspace.id])).getGoal({ projectId, spaceId: value.workspace.id })).toMatchObject({ title: 'Child task', revision: 1, updatedBy: expect.stringMatching(/^conversation:/u) });

      const phased = await invoke('space_phase', { phase: 'review' });
      expect(phased.status, text(phased)).toBe('completed');
      expect((await runtime.harness.snapshot(WorkspaceDoc, BACKGROUND_CONTEXT))?.phase).toBe('review');
    } finally { await runtime.snapshot(); await runtime.harness.close(BACKGROUND_CONTEXT); }
  });
  expect((await authority.listWorkspaces()).find(workspace => workspace.id === 'owner-workspace')).toMatchObject({ phase: 'review' });
});

test('the agent\'s space_phase keeps the phase rule: it never moves past the workspace it is stacked on', async () => {
  const projectId = 'phase-rule-owner';
  await env.CREDENTIALS.getByName(env.ACCOUNT_ID).bootstrap({ userId: env.ACCOUNT_ID, rootPublicKey: env.AUTH_PUBLIC_KEY, vaultKey: credentialProtocolBase64.encode(new Uint8Array(32).fill(19)) });
  const authority = env.PROJECT_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${projectId}`);
  const project = await authority.bootstrap({ id: projectId, name: 'Phase rule owner', repositoryReference: null, baseBranch: 'main', createdBy: 'test' });
  await env.USER_PROJECTS.getByName(env.ACCOUNT_ID).put(await authority.setProjectLifecycle(project.revision, 'active'));
  for (const [id, name] of [['phase-parent', 'Billing export'], ['phase-member', 'Billing UI']]) {
    await authority.putWorkspace({ id, projectId, kind: 'worktree', name, branch: id, phase: 'code', sourceKind: 'base', sourceRef: 'main', sourceCommit: null, lifecycle: 'active', goalId: null, expectedRevision: 0 });
  }
  expect(await authority.setWorkspaceRelations('phase-member', { dependsOn: [], relatedTo: [], stackedOn: 'phase-parent' })).toMatchObject({ status: 'ok' });
  await runInDurableObject(env.SPACE_AUTHORITY.getByName(`phase-rule:${crypto.randomUUID()}`), async (_instance, ctx) => {
    const { runtime, invoke, text } = await ownerFixture(ctx, RuntimeIdentitySchema.parse({ projectId, workspaceId: 'phase-member' }));
    try {
      const refused = await invoke('space_phase', { phase: 'review' });
      expect(refused.status).toBe('failed');
      expect(text(refused)).toContain("Billing UI can't move to Review: it is stacked on Billing export, which is in Code. Move Billing export forward first, or unstack Billing UI.");
      expect((await runtime.harness.snapshot(WorkspaceDoc, BACKGROUND_CONTEXT))?.phase).not.toBe('review');
    } finally { await runtime.snapshot(); await runtime.harness.close(BACKGROUND_CONTEXT); }
  });
  expect((await authority.getWorkspace('phase-member'))?.phase).toBe('code');
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
    expect(await attachInFreshWorkspace({ needs: ['tpu'] })).toMatchObject({ error: 'No online machine offers tpu. Online: Alpha (platform not reported), Bravo (platform not reported).', requested: [] });
  });
});

test('machines attach finds a machine by its platform, and a miss names what the account has', async () => {
  await withFleet([{ label: 'Darktop' }, { label: 'MacBook-Pro-2.local' }], 'Darktop', async ids => {
    const releases = env.TENANT_RELEASES.getByName(env.ACCOUNT_ID);
    const mac = machineId(ids, 'MacBook-Pro-2.local');
    await releases.machineProtocol(machineId(ids, 'Darktop'), { version: null, platform: 'linux-x64' });
    await releases.machineProtocol(mac, { version: null, platform: 'darwin-arm64' });
    // The default is Darktop; only the Mac offers macOS, darwin-arm64 or arm64.
    for (const needs of [['macos'], ['darwin'], ['darwin-arm64'], ['bash', 'arm64']]) {
      expect(await attachInFreshWorkspace({ needs })).toMatchObject({ outcome: { state: 'attaching', machineId: mac }, requested: [mac] });
    }
    expect(await attachInFreshWorkspace({ needs: ['ios'] })).toMatchObject({ error: 'No online machine offers ios. Online: Darktop (linux-x64), MacBook-Pro-2.local (darwin-arm64).', requested: [] });
    expect(await attachInFreshWorkspace({ machine: 'MacBook' })).toMatchObject({ error: 'No machine is named MacBook. This account\'s machines: Darktop, MacBook-Pro-2.local.', requested: [] });
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

test('an agent runs cloud/destroy for its own workspace; on the project\'s base workspace it is refused before dispatch', async () => {
  const projectId = `destroy-project-${crypto.randomUUID()}`;
  const authority = env.PROJECT_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${projectId}`);
  const created = await authority.bootstrap({ id: projectId, name: projectId, repositoryReference: null, baseBranch: 'main', createdBy: 'machine-a' });
  await authority.setProjectLifecycle(created.revision, 'active');
  await authority.putWorkspace({ id: `${projectId}-worker`, projectId, kind: 'worktree', name: 'worker', branch: 'worker', phase: 'code', sourceKind: 'branch', sourceRef: 'main', sourceCommit: null, lifecycle: 'active', goalId: null, expectedRevision: 0 });
  const cases: Array<{ workspaceId: string; allowed: boolean }> = [{ workspaceId: `${projectId}-worker`, allowed: true }, { workspaceId: projectId, allowed: false }];
  for (const { workspaceId, allowed } of cases) {
    await runInDurableObject(env.SPACE_AUTHORITY.getByName(`destroy:${crypto.randomUUID()}`), async (_instance, ctx) => {
      const { runtime, invoke, text, identity } = await ownerFixture(ctx, RuntimeIdentitySchema.parse({ projectId, workspaceId }));
      const machine = vi.spyOn(runtime.attachments, 'execute').mockImplementation(async dispatch => ({ status: 'completed', requestId: dispatch.requestId, attemptId: dispatch.attemptId, content: [{ type: 'text', text: 'accepted' }] }));
      try {
        const cache = RuntimeAttachmentSchema.parse({ ...identity, attachmentId: 'destroy-cache', machineId: 'destroy-machine', generation: 1, state: 'ready', checkout: { kind: 'shared', branch: 'main' }, capabilities: [...executorCapabilities], updatedAt: new Date().toISOString(), online: true });
        ctx.storage.sql.exec('INSERT OR REPLACE INTO runtime_attachments(id,record,secret) VALUES(?,?,?)', cache.attachmentId, JSON.stringify(cache), 'fixture');
        const request = { method: 'runPhase', runId: 'retire', phase: 'cloud/destroy' };
        if (allowed) {
          const result = await invoke('environment', request);
          expect(result.status, text(result)).toBe('completed');
          expect(machine.mock.calls.map(([dispatch]) => [dispatch.tool, dispatch.machineId, dispatch.args])).toEqual([['lifecycle', 'destroy-machine', { runId: 'retire', phase: 'cloud/destroy' }]]);
        } else {
          await expect(invoke('environment', request)).rejects.toThrow('base workspace');
          expect(machine).not.toHaveBeenCalled();
        }
      } finally { machine.mockRestore(); await runtime.harness.close(BACKGROUND_CONTEXT); }
    });
  }
});

test('environment token signs an app token for a service whose routes admit tokens, and says what is missing otherwise', async () => {
  const workspaceId = `tokens-${crypto.randomUUID().slice(0, 8)}`;
  const hostname = `api--${workspaceId}--${env.TENANT_ID}-srv.gssh.dev`;
  await env.CREDENTIALS.getByName(env.ACCOUNT_ID).bootstrap({ userId: env.ACCOUNT_ID, rootPublicKey: env.AUTH_PUBLIC_KEY, vaultKey: credentialProtocolBase64.encode(new Uint8Array(32).fill(49)) });
  await runInDurableObject(env.SPACE_AUTHORITY.getByName(`tokens:${crypto.randomUUID()}`), async (_instance, ctx) => {
    const { runtime, invoke, text } = await ownerFixture(ctx, RuntimeIdentitySchema.parse({ projectId: 'owner-project', workspaceId }));
    try {
      await expect(invoke('environment', { method: 'token', service: 'api', subject: 'agent/sim' })).rejects.toThrow('"tokens": true');
      // What a materialize run's registration leaves: the vault's key for the service and the URL admitting it.
      const { api } = await env.CREDENTIALS.getByName(env.ACCOUNT_ID).registerServiceTokenUrls(workspaceId, [{ hostname, service: 'api', port: 'http' }]);
      await env.HOSTED_ROUTES.getByName(hostname).registerManaged(env.ACCOUNT_ID, workspaceId, 'api', 'http', api!.issuer, api!.keys);
      const result = await invoke('environment', { method: 'token', service: 'api', subject: 'agent/sim', ttlSeconds: 600, refresh: true });
      expect(result.status, text(result)).toBe('completed');
      const grant = ServiceTokenGrantSchema.parse(JSON.parse(text(result)));
      expect(grant).toMatchObject({ url: `https://${hostname}`, subject: 'agent/sim', header: 'GitSpace-Ingress', refreshToken: expect.any(String) });
      const claims = decodeJwt(grant.token);
      expect(claims).toMatchObject({ aud: `https://${hostname}`, sub: 'agent/sim' });
      expect(claims.exp! - claims.iat!).toBe(600);
      expect(await env.HOSTED_ROUTES.getByName(hostname).managedTokens(env.ACCOUNT_ID, workspaceId)).toMatchObject([{ id: claims.jti, subject: 'agent/sim', refreshable: true }]);
    } finally { await runtime.harness.close(BACKGROUND_CONTEXT); }
  });
});

test('space_workspace list and board give every workspace\'s status in one read of stored rows, and a failed read its reason', async () => {
  const projectId = `board-${crypto.randomUUID().slice(0, 8)}`;
  const authority = env.PROJECT_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${projectId}`);
  await authority.bootstrap({ id: projectId, name: 'Board project', repositoryReference: null, baseBranch: 'main', createdBy: 'test' });
  const workspace = { projectId, kind: 'worktree', sourceKind: 'base', sourceRef: 'main', sourceCommit: null, lifecycle: 'active', goalId: null, expectedRevision: 0 } satisfies Partial<Parameters<typeof authority.putWorkspace>[0]>;
  await authority.putWorkspace({ ...workspace, id: 'billing', name: 'Billing export', branch: 'billing', phase: 'code' });
  await authority.putWorkspace({ ...workspace, id: 'search', name: 'Search index', branch: 'search', phase: 'plan' });
  const index = env.USER_PROJECTS.getByName(env.ACCOUNT_ID);
  // The stored reply is the first characters of a 900-character one; the row says where the whole is.
  await index.setWorkspaceStatus({ projectId, workspaceId: 'billing', status: { ...emptyWorkspaceStatus, primaryColor: 'orange', agents: { ...emptyWorkspaceStatus.agents, orange: 1 } }, waitingOn: { kind: 'ask', prompt: 'Which bucket should exports go to?' }, lastReply: 'Exports are ready;\nwhich bucket?', lastReplySource: { conversationId: '1', ordinal: 7168, characters: 900 }, cursor: 1 });
  await index.setWorkspaceStatus({ projectId, workspaceId: 'search', status: { ...emptyWorkspaceStatus, primaryColor: 'green', agents: { ...emptyWorkspaceStatus.agents, green: 1 } }, waitingOn: null, lastReply: null, cursor: 1 });
  // A journal entry reaches the account index from the journal's own object, after its write.
  await env.SPACE_CONTEXT.getByName(JSON.stringify([env.ACCOUNT_ID, projectId, 'billing'])).appendJournalEntry({
    projectId, spaceId: 'billing', id: 'bucket', kind: 'decision', phase: 'code', title: 'Exports go to the archive bucket', body: '', outcome: null, decisions: [], evidence: [], createdBy: 'agent-a',
  });
  await vi.waitFor(async () => expect((await index.projectWorkspaceJournals(projectId)).billing).toMatchObject([{ kind: 'decision', title: 'Exports go to the archive bucket' }]));
  await env.PROJECT_AUTOMATIONS.getByName(`${env.ACCOUNT_ID}:${projectId}`).link({ projectId, subject: { kind: 'pullRequest', number: 42 }, workspaceId: 'billing', source: 'person', detail: 'Ada' });
  // The account's one-time seed of status rows reads every workspace once; later reads read rows only.
  await index.projectWorkspaceStatuses(projectId);
  await runInDurableObject(env.SPACE_AUTHORITY.getByName(`board:${crypto.randomUUID()}`), async (_instance, ctx) => {
    const { runtime, invoke, text, services } = await ownerFixture(ctx, RuntimeIdentitySchema.parse({ projectId, workspaceId: projectId }));
    // No workspace object is read: the rows are the account's and the project's.
    const workspaceRead = vi.spyOn(env.SPACE_AUTHORITY, 'getByName');
    try {
      const listed = z.array(z.object({ id: z.string(), name: z.string(), status: z.unknown() })).parse(JSON.parse(text(await invoke('space_workspace', { method: 'list' }))));
      expect(listed.find(item => item.id === 'billing')?.status).toEqual({
        activity: 'waiting on a person to answer "Which bucket should exports go to?"', waitingOn: { kind: 'ask', prompt: 'Which bucket should exports go to?' }, pullRequests: [{ number: 42, state: null, checks: null }], since: expect.any(String),
        lastReply: '"Exports are ready; which bucket?…" (32 of 900 characters; whole: tools.history_read({ workspaceId: "billing", conversationId: "1", offset: 7168, limit: 1, textOnly: true }))', journal: [{ kind: 'decision', title: 'Exports go to the archive bucket', at: expect.any(String) }],
      });
      expect(listed.find(item => item.id === 'search')?.status).toMatchObject({ activity: 'working', waitingOn: null, pullRequests: [] });
      const board = text(await invoke('space_workspace', { method: 'board' }));
      expect(board).toMatch(/^Workspace board, .+ UTC \(2 workspaces\):\n/u);
      expect(board).toMatch(/\n- Billing export \(billing\) · code · waiting on a person to answer "Which bucket should exports go to\?" · PR #42 · since \d\d:\d\d\n {2}last message: "Exports are ready; which bucket\?…" \(32 of 900 characters; whole: tools\.history_read\(\{ workspaceId: "billing", conversationId: "1", offset: 7168, limit: 1, textOnly: true \}\)\)\n {2}journal: decision "Exports go to the archive bucket" \(\d\d:\d\d\)\n/u);
      expect(board).toMatch(/\n- Search index \(search\) · plan · working · since \d\d:\d\d$/u);
      // The project agent's turns read the same rows.
      expect((await services.tools.projectBoard?.())?.map(row => row.name)).toEqual(['Billing export', 'Search index']);
      expect(workspaceRead).not.toHaveBeenCalled();
      const unreachable = vi.spyOn(env.USER_PROJECTS, 'getByName').mockImplementation(() => { throw new Error('Network connection lost.'); });
      try {
        const failed = await invoke('space_workspace', { method: 'board' });
        expect(failed.status).toBe('failed');
        expect(text(failed)).toBe('Network connection lost.');
      } finally { unreachable.mockRestore(); }
    } finally { workspaceRead.mockRestore(); await runtime.harness.close(BACKGROUND_CONTEXT); }
  });
});

test('the project agent\'s start steers a busy workspace\'s running turn unless it asks to queue', async () => {
  const projectId = `start-${crypto.randomUUID().slice(0, 8)}`;
  const authority = env.PROJECT_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${projectId}`);
  await authority.bootstrap({ id: projectId, name: 'Start project', repositoryReference: null, baseBranch: 'main', createdBy: 'test' });
  await authority.putWorkspace({ projectId, kind: 'worktree', sourceKind: 'base', sourceRef: 'main', sourceCommit: null, lifecycle: 'active', goalId: null, expectedRevision: 0, id: 'billing', name: 'Billing export', branch: 'billing', phase: 'code' });
  const started = vi.spyOn(SpaceAuthorityDO.prototype, 'runtimeStartFromProject').mockResolvedValue({ accepted: true, cursor: 1, conversationId: 'root', historyFrom: 0 });
  await runInDurableObject(env.SPACE_AUTHORITY.getByName(`start:${crypto.randomUUID()}`), async (_instance, ctx) => {
    const { runtime, invoke } = await ownerFixture(ctx, RuntimeIdentitySchema.parse({ projectId, workspaceId: projectId }));
    try {
      expect((await invoke('space_workspace', { method: 'start', workspaceId: 'billing', instruction: 'Export to the archive bucket.' })).status).toBe('completed');
      expect((await invoke('space_workspace', { method: 'start', workspaceId: 'billing', instruction: 'Then tidy the export names.', when: 'queue' })).status).toBe('completed');
      expect(started.mock.calls.map(([, input]) => input.whenBusy)).toEqual(['steer', 'followUp']);
    } finally { started.mockRestore(); await runtime.harness.close(BACKGROUND_CONTEXT); }
  });
});

/** A project with the stacks Billing export ← Ledger ← Invoices (and an archived Old ledger once stacked on Billing
 * export) and Alpha ← Zeta, and Search index in no stack; each workspace has a stored status row. */
async function stackProject() {
  const projectId = `stack-${crypto.randomUUID().slice(0, 8)}`;
  const authority = env.PROJECT_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${projectId}`);
  await authority.bootstrap({ id: projectId, name: 'Stack project', repositoryReference: null, baseBranch: 'main', createdBy: 'test' });
  const workspace = { projectId, kind: 'worktree', sourceKind: 'base', sourceRef: 'main', sourceCommit: null, goalId: null, expectedRevision: 0, phase: 'code' } satisfies Partial<Parameters<typeof authority.putWorkspace>[0]>;
  const index = env.USER_PROJECTS.getByName(env.ACCOUNT_ID);
  const names: Array<[string, string]> = [['alpha', 'Alpha'], ['billing', 'Billing export'], ['ledger', 'Ledger'], ['invoices', 'Invoices'], ['old', 'Old ledger'], ['search', 'Search index'], ['zeta', 'Zeta']];
  for (const [id, name] of names) {
    await authority.putWorkspace({ ...workspace, id, name, branch: id, lifecycle: id === 'old' ? 'archived' : 'active' });
    await index.setWorkspaceStatus({ projectId, workspaceId: id, status: emptyWorkspaceStatus, waitingOn: null, lastReply: null, cursor: 1 });
  }
  const stacked: Array<[string, string]> = [['ledger', 'billing'], ['invoices', 'ledger'], ['old', 'billing'], ['zeta', 'alpha']];
  for (const [id, stackedOn] of stacked) expect(await authority.setWorkspaceRelations(id, { dependsOn: [], relatedTo: [], stackedOn })).toMatchObject({ status: 'ok' });
  await index.projectWorkspaceStatuses(projectId);
  return projectId;
}

test('a stack\'s head starts, questions and answers only its stack\'s members; a member and a workspace in no stack instruct no one; the project agent reaches any', async () => {
  const projectId = await stackProject();
  const started = vi.spyOn(SpaceAuthorityDO.prototype, 'runtimeStartFromProject').mockResolvedValue({ accepted: true, cursor: 1, conversationId: 'root', historyFrom: 0 });
  const asked = vi.spyOn(SpaceAuthorityDO.prototype, 'projectQuestions').mockResolvedValue([{ id: 'question:1', conversation: 'main', kind: 'ask', prompt: 'Which bucket?', choices: ['assets', 'uploads'], answerable: true, why: null }]);
  const stub = () => env.SPACE_AUTHORITY.getByName(`stack-gate:${crypto.randomUUID()}`);
  try {
    await runInDurableObject(stub(), async (_instance, ctx) => {
      const { runtime, invoke, text } = await ownerFixture(ctx, RuntimeIdentitySchema.parse({ projectId, workspaceId: 'billing' }));
      try {
        // Its members at any depth, steered or queued; the turn each starts reports to the head.
        expect((await invoke('space_workspace', { method: 'start', workspaceId: 'invoices', instruction: 'Sync onto Ledger.' })).status).toBe('completed');
        expect((await invoke('space_workspace', { method: 'start', workspaceId: 'ledger', instruction: 'Then review.', when: 'queue' })).status).toBe('completed');
        expect(started.mock.calls.map(([, input]) => [input.name, input.from, input.whenBusy, input.text])).toEqual([
          ['Invoices', 'billing', 'steer', 'Instruction from Billing export, the head of your stack:\n\nSync onto Ledger.'],
          ['Ledger', 'billing', 'followUp', 'Instruction from Billing export, the head of your stack:\n\nThen review.'],
        ]);
        // A member's questions, and answers proposed on a card in the head's own conversation that names the head.
        expect(text(await invoke('space_workspace', { method: 'questions', workspaceId: 'ledger' }))).toContain('Which bucket?');
        expect((await invoke('space_workspace', { method: 'answer', answers: [{ workspaceId: 'ledger', questionId: 'question:1', answer: 'uploads' }] })).status).toBe('completed');
        const card = (await runtime.harness.snapshot(QuestionsDoc, BACKGROUND_CONTEXT))?.items.find(item => item.tool?.name === 'space_workspace');
        expect(card?.prompt).toMatch(/^Billing export \(stack head\) asks to answer this question for you:\n1\. Ledger: Which bucket\?/u);
        expect(card?.tool?.args).toMatchObject({ by: { by: 'stack-head', workspaceId: 'billing', name: 'Billing export' } });
        // Nothing outside its stack: another stack, a workspace in none, an archived one once stacked on it.
        expect(text(await invoke('space_workspace', { method: 'start', workspaceId: 'zeta', instruction: 'Begin.' }))).toBe('Billing export can\'t start Zeta: Zeta isn\'t in your stack. A stack\'s head reaches only the workspaces stacked on it; the project agent reaches any.');
        expect(text(await invoke('space_workspace', { method: 'questions', workspaceId: 'search' }))).toContain('Search index isn\'t in your stack');
        expect(text(await invoke('space_workspace', { method: 'questions', workspaceId: 'old' }))).toContain('Old ledger isn\'t in your stack');
        expect(text(await invoke('space_workspace', { method: 'answer', answers: [{ workspaceId: 'zeta', questionId: 'question:1', answer: 'uploads' }] }))).toContain('Zeta isn\'t in your stack');
        expect(started).toHaveBeenCalledTimes(2);
      } finally { await runtime.harness.close(BACKGROUND_CONTEXT); }
    });
    for (const [workspaceId, refusal] of [['ledger', /^Ledger can't (start|read the questions of|answer for) Invoices: members don't instruct other workspaces\./u], ['search', /^Search index can't (start|read the questions of|answer for) Invoices: only a stack's head can instruct its members/u]] satisfies Array<[string, RegExp]>) {
      await runInDurableObject(stub(), async (_instance, ctx) => {
        const { runtime, invoke, text } = await ownerFixture(ctx, RuntimeIdentitySchema.parse({ projectId, workspaceId }));
        try {
          for (const call of [{ method: 'start', workspaceId: 'invoices', instruction: 'Begin.' }, { method: 'questions', workspaceId: 'invoices' }, { method: 'answer', answers: [{ workspaceId: 'invoices', questionId: 'question:1', answer: 'uploads' }] }]) {
            const result = await invoke('space_workspace', call);
            expect(result.status).toBe('failed');
            expect(text(result)).toMatch(refusal);
          }
        } finally { await runtime.harness.close(BACKGROUND_CONTEXT); }
      });
    }
    expect(started).toHaveBeenCalledTimes(2);
    await runInDurableObject(stub(), async (_instance, ctx) => {
      const { runtime, invoke } = await ownerFixture(ctx, RuntimeIdentitySchema.parse({ projectId, workspaceId: projectId }));
      try {
        for (const workspaceId of ['search', 'zeta', 'invoices']) expect((await invoke('space_workspace', { method: 'start', workspaceId, instruction: 'Begin.' })).status).toBe('completed');
        expect(started.mock.calls.slice(2).map(([, input]) => [input.name, input.from, input.text])).toEqual(['Search index', 'Zeta', 'Invoices'].map(name => [name, projectId, 'Instruction from the project agent:\n\nBegin.']));
      } finally { await runtime.harness.close(BACKGROUND_CONTEXT); }
    });
  } finally { started.mockRestore(); asked.mockRestore(); }
});

test('the project agent\'s board lists the project stack by stack in the sidebar\'s order; a head\'s turns read its open members in stack order with what each is stacked on, and a workspace heading no stack reads none', async () => {
  const projectId = await stackProject();
  const stub = () => env.SPACE_AUTHORITY.getByName(`stack-board:${crypto.randomUUID()}`);
  await runInDurableObject(stub(), async (_instance, ctx) => {
    const { runtime, invoke, text, services } = await ownerFixture(ctx, RuntimeIdentitySchema.parse({ projectId, workspaceId: projectId }));
    try {
      expect((await services.tools.projectBoard?.())?.map(row => row.name)).toEqual(['Alpha', 'Zeta', 'Billing export', 'Ledger', 'Invoices', 'Search index', 'Old ledger']);
      expect(text(await invoke('space_workspace', { method: 'board' })).split('\n').slice(1).map(line => line.replace(/ \(.*$/u, ''))).toEqual(['- Alpha', '- Zeta', '- Billing export', '- Ledger', '- Invoices', '- Search index']);
      expect(services.tools.stackBoard).toBeUndefined();
    } finally { await runtime.harness.close(BACKGROUND_CONTEXT); }
  });
  for (const [workspaceId, members] of [['billing', [['Ledger', 'Billing export'], ['Invoices', 'Ledger']]], ['alpha', [['Zeta', 'Alpha']]], ['ledger', null], ['search', null]] satisfies Array<[string, string[][] | null]>) {
    await runInDurableObject(stub(), async (_instance, ctx) => {
      const { runtime, services } = await ownerFixture(ctx, RuntimeIdentitySchema.parse({ projectId, workspaceId }));
      try {
        const rows = await services.tools.stackBoard?.();
        expect(rows === null || rows === undefined ? rows : rows.map(row => [row.name, row.stack?.on]), workspaceId).toEqual(members);
        expect(services.tools.projectBoard).toBeUndefined();
      } finally { await runtime.harness.close(BACKGROUND_CONTEXT); }
    });
  }
  // Unstacked, Ledger heads Invoices, and Billing export no stack.
  expect(await env.PROJECT_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${projectId}`).setWorkspaceRelations('ledger', { dependsOn: [], relatedTo: [], stackedOn: null })).toMatchObject({ status: 'ok' });
  for (const [workspaceId, members] of [['ledger', [['Invoices', 'Ledger']]], ['billing', null]] satisfies Array<[string, string[][] | null]>) {
    await runInDurableObject(stub(), async (_instance, ctx) => {
      const { runtime, services } = await ownerFixture(ctx, RuntimeIdentitySchema.parse({ projectId, workspaceId }));
      try {
        const rows = await services.tools.stackBoard?.();
        expect(rows === null || rows === undefined ? rows : rows.map(row => [row.name, row.stack?.on]), workspaceId).toEqual(members);
      } finally { await runtime.harness.close(BACKGROUND_CONTEXT); }
    });
  }
});

/** A project with one worktree workspace, the account vault that seals drive files, and that workspace's drive. */
async function driveWorkspace() {
  const projectId = `drive-history-${crypto.randomUUID()}`, workspaceId = `${projectId}-worker`;
  await env.CREDENTIALS.getByName(env.ACCOUNT_ID).bootstrap({ userId: env.ACCOUNT_ID, rootPublicKey: env.AUTH_PUBLIC_KEY, vaultKey: credentialProtocolBase64.encode(crypto.getRandomValues(new Uint8Array(32))) });
  const authority = env.PROJECT_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${projectId}`);
  const created = await authority.bootstrap({ id: projectId, name: projectId, repositoryReference: null, baseBranch: 'main', createdBy: 'test' });
  await authority.setProjectLifecycle(created.revision, 'active');
  await authority.putWorkspace({ id: workspaceId, projectId, kind: 'worktree', name: 'Plans', branch: 'plans', phase: 'code', sourceKind: 'branch', sourceRef: 'main', sourceCommit: null, lifecycle: 'active', goalId: null, expectedRevision: 0 });
  const drive = new InspectorCloudArtifacts(env, env.ACCOUNT_ID, await readInspectorContext(env, env.ACCOUNT_ID, workspaceId, projectId));
  return { projectId, workspaceId, authority, drive };
}

test('an agent reads a drive file as the drive held it at a time, and before the drive\'s recorded history its oldest version, told where that history starts', async () => {
  const { projectId, workspaceId, authority, drive } = await driveWorkspace();
  const start = Date.now();
  const at = (offset: number) => new Date(start + offset).toISOString();
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    vi.setSystemTime(start + 60_000);
    await drive.write('drive://workspace/plan.md', { bytes: new TextEncoder().encode('plan one') });
    // As if written before drive history was recorded.
    await runInDurableObject(authority, (_instance: ProjectAuthorityDO, state) => { state.storage.sql.exec('DELETE FROM artifact_scope_history'); });
    vi.setSystemTime(start + 120_000);
    await drive.write('drive://workspace/plan.md', { bytes: new TextEncoder().encode('plan two') });
  } finally { vi.useRealTimers(); }
  await runInDurableObject(env.SPACE_AUTHORITY.getByName(`drive-history:${crypto.randomUUID()}`), async (_instance, ctx) => {
    const { runtime, invoke, text } = await ownerFixture(ctx, RuntimeIdentitySchema.parse({ projectId, workspaceId }));
    try {
      expect(text(await invoke('read', { path: 'drive://workspace/plan.md', asOf: at(90_000) }))).toBe(`The drive as of ${at(90_000)}: generation 1, committed ${at(60_000)}.\nplan one`);
      expect(text(await invoke('read', { path: 'drive://workspace/plan.md', asOf: at(150_000) }))).toBe(`The drive as of ${at(150_000)}: generation 2, committed ${at(120_000)}.\nplan two`);
      expect(text(await invoke('read', { path: 'drive://workspace/plan.md', asOf: at(30_000) }))).toBe(`The drive as of ${at(30_000)}: the drive's history starts at ${at(60_000)}; this is the oldest version recorded, generation 1.\nplan one`);
      expect(text(await invoke('read', { path: 'drive://workspace/plan.md' }))).toBe('plan two');
      const refused = await invoke('read', { path: 'hello.txt', asOf: at(30_000) });
      expect([refused.status, text(refused)]).toEqual(['failed', expect.stringContaining('asOf reads drive:// paths only')]);
    } finally { await runtime.harness.close(BACKGROUND_CONTEXT); }
  });
});

test('an agent\'s drive write is read as of the time the write returned on the workspace\'s clock, though the project object\'s clock runs ahead', async () => {
  const { projectId, workspaceId } = await driveWorkspace();
  const put = ProjectAuthorityDO.prototype.putArtifactScope;
  // The project object's clock is 5 s ahead of the workspace's while it commits.
  const ahead = vi.spyOn(ProjectAuthorityDO.prototype, 'putArtifactScope').mockImplementation(function (this: ProjectAuthorityDO, input) {
    vi.setSystemTime(Date.now() + 5_000);
    try { return put.call(this, input); } finally { vi.setSystemTime(Date.now() - 5_000); }
  });
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    await runInDurableObject(env.SPACE_AUTHORITY.getByName(`drive-clock:${crypto.randomUUID()}`), async (_instance, ctx) => {
      const { runtime, invoke, text } = await ownerFixture(ctx, RuntimeIdentitySchema.parse({ projectId, workspaceId }));
      try {
        const written = JSON.parse(text(await invoke('write', { path: 'drive://workspace/plan.md', content: 'plan one' })));
        const returned = new Date().toISOString();
        expect(written).toMatchObject({ generation: 1, committedAt: returned });
        expect(text(await invoke('read', { path: 'drive://workspace/plan.md', asOf: returned }))).toBe(`The drive as of ${returned}: generation 1, committed ${returned}.\nplan one`);
      } finally { await runtime.harness.close(BACKGROUND_CONTEXT); }
    });
  } finally { vi.useRealTimers(); ahead.mockRestore(); }
});

test('an agent\'s chatter_post lands under its workspace; a hand-off is returned with a returned line, and a failing check lets the post through', async () => {
  const projectId = `chatter-${crypto.randomUUID()}`;
  const authority = env.PROJECT_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${projectId}`);
  await authority.bootstrap({ id: projectId, name: 'Chatter project', repositoryReference: null, baseBranch: 'main', createdBy: 'user' });
  for (const [id, name] of [[`${projectId}-parser`, 'Parser'], [`${projectId}-billing`, 'Billing']]) {
    await authority.putWorkspace({ id, projectId, kind: 'worktree', name, branch: id, phase: null, sourceKind: 'branch', sourceRef: 'main', sourceCommit: null, lifecycle: 'active', goalId: null, expectedRevision: 0 });
  }
  const identity = RuntimeIdentitySchema.parse({ projectId, workspaceId: `${projectId}-parser` });
  let answer: number | Error = 0.1;
  const asked: JsonValue[] = [];
  const decide = async (input: { args: JsonValue }): Promise<ProfileDecision> => {
    asked.push(input.args);
    if (answer instanceof Error) throw answer;
    return { answers: { handoff: { bool: answer } }, model: 'fixture', usage: null, fallback: null };
  };
  await runInDurableObject(env.SPACE_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${identity.workspaceId}`), async (_instance, ctx) => {
    const { invoke, text } = await ownerFixture(ctx, identity, decide);
    expect(text(await invoke('chatter_post', { topic: 'bun test hang', kind: 'workaround', text: 'A longer timeout gets past it.' }))).toContain('posted under bun test hang (1 post)');
    expect(text(await invoke('chatter_post', { kind: 'tooling', tool: 'Bash tool', reference: `history://${identity.workspaceId}/main#3`, text: 'bun test hangs on the watcher' }))).toContain('opened issue bun test hangs on the watcher · bash');
    expect(text(await invoke('chatter_post', { kind: 'tooling', tool: 'shell', reference: `history://${identity.workspaceId}/main#9`, text: 'bun test hangs on the watcher' }))).toContain('joined issue bun test hangs on the watcher · bash (2 posts, 1 workspace)');
    answer = 0.9;
    expect(text(await invoke('chatter_post', { topic: 'invoice column', kind: 'coordination', text: '@billing please add an invoice column for me, I will wait.' })))
      .toBe('Not posted: this asks Billing to do work. Chatter is ambient and can\'t assign or hand off work; post what you found or what you need.');
    answer = new Error('Decisions model unavailable');
    expect(text(await invoke('chatter_post', { topic: 'invoice column', kind: 'discovery', text: 'The schema has no invoice column yet.' }))).toContain('posted under invoice column (1 post)');
    expect(asked).toHaveLength(5);
    const { events } = await env.PROJECT_CHATTER.getByName(`${env.ACCOUNT_ID}:${projectId}`).watch({});
    expect(events.flatMap(event => event.type === 'post' ? [[event.author.kind, event.author.name, event.topicKey, event.spot?.tool ?? null]] : [])).toEqual([
      ['workspace', 'Parser', 'bun test hang', null],
      ['workspace', 'Parser', 'bun test hangs on the watcher bash', 'Bash tool'],
      ['workspace', 'Parser', 'bun test hangs on the watcher bash', 'shell'],
      ['workspace', 'Parser', 'invoice column', null],
    ]);
    expect(events.filter(event => event.type === 'returned')).toMatchObject([{ author: { kind: 'workspace', id: identity.workspaceId }, to: 'Billing', topic: 'invoice column', text: '@billing please add an invoice column for me, I will wait.' }]);
    const read = z.object({ topics: z.array(z.object({ topic: z.string(), posts: z.number(), state: z.string().nullable() })), posts: z.array(z.object({ author: z.string(), text: z.string() })) }).parse(JSON.parse(text(await invoke('chatter_read', { issue: true }))));
    expect(read.topics).toEqual([{ topic: 'bun test hangs on the watcher · bash', posts: 2, state: 'open' }]);
    expect(read.posts[0]).toEqual({ author: 'Parser', text: 'The schema has no invoice column yet.' });
  });
});

test('the project agent\'s reply links a workspace it started (one outside the project is refused) and an issue it acted on; it resolves, marks and merges topics as the project agent and sees sameness suggestions; a workspace agent can do neither', async () => {
  const projectId = `chatter-agent-${crypto.randomUUID()}`;
  const authority = env.PROJECT_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${projectId}`);
  await authority.bootstrap({ id: projectId, name: 'Chatter project', repositoryReference: null, baseBranch: 'main', createdBy: 'user' });
  const parserId = `${projectId}-parser`;
  await authority.putWorkspace({ id: parserId, projectId, kind: 'worktree', name: 'Parser', branch: parserId, phase: null, sourceKind: 'branch', sourceRef: 'main', sourceCommit: null, lifecycle: 'active', goalId: null, expectedRevision: 0 });
  const object = env.PROJECT_CHATTER.getByName(`${env.ACCOUNT_ID}:${projectId}`);
  const parser: ChatterAuthor = { kind: 'workspace', id: parserId, name: 'Parser' };
  await object.post({ projectId, id: 'hang-1', topic: 'bun test hangs · bash', kind: 'tooling', text: 'bun test hangs on the watcher.', author: parser, spot: { tool: 'bash', reference: `history://${parserId}/main#3`, machine: null } });
  await object.post({ projectId, id: 'hang-2', topic: 'bun test watcher hang', kind: 'status', text: 'The watcher never exits.', author: parser });
  // The build's sameness check finds the watcher topic the same as the tooling one.
  await runInDurableObject(object, instance => {
    instance.decider = async () => async args => {
      const state = z.object({ existing: z.array(z.object({ id: z.string(), topic: z.string() })), new: z.array(z.object({ id: z.string(), topic: z.string() })) }).parse(args.state);
      const into = state.existing.find(entry => entry.topic === 'bun test hangs · bash')?.id ?? 'missing';
      const asked = state.new.find(entry => entry.topic === 'bun test watcher hang')?.id ?? 'missing';
      return { model: 'test/same', answers: { [asked]: { choice: into, probabilities: { [into]: 0.9 }, confidence: 0.9 } } };
    };
  });
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    vi.setSystemTime(Date.now() + 3 * 60_000);
    expect(await runDurableObjectAlarm(object)).toBe(true);
  } finally { vi.useRealTimers(); }
  const decide = async (): Promise<ProfileDecision> => ({ answers: { handoff: { bool: 0.1 } }, model: 'fixture', usage: null, fallback: null });
  await runInDurableObject(env.SPACE_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${projectId}`), async (_instance, ctx) => {
    const { runtime, invoke, text } = await ownerFixture(ctx, RuntimeIdentitySchema.parse({ projectId, workspaceId: projectId }), decide);
    try {
      const read = z.object({ topics: z.array(z.object({ topic: z.string(), sameAs: z.string().nullable() })), note: z.string() }).parse(JSON.parse(text(await invoke('chatter_read', {}))));
      expect(read.topics).toEqual(expect.arrayContaining([{ topic: 'bun test watcher hang', sameAs: 'bun test hangs · bash' }, { topic: 'bun test hangs · bash', sameAs: null }]));
      expect(read.topics).toHaveLength(2);
      expect(read.note).toContain('sameAs is the sameness check\'s suggestion');

      expect(text(await invoke('chatter_topic', { topic: 'bun test watcher hang', action: 'merge', into: 'bun test hangs · bash' }))).toBe('merged bun test watcher hang into bun test hangs · bash (2 posts)');
      expect(text(await invoke('chatter_topic', { topic: 'bun test hangs · bash', action: 'resolve', fixedIn: '4f2a9c1' }))).toContain('resolved issue bun test hangs · bash (fixed in 4f2a9c1)');
      expect(text(await invoke('chatter_topic', { topic: 'bun test hangs · bash', action: 'file' }))).toContain('marked issue bun test hangs · bash for filing with GitSpace; filing it is a person\'s action');

      expect(text(await invoke('chatter_post', { topic: 'bun test hangs · bash', kind: 'status', text: 'Started Parser on a fix for the watcher.', workspace: 'parser' }))).toContain('linked workspace Parser');
      const nowhere = await invoke('chatter_post', { topic: 'bun test hangs · bash', kind: 'status', text: 'Started a fix.', workspace: 'nowhere' });
      expect(nowhere.status).toBe('failed');
      expect(text(nowhere)).toBe('Not posted: there is no workspace nowhere in this project to link. Link a workspace you started, by its id or name.');
      // An issue named by its merged topic links the topic it went into.
      expect(text(await invoke('chatter_post', { topic: 'bun test hangs · bash', kind: 'status', text: 'Fixed in 4f2a9c1; marked for filing.', issue: 'bun test watcher hang' }))).toContain('linked issue bun test hangs · bash');
    } finally { await runtime.harness.close(BACKGROUND_CONTEXT); }
  });
  const { events, topics } = await object.watch({});
  expect(events.flatMap(event => event.type === 'post' && event.author.kind === 'project' ? [[event.text, event.link]] : [])).toEqual([
    ['Started Parser on a fix for the watcher.', { kind: 'workspace', id: parserId, name: 'Parser' }],
    ['Fixed in 4f2a9c1; marked for filing.', { kind: 'issue', key: 'bun test hangs bash', display: 'bun test hangs · bash' }],
  ]);
  expect(events.some(event => event.type === 'post' && event.text === 'Started a fix.')).toBe(false);
  expect(events.flatMap(event => event.type === 'topic' ? [[event.author.kind, event.change.kind]] : [])).toEqual([['workspace', 'state'], ['project', 'merge'], ['project', 'state'], ['project', 'marked']]);
  expect(topics.find(topic => topic.key === 'bun test hangs bash')).toMatchObject({ state: 'resolved', fixedIn: '4f2a9c1', marked: { by: 'Chatter project' }, posts: 4 });

  await runInDurableObject(env.SPACE_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${parserId}`), async (_instance, ctx) => {
    const { runtime, invoke, text } = await ownerFixture(ctx, RuntimeIdentitySchema.parse({ projectId, workspaceId: parserId }), decide);
    try {
      const acted = await invoke('chatter_topic', { topic: 'bun test hangs · bash', action: 'dismiss' });
      expect(acted.status).toBe('failed');
      expect(text(acted)).toContain('Only the project agent has chatter_topic');
      expect((await invoke('chatter_post', { topic: 'bun test hangs · bash', kind: 'status', text: 'I started it.', workspace: parserId })).status).toBe('failed');
    } finally { await runtime.harness.close(BACKGROUND_CONTEXT); }
  });
  const posts: ChatterPost[] = (await object.watch({})).events.flatMap(event => event.type === 'post' ? [event] : []);
  expect(posts.some(post => post.text === 'I started it.')).toBe(false);
});

test('ghost_ask reaches a ghost of a session in its project, on the conversation\'s inference profile; another project\'s workspace is refused, live ghosts are capped, a faded one says so', async () => {
  const projectId = `ghosts-${crypto.randomUUID()}`;
  const authority = env.PROJECT_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${projectId}`);
  await authority.bootstrap({ id: projectId, name: 'Ghost project', repositoryReference: null, baseBranch: 'main', createdBy: 'user' });
  for (const [id, name, lifecycle] of [[`${projectId}-parser`, 'Parser', 'active'], [`${projectId}-billing`, 'Billing', 'archived']] as const) {
    await authority.putWorkspace({ id, projectId, kind: 'worktree', name, branch: id, phase: null, sourceKind: 'branch', sourceRef: 'main', sourceCommit: null, lifecycle, goalId: null, expectedRevision: 0 });
  }
  const identity = RuntimeIdentitySchema.parse({ projectId, workspaceId: `${projectId}-parser` });
  const asked: GhostAgentRequest[] = [];
  let fades = true;
  const answer = (request: GhostAgentRequest): GhostAgentReply => ({ status: 'answered', result: {
    ghostId: request.ghostId, expiresAt: new Date(Date.now() + 600_000).toISOString(),
    session: { workspaceId: request.open?.workspaceId ?? 'followed', workspace: request.open?.workspace ?? 'followed', conversationId: 'main', title: 'Main', main: true, archived: false }, until: null,
    answer: 'It chose the archive bucket [#2].', cites: [{ kind: 'entry', from: 2, ref: 'history://w/main#2' }], reads: [{ kind: 'read', from: 0, to: 2 }], driveAsOf: new Date().toISOString(),
    draft: null, rounds: 1, truncated: false, usage: { model: 'openai/fake', requests: 2, input: 200, output: 40, costUsd: 0.01 },
  } });
  vi.spyOn(GhostDO.prototype, 'ask').mockImplementation(async request => {
    asked.push(request);
    return request.open === null && fades ? { status: 'faded' } : answer(request);
  });
  await runInDurableObject(env.SPACE_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${identity.workspaceId}`), async (_instance, ctx) => {
    const { runtime, root, invoke, text } = await ownerFixture(ctx, identity);
    const ghostId = (result: RuntimeToolResult) => z.object({ ghostId: z.string() }).parse(JSON.parse(text(result))).ghostId;
    try {
      const outside = await invoke('ghost_ask', { workspaceId: 'another-project-workspace', question: 'What did it decide?' });
      expect(outside.status).toBe('failed');
      expect(text(outside)).toBe('Workspace another-project-workspace is outside this project');
      expect(asked).toEqual([]);

      const asker = { projectId, workspaceId: identity.workspaceId, conversationId: String(root.id) };
      const billing = await invoke('ghost_ask', { workspaceId: `${projectId}-billing`, question: 'Why the archive bucket?' });
      expect(billing.status).toBe('completed');
      const own = await invoke('ghost_ask', { question: 'What did my compaction leave out?' });
      await invoke('ghost_ask', { workspaceId: projectId, question: 'What does the project agent plan?' });
      expect(asked).toEqual([
        { ghostId: ghostId(billing), asker, question: 'Why the archive bucket?', open: { workspaceId: `${projectId}-billing`, workspace: 'Billing', conversationId: null, until: null, archived: true, profileId: 'conversation-profile' } },
        { ghostId: ghostId(own), asker, question: 'What did my compaction leave out?', open: { workspaceId: identity.workspaceId, workspace: 'Parser', conversationId: String(root.id), until: null, archived: false, profileId: 'conversation-profile' } },
        { ghostId: expect.any(String), asker, question: 'What does the project agent plan?', open: { workspaceId: projectId, workspace: 'Ghost project', conversationId: null, until: null, archived: false, profileId: 'conversation-profile' } },
      ]);

      const capped = await invoke('ghost_ask', { workspaceId: `${projectId}-billing`, question: 'One more?' });
      expect(capped.status).toBe('failed');
      expect(text(capped)).toContain('already has 3 live ghosts');
      expect(asked).toHaveLength(3);
      expect((await invoke('ghost_ask', { ghostId: ghostId(billing), workspaceId: `${projectId}-billing`, question: 'And then?' })).status).toBe('failed');

      const faded = await invoke('ghost_ask', { ghostId: ghostId(billing), question: 'And then?' });
      expect(asked.at(-1)).toEqual({ ghostId: ghostId(billing), asker, question: 'And then?', open: null });
      expect(text(faded)).toBe('That ghost has faded; ask without ghostId to start a new one.');
      // The faded ghost's place is free again; a live one answers its follow-up.
      expect((await invoke('ghost_ask', { workspaceId: `${projectId}-billing`, question: 'Why the archive bucket?' })).status).toBe('completed');
      fades = false;
      expect(JSON.parse(text(await invoke('ghost_ask', { ghostId: ghostId(own), question: 'And before that?' })))).toMatchObject({ ghostId: ghostId(own), answer: 'It chose the archive bucket [#2].' });
    } finally { await runtime.harness.close(BACKGROUND_CONTEXT); }
  });
});
