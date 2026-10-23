import { afterEach, expect, test, vi } from 'vitest';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { Harness, MemoryStorage, createRegistry } from '@earendil-works/pi-durable';
import { createModels } from '@earendil-works/pi-ai';
import { createRuntimeBrowserAuthority, retireWorkspaceBrowsers, workspaceBrowsersDocument } from '../src/runtime-browser.js';
import { AccountBrowserRuntime } from '../src/browser-runtime.js';
import { BROWSER_RUN_LIMIT_MS, RuntimeAttachmentSchema, RuntimeBrowserArgumentsSchema, RuntimeBrowserAuthorizationSchema, RuntimeBrowserGrantSchema, RuntimeBrowserStatusSchema, signRuntimeBrowserAuthorityCertificate, type RuntimeBrowserAuthorityCertificateBody, type RuntimeBrowserStatus, type RuntimeToolDispatch, type RuntimeToolResult, type RuntimeAccountBrowserAuthorization, RuntimeAccountBrowserAuthorizationSchema } from '@gitspace/protocol-runtime';
import type { FleetMachineDefinition } from '@gitspace/protocol/account-directory';
const harnesses: Harness[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(harnesses.splice(0).map(harness => harness.close(BACKGROUND_CONTEXT))); });
async function fixture(kind: FleetMachineDefinition['kind'] = 'physical', realRelayRuntime = false) {
  const data = new Map<string, unknown>();
  let transaction = Promise.resolve();
  const storage = { async get(key: string) { return data.get(key); }, async list({ prefix }: { prefix: string }) { return new Map([...data].filter(([key]) => key.startsWith(prefix))); }, async put(key: string, value: unknown) { data.set(key, value); }, async delete(key: string) { return data.delete(key); }, async transaction<T>(fn: (value: { get(key: string): Promise<unknown>; put(key: string, value: unknown): Promise<void> }) => Promise<T>): Promise<T> {
    const result = transaction.then(() => fn(storage));
    transaction = result.then(() => {}, () => {});
    return result;
  } };
  const identity = { projectId: 'project', workspaceId: 'workspace' };
  const attachment = RuntimeAttachmentSchema.parse({ ...identity, machineId: 'machine', attachmentId: 'attachment', generation: 1, state: 'ready', role: 'cache', checkout: { kind: 'shared', branch: 'main' }, updatedAt: new Date().toISOString(), online: true, capabilities: ['browser', 'browser_control', 'browser.relay', 'browser.headless'] });
  const attachments = [attachment];
  const machines = new Map<string, Pick<FleetMachineDefinition, 'kind' | 'desiredState'>>([['machine', { kind, desiredState: 'online' }]]);
  const signingRoot = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const harness = await Harness.open(new MemoryStorage(), { registry: createRegistry(), models: createModels() }, BACKGROUND_CONTEXT);
  harnesses.push(harness);
  const root = await harness.root(BACKGROUND_CONTEXT);
  const state: { root: boolean; projectApproved: boolean; defaultMachineId: string | null; origins: string[]; status: RuntimeBrowserStatus } = { root: true, projectApproved: true, defaultMachineId: null, origins: ['example.com', 'other.test'], status: RuntimeBrowserStatusSchema.parse({ groups: [], records: [] }) };
  const dispatches: Array<RuntimeToolDispatch | RuntimeAccountBrowserAuthorization> = [];
  const pairing = { kind: 'account-relay' as const, accountId: 'account', pairingId: crypto.randomUUID(), generation: 1, approvalId: crypto.randomUUID() };
  const forgottenPairings = new Set<string>();
  const offlinePairings = new Set<string>();
  const knownPairings = new Map<string, typeof pairing>();
  const relayRuntime = new AccountBrowserRuntime({ storage, relay: { async tabs() { return []; }, async open() { throw new Error('This fixture exercises group discovery, not tab opening'); }, async revoke() {} } });
  const relay = {
    async browserRelayPlacement(projectId: string, pairingId?: string) { if (projectId !== identity.projectId || !state.projectApproved) throw new Error('Chrome is not approved for this project'); knownPairings.set(pairing.pairingId, { ...pairing }); const selected = knownPairings.get(pairingId ?? pairing.pairingId); if (!selected) throw new Error('Unknown Chrome'); return selected; },
    async browserRelayProjectSettings(projectId: string) { return { projectId, revision: 1, defaultPairingId: pairing.pairingId, browsers: [...knownPairings.values()].filter(browser => !forgottenPairings.has(browser.pairingId)).map(({ pairingId, generation }) => ({ pairingId, generation, approved: state.projectApproved, connected: !offlinePairings.has(pairingId), name: 'Work Chrome', note: 'Production account' })) }; },
    async browserRelayExecute(authorization: RuntimeAccountBrowserAuthorization): Promise<RuntimeToolResult> {
      const placement = authorization.body.scope.placement;
      if (placement.kind === 'account-relay' && forgottenPairings.has(placement.pairingId)) throw new Error('Browser fingerprint confirmation required');
      dispatches.push(authorization);
      if (realRelayRuntime) return relayRuntime.execute(authorization, AbortSignal.timeout(5000));
      return {status:'completed', requestId:authorization.body.scope.requestId,attemptId:authorization.body.scope.attemptId,content:[{type:'text',text:JSON.stringify(authorization.body.command.type === 'manage' ? state.status : {targetId:'target'})}]};
    },
  };
  const runtime = { harness, defaultExecutionMachine: () => state.defaultMachineId, browserConversation: async (_id: string) => ({ id: root.id, root: state.root }), attachments: { list: () => attachments, execute: async (dispatch: RuntimeToolDispatch): Promise<RuntimeToolResult> => {
    const { command } = RuntimeBrowserAuthorizationSchema.parse(dispatch.browserAuthorization).body;
    dispatches.push(dispatch);
    return { status: 'completed', requestId: dispatch.requestId, attemptId: dispatch.attemptId, content: [{ type: 'text', text: JSON.stringify(command.type === 'manage' ? state.status : { targetId: 'target' }) }] };
  } } };
  const sessions: Array<{ name: string; authorization: RuntimeAccountBrowserAuthorization }> = [];
  const BROWSER_SESSION = { getByName: (name: string) => ({ async execute(authorization: RuntimeAccountBrowserAuthorization): Promise<RuntimeToolResult> {
    sessions.push({ name, authorization });
    const text = authorization.body.command.type === 'manage' ? JSON.stringify(RuntimeBrowserStatusSchema.parse({ groups: [], records: [] })) : '{"ok":true,"value":1}';
    return { status: 'completed', requestId: authorization.body.scope.requestId, attemptId: authorization.body.scope.attemptId, content: [{ type: 'text', text }] };
  } }) };
  const env = { ACCOUNT_ID: 'account', RELAY_NAME: 'account-relay', RELAY: {getByName:()=>relay}, BROWSER_SESSION, ACCOUNT_STATE: { getByName: () => ({ certifyBrowserAuthority: async (body: RuntimeBrowserAuthorityCertificateBody) => signRuntimeBrowserAuthorityCertificate(body, signingRoot.privateKey) }) }, FLEET_CATALOG: { getByName: () => ({ getMachine: async (id: string) => machines.get(id) ?? null }) } };
  const authority = createRuntimeBrowserAuthority({ storage, env, identity, runtime: () => runtime, async selectExecution(args, candidates) {
    const machineId = args.on ?? state.defaultMachineId;
    const selected = candidates.find(item => machineId === null || item.machineId === machineId);
    if (!selected) throw new Error('No selected browser cache is ready');
    return selected;
  }, approvedOrigins: async () => state.origins, groupName: async () => 'Workspace' });
  const input = { tool: 'browser', args: RuntimeBrowserArgumentsSchema.parse({ action: 'open', source: 'relay', url: 'https://example.com/' }), conversationId: String(root.id), taskId: 'task', requestId: 'request', attemptId: 'attempt', replay: 'unsafe' as const };
  return { authority, input, state, dispatches, sessions, attachments, machines, attachment, pairing, forgottenPairings, offlinePairings, storage };
}
test('project-approved Chrome creates its workspace group without a second human approval', async () => {
  const f = await fixture(); const card = await f.authority.prepare(f.input);
  await f.authority.execute(f.input);
  const next = await f.authority.prepare({ ...f.input, attemptId: 'next' });
  expect(next.groupId).toBe(card.groupId);
  expect(next.origins).toEqual(['example.com', 'other.test']);
});
test('groups are created without approving missing environment origins', async () => {
  const f = await fixture();
  await f.authority.prepare(f.input);
  await f.authority.execute(f.input);
  f.state.origins = [];
  await expect(f.authority.prepare({ ...f.input, attemptId: 'missing' })).rejects.toThrow('.gitspace/bundle.json');
});
test('yolo cannot prepare unapproved Chrome and project revocation invalidates an already prepared group', async () => {
  const f = await fixture(); f.state.projectApproved = false;
  await expect(f.authority.prepare(f.input)).rejects.toThrow('not approved for this project');
  f.state.projectApproved = true; await f.authority.prepare(f.input); f.state.projectApproved = false;
  await expect(f.authority.execute(f.input)).rejects.toThrow('not approved for this project');
  expect(f.dispatches).toEqual([]);
});
test('origin narrowing invalidates prepared grants and renews with only current origins', async () => {
  const f = await fixture();
  await f.authority.prepare(f.input); await f.authority.execute(f.input);
  f.state.origins = ['example.com'];
  await expect(f.authority.execute(f.input)).rejects.toThrow('origins changed');
  const next = { ...f.input, attemptId: 'narrowed', requestId: 'narrowed' };
  expect((await f.authority.prepare(next)).origins).toEqual(['example.com']);
  await f.authority.execute(next);
});
test('a retired workspace drops its group rows and starts a new Chrome group on its next use', async () => {
  const f = await fixture();
  const first = await f.authority.prepare(f.input); await f.authority.execute(f.input);
  await f.storage.put(`runtime.browser.chrome:${first.groupId}`, { pairingId: f.pairing.pairingId, browser: 'Work Chrome', groupId: first.groupId, groupName: 'Workspace', origins: first.origins, expiresAt: first.expiresAt, reportedAt: new Date().toISOString(), tabs: [] });
  expect((await workspaceBrowsersDocument(f.storage)).chrome.map(group => group.groupId)).toEqual([first.groupId]);
  const retired: string[] = [];
  await retireWorkspaceBrowsers(f.storage, { browserRelayRetireWorkspace: async (projectId, workspaceId) => { retired.push(`${projectId}/${workspaceId}`); } }, { projectId: 'project', workspaceId: 'workspace' });
  expect(retired).toEqual(['project/workspace']);
  expect(await workspaceBrowsersDocument(f.storage)).toEqual({ chrome: [] });
  const next = await f.authority.prepare({ ...f.input, attemptId: 'restored', requestId: 'restored' });
  expect(next.groupId).not.toBe(first.groupId);
});
test('expired prepared group grant cannot dispatch', async () => {
  const f = await fixture(); const card = await f.authority.prepare(f.input);
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(card.expiresAt) + 1);
  try { await expect(f.authority.execute(f.input)).rejects.toThrow('expired'); expect(f.dispatches).toEqual([]); } finally { vi.restoreAllMocks(); }
});
test('an expired grant renews in the same group, so the Chrome group outlives it', async () => {
  const f = await fixture('physical', true);
  f.input.args = RuntimeBrowserArgumentsSchema.parse({ action: 'tabs', source: 'relay' });
  const first = await f.authority.prepare(f.input); await f.authority.execute(f.input);
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(first.expiresAt) + 1);
  try {
    const next = { ...f.input, attemptId: 'renewed', requestId: 'renewed' };
    const renewed = await f.authority.prepare(next);
    expect(renewed.groupId).toBe(first.groupId);
    expect(Date.parse(renewed.expiresAt)).toBeGreaterThan(Date.parse(first.expiresAt));
    expect((await f.authority.execute(next)).status).toBe('completed');
  } finally { vi.restoreAllMocks(); }
});


