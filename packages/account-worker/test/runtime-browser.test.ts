import { afterEach, expect, test, vi } from 'vitest';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { Harness, MemoryStorage, createRegistry } from '@earendil-works/pi-durable';
import { createModels } from '@earendil-works/pi-ai';
import { QuestionsDoc } from '@gitspace/runtime-core';
import { SessionControlsDoc } from '@gitspace/runtime-core/session-controls';
import { createRuntimeBrowserAuthority } from '../src/runtime-browser.js';
import { RuntimeAttachmentSchema, RuntimeBrowserArgumentsSchema, RuntimeBrowserAuthorizationSchema, RuntimeBrowserGrantSchema, RuntimeBrowserStatusSchema, signRuntimeBrowserAuthorityCertificate, type RuntimeBrowserAuthorityCertificateBody, type RuntimeBrowserApprovalCard, type RuntimeToolDispatch, type RuntimeToolResult } from '@gitspace/protocol-runtime';
import type { FleetMachineDefinition } from '@gitspace/protocol/account-directory';
const harnesses: Harness[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(harnesses.splice(0).map(harness => harness.close(BACKGROUND_CONTEXT))); });
async function fixture(kind: FleetMachineDefinition['kind'] = 'physical') {
  const data = new Map<string, unknown>();
  let transaction = Promise.resolve();
  const storage = { async get(key: string) { return data.get(key); }, async put(key: string, value: unknown) { data.set(key, value); }, async transaction<T>(fn: (value: { get(key: string): Promise<unknown>; put(key: string, value: unknown): Promise<void> }) => Promise<T>): Promise<T> {
    const result = transaction.then(() => fn(storage));
    transaction = result.then(() => {}, () => {});
    return result;
  } };
  const identity = { projectId: 'project', workspaceId: 'workspace' };
  const attachment = RuntimeAttachmentSchema.parse({ ...identity, machineId: 'machine', attachmentId: 'attachment', generation: 1, state: 'ready', role: 'primary', checkout: { kind: 'shared', branch: 'main' }, updatedAt: new Date().toISOString(), capabilities: ['browser', 'browser_control', 'browser.relay', 'browser.headless'] });
  const attachments = [attachment];
  const machines = new Map<string, Pick<FleetMachineDefinition, 'kind' | 'desiredState'>>([['machine', { kind, desiredState: 'online' }]]);
  const credentials = new Set(['machine']);
  const signingRoot = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const harness = await Harness.open(new MemoryStorage(), { registry: createRegistry(), models: createModels() }, BACKGROUND_CONTEXT);
  harnesses.push(harness);
  const root = await harness.root(BACKGROUND_CONTEXT);
  const state = { root: true, origins: ['example.com', 'other.test'], status: RuntimeBrowserStatusSchema.parse({ groups: [], records: [] }) };
  const dispatches: RuntimeToolDispatch[] = [];
  const runtime = { harness, browserConversation: async (_id: string) => ({ id: root.id, root: state.root }), attachments: { list: () => attachments, execute: async (dispatch: RuntimeToolDispatch): Promise<RuntimeToolResult> => {
    const { command } = RuntimeBrowserAuthorizationSchema.parse(dispatch.browserAuthorization).body;
    dispatches.push(dispatch);
    return { status: 'completed', requestId: dispatch.requestId, attemptId: dispatch.attemptId, content: [{ type: 'text', text: JSON.stringify(command.type === 'manage' ? state.status : { targetId: 'target' }) }] };
  } } };
  const env = { ACCOUNT_ID: 'account', ACCOUNT_STATE: { getByName: () => ({ certifyBrowserAuthority: async (body: RuntimeBrowserAuthorityCertificateBody) => signRuntimeBrowserAuthorityCertificate(body, signingRoot.privateKey) }) }, FLEET_CATALOG: { getByName: () => ({ getMachine: async (id: string) => machines.get(id) ?? null }) }, CREDENTIALS: { getByName: () => ({ hasRuntimeMachine: (id: string) => credentials.has(id) ? Promise.resolve(true as const) : Promise.resolve(false as const) }) } };
  const authority = createRuntimeBrowserAuthority({ storage, env, identity, runtime: () => runtime, approvedOrigins: async () => state.origins, groupName: async () => 'Workspace' });
  const input = { tool: 'browser', args: RuntimeBrowserArgumentsSchema.parse({ action: 'open', source: 'relay', url: 'https://example.com/' }), conversationId: String(root.id), taskId: 'task', requestId: 'request', attemptId: 'attempt', replay: 'unsafe' as const };
  const approve = async (browser: RuntimeBrowserApprovalCard, answer: boolean | null = true) => harness.commit(async tx => { (await tx.doc(QuestionsDoc)).items = [{ id: 'approval:task', conversationId: input.conversationId, kind: 'approval', browser, answer, prompt: '', choices: ['Approve', 'Reject'] }]; }, BACKGROUND_CONTEXT);
  const mode = async (approvalMode: 'write' | 'always-ask' | 'yolo') => harness.commit(async tx => { (await tx.doc(SessionControlsDoc, root.id)).approvalMode = approvalMode; }, BACKGROUND_CONTEXT);
  return { authority, input, approve, mode, state, dispatches, attachments, machines, credentials, attachment };
}
test('relay rejects cloud machines and subagents before any effect', async () => {
  const cloud = await fixture('sandbox');
  await expect(cloud.authority.prepare(cloud.input)).rejects.toThrow('physical');
  const child = await fixture(); child.state.root = false;
  await expect(child.authority.prepare(child.input)).rejects.toThrow('main-agent-only');
  expect(cloud.dispatches).toEqual([]); expect(child.dispatches).toEqual([]);
});
for (const mode of ['write', 'always-ask', 'yolo'] as const) test(`default headless has no approval or origin requirement in ${mode}`, async () => {
  const f = await fixture('sandbox'); await f.mode(mode); f.state.root = false; f.state.origins = [];
  f.input.args = RuntimeBrowserArgumentsSchema.parse({ action: 'open', url: 'https://unapproved.test/' });
  const card = await f.authority.prepare(f.input);
  expect(card.source).toBe('headless'); expect(card.requiresApproval).toBe(false);
  expect((await f.authority.execute(f.input)).status).toBe('completed');
});
test('pending, rejected and altered human group approvals never execute', async () => {
  const f = await fixture(); const card = await f.authority.prepare(f.input);
  for (const answer of [null, false]) { await f.approve(card, answer); await expect(f.authority.execute(f.input)).rejects.toThrow('Committed human'); }
  await f.approve({ ...card, origins: ['*'] });
  await expect(f.authority.execute(f.input)).rejects.toThrow('Committed human');
  expect(f.dispatches).toEqual([]);
});
test('group approval is reusable and revocation fences later dispatch', async () => {
  const f = await fixture(); const card = await f.authority.prepare(f.input); await f.approve(card);
  await f.authority.execute(f.input);
  const next = { ...f.input, taskId: 'next', requestId: 'next', attemptId: 'next', args: RuntimeBrowserArgumentsSchema.parse({ action: 'evaluate', source: 'relay', targetId: 'target', expression: 'document.title' }) };
  const reused = await f.authority.prepare(next); expect(reused.requiresApproval).toBe(false); expect(reused.groupId).toBe(card.groupId);
  await f.authority.execute(next);
  const first = RuntimeBrowserAuthorizationSchema.parse(f.dispatches[0]?.browserAuthorization).body.command;
  const second = RuntimeBrowserAuthorizationSchema.parse(f.dispatches[1]?.browserAuthorization).body.command;
  if (first.type !== 'execute' || second.type !== 'execute') throw new Error('Missing execute commands');
  expect(second.grant).toEqual(first.grant);
  await f.authority.manage(f.input.conversationId, 'machine', { action: 'revoke', groupId: card.groupId });
  await expect(f.authority.execute(next)).rejects.toThrow('revoked');
});
test('yolo creates groups without approving missing environment origins', async () => {
  const f = await fixture(); await f.mode('yolo');
  expect((await f.authority.prepare(f.input)).requiresApproval).toBe(false);
  await f.authority.execute(f.input);
  f.state.origins = [];
  await expect(f.authority.prepare({ ...f.input, attemptId: 'missing' })).rejects.toThrow('.gitspace/bundle.json');
});
test('origin narrowing invalidates prepared grants and renews with only current origins', async () => {
  const f = await fixture(); await f.mode('yolo');
  await f.authority.prepare(f.input); await f.authority.execute(f.input);
  f.state.origins = ['example.com'];
  await expect(f.authority.execute(f.input)).rejects.toThrow('origins changed');
  const next = { ...f.input, attemptId: 'narrowed', requestId: 'narrowed' };
  expect((await f.authority.prepare(next)).origins).toEqual(['example.com']);
  await f.authority.execute(next);
});
test('expired prepared group grant cannot dispatch', async () => {
  const f = await fixture(); await f.mode('yolo'); const card = await f.authority.prepare(f.input);
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(card.expiresAt) + 1);
  try { await expect(f.authority.execute(f.input)).rejects.toThrow('expired'); expect(f.dispatches).toEqual([]); } finally { vi.restoreAllMocks(); }
});

