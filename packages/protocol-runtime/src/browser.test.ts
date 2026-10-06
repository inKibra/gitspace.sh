import { expect, test } from 'bun:test';
import { RuntimeBrowserArgumentsSchema, browserBase64, signRuntimeBrowserAuthorityCertificate, signRuntimeBrowserAuthorization, signRuntimeBrowserGrant, verifyRuntimeBrowserGrant, verifyRuntimeBrowserAuthorization, type RuntimeBrowserAuthorizationBody } from './browser.js';

async function fixture() {
  const keys = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const root = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const args = RuntimeBrowserArgumentsSchema.parse({ action: 'open', source: 'relay', url: 'https://example.com/' });
  const scope = { projectId: 'project', workspaceId: 'workspace', conversationId: 'conversation', machineId: 'machine', attachmentId: 'attachment', generation: 1, taskId: 'task', requestId: 'request', attemptId: 'attempt' };
  const expiresAt = new Date(Date.now() + 60000).toISOString();
  const envelope = { version: 1 as const, tool: 'browser' as const, deadlineAt: expiresAt, replay: 'unsafe' as const };
  const issuedAt = new Date().toISOString();
  const authority = await signRuntimeBrowserAuthorityCertificate({ accountId: 'account', projectId: scope.projectId, workspaceId: scope.workspaceId, publicKey: browserBase64(new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey))), issuedAt, expiresAt: new Date(Date.now() + 3600000).toISOString() }, root.privateKey);
  const grant = await signRuntimeBrowserGrant({ projectId: scope.projectId, workspaceId: scope.workspaceId, machineId: scope.machineId, attachmentId: scope.attachmentId, generation: 1, groupId: '00000000-0000-4000-8000-000000000001', groupName: 'Workspace', origins: ['example.com', '*.example.org'], source: 'relay', expiresAt }, keys.privateKey, authority);
  const body: RuntimeBrowserAuthorizationBody = { scope, issuedAt, expiresAt, dispatch: envelope, command: { type: 'execute', args, grant } };
  return { keys, root, authority, body, dispatch: { ...scope, ...envelope, args }, authorization: await signRuntimeBrowserAuthorization(body, keys.privateKey, authority) };
}
test('browser authorization requires both the pinned account root and certified workspace signature', async () => {
  const f = await fixture();
  expect((await verifyRuntimeBrowserAuthorization(f.authorization, f.dispatch, f.root.publicKey)).scope.attemptId).toBe('attempt');
  const forged = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  await expect(verifyRuntimeBrowserAuthorization(await signRuntimeBrowserAuthorization(f.body, forged.privateKey, f.authority), f.dispatch, f.root.publicKey)).rejects.toThrow('signature');
  const untrusted = await signRuntimeBrowserAuthorityCertificate(f.authority.body, forged.privateKey);
  await expect(verifyRuntimeBrowserAuthorization({ ...f.authorization, authority: untrusted }, f.dispatch, f.root.publicKey)).rejects.toThrow('authority signature');
});
test('certificates cannot cross workspace boundaries or outlive their validity', async () => {
  const f = await fixture();
  const other = await signRuntimeBrowserAuthorityCertificate({ ...f.authority.body, workspaceId: 'other' }, f.root.privateKey);
  await expect(verifyRuntimeBrowserAuthorization({ ...f.authorization, authority: other }, f.dispatch, f.root.publicKey)).rejects.toThrow('authority scope');
  const expired = await signRuntimeBrowserAuthorityCertificate({ ...f.authority.body, issuedAt: new Date(Date.now() - 60000).toISOString(), expiresAt: new Date(Date.now() - 1).toISOString() }, f.root.privateKey);
  await expect(verifyRuntimeBrowserAuthorization({ ...f.authorization, authority: expired }, f.dispatch, f.root.publicKey)).rejects.toThrow('expired');
});
test('signed browser envelope binds full attempt, arguments, deadline and origin', async () => {
  const f = await fixture();
  await expect(verifyRuntimeBrowserAuthorization(f.authorization, { ...f.dispatch, attemptId: 'other' }, f.root.publicKey)).rejects.toThrow('scope');
  await expect(verifyRuntimeBrowserAuthorization(f.authorization, { ...f.dispatch, args: { ...f.dispatch.args, url: 'https://evil.test' } }, f.root.publicKey)).rejects.toThrow('arguments');
  await expect(verifyRuntimeBrowserAuthorization(f.authorization, { ...f.dispatch, deadlineAt: new Date(Date.now() + 90000).toISOString() }, f.root.publicKey)).rejects.toThrow('dispatch');
  await expect(verifyRuntimeBrowserAuthorization(f.authorization, f.dispatch, f.root.publicKey, Date.now() + 120000)).rejects.toThrow('expired');
  if (f.body.command.type !== 'execute') throw new Error('fixture');
  f.body.command.grant.body.origins = ['evil.test'];
  await expect(verifyRuntimeBrowserAuthorization(await signRuntimeBrowserAuthorization(f.body, f.keys.privateKey, f.authority), f.dispatch, f.root.publicKey)).rejects.toThrow('grant signature');
});
test('signed management and group discovery arguments exclude envelope discriminants', async () => {
  const f = await fixture();
  for (const command of [{ type: 'manage' as const, action: 'status' as const }, { type: 'tabs' as const, groupId: '00000000-0000-4000-8000-000000000001' }]) {
    const body: RuntimeBrowserAuthorizationBody = { ...f.body, dispatch: { ...f.body.dispatch, tool: 'browser_control' }, command };
    const auth = await signRuntimeBrowserAuthorization(body, f.keys.privateKey, f.authority);
    const { type: _type, ...args } = command;
    expect((await verifyRuntimeBrowserAuthorization(auth, { ...f.dispatch, tool: 'browser_control', args }, f.root.publicKey)).command.type).toBe(command.type);
  }
});
test('machine authorization accepts two minutes of issued-at skew but never extends expiry', async () => {
  const f = await fixture();
  const machineNow = Date.parse(f.body.issuedAt) - 120_000;
  expect((await verifyRuntimeBrowserAuthorization(f.authorization, f.dispatch, f.root.publicKey, machineNow)).scope).toEqual(f.body.scope);
  await expect(verifyRuntimeBrowserAuthorization(f.authorization, f.dispatch, f.root.publicKey, Date.parse(f.body.expiresAt))).rejects.toThrow('expired');
});
test('machine authorization identifies excessive certificate and envelope clock skew', async () => {
  const f = await fixture();
  const machineNow = Date.parse(f.body.issuedAt) - 120_001;
  await expect(verifyRuntimeBrowserAuthorization(f.authorization, f.dispatch, f.root.publicKey, machineNow)).rejects.toThrow(/clock skew.*120 seconds/i);
  const authority = await signRuntimeBrowserAuthorityCertificate({ ...f.authority.body, issuedAt: new Date(machineNow - 1000).toISOString() }, f.root.privateKey);
  const authorization = await signRuntimeBrowserAuthorization(f.body, f.keys.privateKey, authority);
  await expect(verifyRuntimeBrowserAuthorization(authorization, f.dispatch, f.root.publicKey, machineNow)).rejects.toThrow(/clock skew.*120 seconds/i);
});