test('scripts on either browser run in the workspace’s browser session, with authority that outlasts the run limit', async () => {
  const f = await fixture();
  const relay = { ...f.input, args: RuntimeBrowserArgumentsSchema.parse({ action: 'run', source: 'relay', script: 'return 1;' }), requestId: 'relay-script', attemptId: 'relay-script' };
  const cloud = { ...f.input, args: RuntimeBrowserArgumentsSchema.parse({ action: 'run', source: 'headless', script: 'return 1;' }), requestId: 'cloud-script', attemptId: 'cloud-script' };
  for (const input of [relay, cloud]) { await f.authority.prepare(input); await f.authority.execute(input); }
  // The fixture's machine offers a headless browser; scripts still go to the session, and none reaches the relay.
  expect(f.sessions.map(({ name, authorization }) => [name, authorization.body.scope.placement.kind, authorization.body.command.type === 'execute' && authorization.body.command.args.action])).toEqual([['account:project:workspace', 'account-relay', 'run'], ['account:project:workspace', 'cloud', 'run']]);
  expect(f.dispatches).toHaveLength(0);
  for (const { authorization: { body } } of f.sessions) {
    expect(Date.parse(body.dispatch.deadlineAt) - Date.parse(body.issuedAt)).toBeGreaterThan(BROWSER_RUN_LIMIT_MS);
    expect(Date.parse(body.expiresAt) - Date.parse(body.issuedAt)).toBeGreaterThan(BROWSER_RUN_LIMIT_MS);
  }
  const pinned = { ...cloud, args: RuntimeBrowserArgumentsSchema.parse({ action: 'run', source: 'headless', on: 'machine', script: 'return 1;' }), requestId: 'pinned-script', attemptId: 'pinned-script' };
  await expect(f.authority.prepare(pinned)).rejects.toThrow('remove "on"');
});
test('relay works without any machine and rejects subagents before dispatch', async () => {
 const f=await fixture(); f.attachments.splice(0); f.machines.clear();
 const card=await f.authority.prepare(f.input); expect('placement' in card && card.placement.kind).toBe('account-relay');
 await f.authority.execute(f.input); expect(f.dispatches).toHaveLength(1); f.state.root=false;
 await expect(f.authority.prepare({...f.input,attemptId:'child'})).rejects.toThrow('main-agent-only'); expect(f.dispatches).toHaveLength(1);
});
test('headless cloud placement does not require a registered machine attachment',async()=>{
 const f=await fixture(); f.attachments.splice(0); f.machines.clear();
 f.input.args=RuntimeBrowserArgumentsSchema.parse({action:'open',source:'headless',url:'https://example.com/'});
 const card=await f.authority.prepare(f.input); expect(card.source).toBe('headless');
 expect('placement' in card && card.placement).toEqual({kind:'cloud',accountId:'account'}); expect('machineId' in card).toBe(false);
});
test('pairing replacement rotates grants and rejects saved authorization',async()=>{
 const f=await fixture();const first=await f.authority.prepare(f.input);await f.authority.execute(f.input);
 f.pairing.pairingId=crypto.randomUUID();f.pairing.generation++;
 await expect(f.authority.execute(f.input)).rejects.toThrow('placement changed');
 const next=await f.authority.prepare({...f.input,attemptId:'replacement'});expect(next.groupId).not.toBe(first.groupId);
});
test('headless explicit on still dispatches to exact ready machine',async()=>{
 const f=await fixture();f.input.args=RuntimeBrowserArgumentsSchema.parse({action:'open',source:'headless',on:'machine'});
 const card=await f.authority.prepare(f.input); expect('machineId' in card && card.machineId).toBe('machine');
 await f.authority.execute(f.input);const dispatched=f.dispatches[0];expect(dispatched && 'machineId' in dispatched && dispatched.machineId).toBe('machine');
});
test('account group revocation prevents old approval reuse',async()=>{
 const f=await fixture();const first=await f.authority.prepare(f.input);await f.authority.execute(f.input);
 await f.authority.manage(f.input.conversationId,undefined,{action:'revoke',groupId:first.groupId});
 await expect(f.authority.execute(f.input)).rejects.toThrow('revoked');
 const next=await f.authority.prepare({...f.input,attemptId:'next'});expect(next.groupId).not.toBe(first.groupId);
});
test('account browser status discovers groups on every approved Chrome', async () => {
  const f = await fixture('physical', true);
  f.input.args = RuntimeBrowserArgumentsSchema.parse({ action: 'tabs', source: 'relay' });
  const first = await f.authority.prepare(f.input); await f.authority.execute(f.input);
  f.pairing.pairingId = crypto.randomUUID();
  const next = { ...f.input, attemptId: 'second-browser' };
  const second = await f.authority.prepare(next); await f.authority.execute(next);
  const status = RuntimeBrowserStatusSchema.parse(await f.authority.manage(f.input.conversationId, undefined, { action: 'status' }));
  expect(status.groups.map(group => group.groupId).sort()).toEqual([first.groupId, second.groupId].sort());
});
test('forgetting a Chrome leaves remaining browser groups discoverable', async () => {
  const f = await fixture('physical', true);
  f.input.args = RuntimeBrowserArgumentsSchema.parse({ action: 'tabs', source: 'relay' });
  await f.authority.prepare(f.input); await f.authority.execute(f.input);
  const forgotten = f.pairing.pairingId;
  f.pairing.pairingId = crypto.randomUUID();
  const next = { ...f.input, attemptId: 'remaining-browser' };
  const remaining = await f.authority.prepare(next); await f.authority.execute(next);
  f.forgottenPairings.add(forgotten);
  const status = RuntimeBrowserStatusSchema.parse(await f.authority.manage(f.input.conversationId, undefined, { action: 'status' }));
  expect(status.groups.map(group => group.groupId)).toEqual([remaining.groupId]);
});
test('browser_control lists approved offline Chrome names and notes without dispatching to them', async () => {
  const f = await fixture(); await f.authority.prepare(f.input); f.offlinePairings.add(f.pairing.pairingId);
  const status = RuntimeBrowserStatusSchema.parse(await f.authority.manage(f.input.conversationId, undefined, { action: 'status' }));
  expect(status.browsers).toEqual([{ pairingId: f.pairing.pairingId, generation: 1, approved: true, connected: false, name: 'Work Chrome', note: 'Production account' }]);
  expect(f.dispatches).toEqual([]);
});
test('reapproving the same Chrome rotates the workspace group and rejects the old prepared grant', async () => {
  const f = await fixture('physical', true);
  f.input.args = RuntimeBrowserArgumentsSchema.parse({ action: 'tabs', source: 'relay' });
  const old = await f.authority.prepare(f.input); await f.authority.execute(f.input);
  f.state.projectApproved = false;
  await expect(f.authority.execute(f.input)).rejects.toThrow('not approved');
  f.state.projectApproved = true; f.pairing.approvalId = crypto.randomUUID();
  const nextInput = { ...f.input, attemptId: 'reapproved', requestId: 'reapproved' };
  const next = await f.authority.prepare(nextInput);
  expect(next.groupId).not.toBe(old.groupId);
  await expect(f.authority.execute(f.input)).rejects.toThrow(/revoked|placement changed/i);
  const result = await f.authority.execute(nextInput); expect(result.status).toBe('completed');
});
test('subagent headless discovery never exposes private Chrome names or notes', async () => {
  const f = await fixture(); await f.authority.prepare(f.input); f.state.root = false;
  const status = RuntimeBrowserStatusSchema.parse(await f.authority.manage(f.input.conversationId, undefined, { action: 'status' }));
  expect(status.browsers).toEqual([]); expect(f.dispatches).toEqual([]);
});