for (const mode of ['write', 'yolo'] as const) test(`revoked relay groups rotate atomically in ${mode} without reviving saved dispatches`, async () => {
  const f = await fixture(); await f.mode(mode);
  const first = await f.authority.prepare(f.input); await f.approve(first); await f.authority.execute(f.input);
  await f.authority.manage(f.input.conversationId, 'machine', { action: 'revoke', groupId: first.groupId });
  await expect(f.authority.prepare(f.input)).rejects.toThrow('revoked');
  const next = { ...f.input, requestId: 'new', attemptId: 'new' };
  const sibling = { ...f.input, requestId: 'sibling', attemptId: 'sibling' };
  const [card, concurrent] = await Promise.all([f.authority.prepare(next), f.authority.prepare(sibling)]);
  expect(card.groupId).not.toBe(first.groupId);
  expect(concurrent.groupId).toBe(card.groupId);
  expect(card.requiresApproval).toBe(mode !== 'yolo');
  if (mode !== 'yolo') {
    await expect(f.authority.execute(next)).rejects.toThrow('Committed human');
    await f.approve(card);
  }
  await f.authority.execute(next);
  const dispatched = f.dispatches.length;
  await expect(f.authority.execute(f.input)).rejects.toThrow('revoked');
  expect(f.dispatches).toHaveLength(dispatched);
  f.state.origins = [];
  await expect(f.authority.prepare({ ...next, attemptId: 'unapproved' })).rejects.toThrow('origin is not approved');
});