test('a signed group grant is reusable across distinct dispatch attempts and JS actions', async () => {
  const f = await fixture();
  if (f.body.command.type !== 'execute') throw new Error('fixture');
  const grant = f.body.command.grant;
  for (const attemptId of ['first', 'second']) {
    const args = RuntimeBrowserArgumentsSchema.parse({ action: 'evaluate', source: 'relay', targetId: 'shared-tab', expression: 'document.title' });
    const body: RuntimeBrowserAuthorizationBody = { ...f.body, scope: { ...f.body.scope, attemptId }, command: { type: 'execute', args, grant } };
    const authorization = await signRuntimeBrowserAuthorization(body, f.keys.privateKey, f.authority);
    expect((await verifyRuntimeBrowserAuthorization(authorization, { ...f.dispatch, attemptId, args }, f.root.publicKey)).command).toEqual(body.command);
  }
  expect(await verifyRuntimeBrowserGrant(grant, f.root.publicKey)).toEqual(grant.body);
  await expect(verifyRuntimeBrowserGrant(grant, f.root.publicKey, Date.parse(grant.body.expiresAt))).rejects.toThrow('expired');
  await expect(verifyRuntimeBrowserGrant({ ...grant, body: { ...grant.body, groupId: crypto.randomUUID() } }, f.root.publicKey)).rejects.toThrow('signature');
});