test('relay placement retains approval through transient unready attachment with another ready executor', async () => {
  const f = await fixture();
  const first = await f.authority.prepare(f.input); await f.approve(first); await f.authority.execute(f.input);
  f.attachments.push(RuntimeAttachmentSchema.parse({ ...f.attachment, machineId: 'replacement', attachmentId: 'replacement-attachment' }));
  f.machines.set('replacement', { kind: 'physical', desiredState: 'online' }); f.credentials.add('replacement');
  f.attachment.state = 'lost';
  const next = { ...f.input, requestId: 'recovered', attemptId: 'recovered' };
  await expect(f.authority.prepare(next)).rejects.toThrow('ready');
  await expect(f.authority.execute(f.input)).rejects.toThrow('ready');
  expect(f.dispatches).toHaveLength(1);
  f.attachment.state = 'ready';
  const recovered = await f.authority.prepare(next);
  expect(recovered.groupId).toBe(first.groupId);
  expect(recovered.machineId).toBe(first.machineId);
  expect(recovered.requiresApproval).toBe(false);
  await f.authority.execute(next);
  const original = RuntimeBrowserAuthorizationSchema.parse(f.dispatches[0]?.browserAuthorization).body.command;
  const resumed = RuntimeBrowserAuthorizationSchema.parse(f.dispatches[1]?.browserAuthorization).body.command;
  if (original.type !== 'execute' || resumed.type !== 'execute') throw new Error('Missing execute commands');
  expect(resumed.grant).toEqual(original.grant);
});