test('grants cross conversations but never executing machines or attachment generations', async () => {
  const f = await fixture();
  const scope = { ...f.body.scope, conversationId: 'another-conversation', attemptId: 'another-attempt' };
  const body = { ...f.body, scope };
  const authorization = await signRuntimeBrowserAuthorization(body, f.keys.privateKey, f.authority);
  expect((await verifyRuntimeBrowserAuthorization(authorization, { ...f.dispatch, ...scope }, f.root.publicKey)).command).toEqual(f.body.command);
  for (const changed of [{ machineId: 'another-machine' }, { attachmentId: 'another-attachment' }, { generation: 2 }]) {
    const switched = { ...scope, ...changed };
    const signed = await signRuntimeBrowserAuthorization({ ...body, scope: switched }, f.keys.privateKey, f.authority);
    await expect(verifyRuntimeBrowserAuthorization(signed, { ...f.dispatch, ...switched }, f.root.publicKey)).rejects.toThrow('grant scope');
  }
});

test('reusable grants retain account-root trust, workspace identity and certificate lifetime', async () => {
  const f = await fixture();
  if (f.body.command.type !== 'execute') throw new Error('fixture');
  const grant = f.body.command.grant;
  const foreign = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  await expect(verifyRuntimeBrowserGrant(grant, foreign.publicKey)).rejects.toThrow('authority signature');
  const otherWorkspace = await signRuntimeBrowserGrant({ ...grant.body, workspaceId: 'other' }, f.keys.privateKey, f.authority);
  await expect(verifyRuntimeBrowserGrant(otherWorkspace, f.root.publicKey)).rejects.toThrow('authority scope');
  const beyondCertificate = await signRuntimeBrowserGrant({ ...grant.body, expiresAt: new Date(Date.parse(f.authority.body.expiresAt) + 1).toISOString() }, f.keys.privateKey, f.authority);
  await expect(verifyRuntimeBrowserGrant(beyondCertificate, f.root.publicKey)).rejects.toThrow('authority expired');
});

test('relay explicit destinations use host patterns, while headless has no origin restriction', async () => {
  const f = await fixture();
  if (f.body.command.type !== 'execute') throw new Error('fixture');
  for (const [source, url, allowed] of [
    ['relay', 'https://sub.example.org:8443/path', true],
    ['relay', 'https://example.com.evil.test/', false],
    ['relay', 'https://evil.test/', false],
    ['headless', 'https://evil.test/', true],
  ] as const) {
    const args = RuntimeBrowserArgumentsSchema.parse({ action: 'navigate', source, targetId: 'tab', url });
    const grant = await signRuntimeBrowserGrant({ ...f.body.command.grant.body, source }, f.keys.privateKey, f.authority);
    const body: RuntimeBrowserAuthorizationBody = { ...f.body, command: { type: 'execute', args, grant } };
    const authorization = await signRuntimeBrowserAuthorization(body, f.keys.privateKey, f.authority);
    const verified = verifyRuntimeBrowserAuthorization(authorization, { ...f.dispatch, args }, f.root.publicKey);
    if (allowed) expect((await verified).command).toEqual(body.command);
    else await expect(verified).rejects.toThrow('origin');
  }
});

test('browser defaults to headless and rejects removed lease/evaluation capability fields', () => {
  expect(RuntimeBrowserArgumentsSchema.parse({ action: 'open' }).source).toBe('headless');
  expect(RuntimeBrowserArgumentsSchema.parse({ action: 'screenshot', targetId: 'tab' }).source).toBe('headless');
  expect(RuntimeBrowserArgumentsSchema.safeParse({ action: 'open', allowEvaluate: true }).success).toBe(false);
  expect(RuntimeBrowserArgumentsSchema.safeParse({ action: 'observe', leaseId: crypto.randomUUID() }).success).toBe(false);
});