for (const change of ['missing machine', 'removed machine', 'missing credentials', 'moved pairing', 'replacement attachment'] as const) test(`relay placement rotates approval after ${change}`, async () => {
  const f = await fixture();
  const first = await f.authority.prepare(f.input); await f.approve(first); await f.authority.execute(f.input);
  const replacement = RuntimeAttachmentSchema.parse({ ...f.attachment, machineId: 'replacement', attachmentId: 'replacement-attachment' });
  f.attachments.push(replacement);
  f.machines.set('replacement', { kind: 'physical', desiredState: 'online' }); f.credentials.add('replacement');
  if (change === 'missing machine') f.machines.delete('machine');
  if (change === 'removed machine') f.machines.set('machine', { kind: 'physical', desiredState: 'removed' });
  if (change === 'missing credentials') f.credentials.delete('machine');
  if (change === 'moved pairing') f.attachment.capabilities = ['browser', 'browser_control', 'browser.headless'];
  if (change === 'replacement attachment') {
    replacement.machineId = f.attachment.machineId;
    replacement.generation = 2;
    f.attachments.splice(0, 1);
  }
  const next = { ...f.input, requestId: 'new', attemptId: 'new' };
  const card = await f.authority.prepare(next);
  expect(card.machineId).toBe(replacement.machineId);
  expect(card.attachmentId).toBe(replacement.attachmentId);
  expect(card.generation).toBe(replacement.generation);
  expect(card.groupId).not.toBe(first.groupId);
  expect(card.requiresApproval).toBe(true);
  await expect(f.authority.execute(next)).rejects.toThrow('Committed human');
  await f.approve(card);
  await f.authority.execute(next);
  await expect(f.authority.execute(f.input)).rejects.toThrow('revoked');
});

test('relay placement fails closed when no eligible physical pair remains', async () => {
  const f = await fixture(); await f.mode('yolo');
  await f.authority.prepare(f.input); await f.authority.execute(f.input);
  f.attachment.capabilities = ['browser', 'browser_control', 'browser.headless'];
  f.attachments.push(RuntimeAttachmentSchema.parse({ ...f.attachment, machineId: 'cloud', attachmentId: 'cloud-attachment', capabilities: ['browser.relay'] }));
  f.machines.set('cloud', { kind: 'sandbox', desiredState: 'online' }); f.credentials.add('cloud');
  await expect(f.authority.prepare({ ...f.input, attemptId: 'new' })).rejects.toThrow('physical');
  expect(f.dispatches).toHaveLength(1);
});

for (const state of ['revoked', 'expired', 'closed'] as const) test(`matching terminal ${state} status retires the logical group`, async () => {
  const f = await fixture();
  const first = await f.authority.prepare(f.input); await f.approve(first); await f.authority.execute(f.input);
  f.state.status = RuntimeBrowserStatusSchema.parse({ groups: [{ ...RuntimeBrowserGrantSchema.strip().parse(first), state }], records: [] });
  await f.authority.manage(f.input.conversationId, 'machine', { action: 'status' });
  const next = await f.authority.prepare({ ...f.input, attemptId: 'new' });
  expect(next.groupId).not.toBe(first.groupId); expect(next.requiresApproval).toBe(true);
  await expect(f.authority.execute(f.input)).rejects.toThrow('revoked');
});

test('terminal status from another browser source cannot revoke the relay grant', async () => {
  const f = await fixture();
  const first = await f.authority.prepare(f.input); await f.approve(first); await f.authority.execute(f.input);
  f.state.status = RuntimeBrowserStatusSchema.parse({ groups: [{ ...RuntimeBrowserGrantSchema.strip().parse(first), source: 'headless', state: 'closed' }], records: [] });
  await f.authority.manage(f.input.conversationId, 'machine', { action: 'status' });
  const next = await f.authority.prepare({ ...f.input, attemptId: 'new' });
  expect(next.groupId).toBe(first.groupId); expect(next.requiresApproval).toBe(false);
});
