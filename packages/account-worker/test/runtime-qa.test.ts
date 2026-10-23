import { env, SELF } from 'cloudflare:test';
import { expect, test } from 'vitest';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { createSignedControlRequest, credentialProtocolBase64, signCredentialAuthorityGrant, type ControlOperation } from '@gitspace/protocol';
import { RuntimeIdentitySchema } from '@gitspace/protocol-runtime';
import { FiledIssueSchema } from '@gitspace/protocol-runtime/workspace-controls';
import { z } from 'zod';
import { appendRuntimeQa, createRuntimeQaServices } from '../src/runtime-services.js';
import { tenantRootPrivateKey as rootPrivateKey } from './setup.js';

const actor = { deviceId: 'browser-1', canApprove: true };
const commit = 'a'.repeat(40);

async function project() {
  const projectId = `qa-${crypto.randomUUID()}`;
  await env.PROJECT_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${projectId}`).bootstrap({ id: projectId, name: 'QA', repositoryReference: null, baseBranch: 'main', createdBy: 'user' });
  return { a: RuntimeIdentitySchema.parse({ projectId, workspaceId: 'workspace-a' }), b: RuntimeIdentitySchema.parse({ projectId, workspaceId: 'workspace-b' }) };
}
const filed = async (id: string) => (await env.ACCOUNT_STATE.getByName('account').listFiledIssues({ limit: 100 })).filter(row => row.id === id);

test('a workspace inbox lists only its own reports', async () => {
  const { a, b } = await project();
  await appendRuntimeQa(env, a, crypto.randomUUID(), { message: 'Failure in A' });
  await appendRuntimeQa(env, b, crypto.randomUUID(), { message: 'Failure in B' });
  expect((await createRuntimeQaServices(env, a).list()).map(item => item.title)).toEqual(['Failure in A']);
});

test('copies of an open report are merged into the first, durably, and a repeated failure files nothing new', async () => {
  const { a } = await project();
  const first = await appendRuntimeQa(env, a, crypto.randomUUID(), { message: 'Process observation unavailable' });
  for (let copy = 0; copy < 2; copy++) await appendRuntimeQa(env, a, crypto.randomUUID(), { message: 'Process observation unavailable' });
  const listed = await createRuntimeQaServices(env, a).list();
  expect(listed.map(item => [item.state, item.duplicateOf])).toEqual([['open', null], ['merged', first.id], ['merged', first.id]]);
  // A later runtime reads the merge back instead of merging again.
  const reopened = createRuntimeQaServices(env, a);
  expect((await reopened.list()).filter(item => item.state === 'open').map(item => item.id)).toEqual([first.id]);
  await Promise.all([reopened.report('Process observation unavailable'), reopened.report('Process observation unavailable')]);
  await reopened.report('Network connection lost.');
  await reopened.report('Network connection lost.');
  expect((await createRuntimeQaServices(env, a).list()).filter(item => item.state === 'open').map(item => item.title)).toEqual(['Process observation unavailable', 'Network connection lost.']);
});

test('filing an issue twice leaves one account row with the latest reviewed copy, and the workspace records when', async () => {
  const { a } = await project();
  const item = await appendRuntimeQa(env, a, crypto.randomUUID(), { message: 'Proc watch failed\nsecret token here', tool: 'proc', model: 'opus' });
  const qa = createRuntimeQaServices(env, a);
  await qa.act({ ...a, itemId: item.id, action: { kind: 'file', excerpt: 'Proc watch failed' } }, actor);
  await qa.act({ ...a, itemId: item.id, action: { kind: 'file', excerpt: 'Proc watch failed (trimmed)' } }, actor);
  const rows = await filed(item.id);
  expect(rows).toEqual([expect.objectContaining({ projectId: a.projectId, workspaceId: 'workspace-a', title: 'Proc watch failed', excerpt: 'Proc watch failed (trimmed)', tool: 'proc', model: 'opus', filedBy: 'browser-1', state: 'open', resolution: null })]);
  // The runtime's own snapshot and a later runtime both show it filed; the item itself stays open.
  expect((await qa.list()).find(entry => entry.id === item.id)).toMatchObject({ state: 'open', filedAt: rows[0]!.filedAt });
  expect((await createRuntimeQaServices(env, a).list()).find(entry => entry.id === item.id)).toMatchObject({ state: 'open', filedAt: rows[0]!.filedAt });
});

test('only the workspace\'s own unmerged issue can be filed', async () => {
  const { a, b } = await project();
  const first = await appendRuntimeQa(env, a, crypto.randomUUID(), { message: 'Repeated failure' });
  const copy = await appendRuntimeQa(env, a, crypto.randomUUID(), { message: 'Repeated failure' });
  const qa = createRuntimeQaServices(env, a);
  expect((await qa.list()).find(entry => entry.id === copy.id)).toMatchObject({ state: 'merged', duplicateOf: first.id });
  await expect(qa.act({ ...a, itemId: copy.id, action: { kind: 'file', excerpt: 'copy' } }, actor)).rejects.toThrow(/merged/u);
  await expect(createRuntimeQaServices(env, b).act({ ...b, itemId: first.id, action: { kind: 'file', excerpt: 'not mine' } }, actor)).rejects.toThrow(/does not belong/u);
  expect([...await filed(copy.id), ...await filed(first.id)]).toEqual([]);
});

test('marking an issue fixed records the commit, in this runtime and the next', async () => {
  const { a } = await project();
  const item = await appendRuntimeQa(env, a, crypto.randomUUID(), { message: 'Broken diff view' });
  const qa = createRuntimeQaServices(env, a);
  await qa.act({ ...a, itemId: item.id, action: { kind: 'fixed', commit } }, actor);
  expect((await qa.list()).find(entry => entry.id === item.id)).toMatchObject({ state: 'fixed', fixedIn: commit });
  expect((await createRuntimeQaServices(env, a).list()).find(entry => entry.id === item.id)).toMatchObject({ state: 'fixed', fixedIn: commit });
});

test('the ops client lists stored filed issues newest first and resolves one without touching the workspace', async () => {
  const machineKey = Uint8Array.from({ length: 32 }, (_, index) => index + 33);
  const vault = env.CREDENTIALS.getByName(env.ACCOUNT_ID);
  await vault.bootstrap({ userId: env.ACCOUNT_ID, rootPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(rootPrivateKey)), vaultKey: credentialProtocolBase64.encode(new Uint8Array(32).fill(7)) });
  await vault.registerDevice(signCredentialAuthorityGrant({
    version: 1, userId: env.ACCOUNT_ID, machineId: 'machine-a', signingPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(machineKey)),
    exchangePublicKey: credentialProtocolBase64.encode(x25519.getPublicKey(new Uint8Array(32).fill(5))), capabilities: ['space.control'], generation: 1,
  }, rootPrivateKey));
  const control = async (operation: ControlOperation, payload: Record<string, unknown>) => {
    const response = await SELF.fetch('https://auth.test/v1/control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(createSignedControlRequest({ userId: env.ACCOUNT_ID, machineId: 'machine-a', operation, payload, signingPrivateKey: machineKey })) });
    expect(response.status).toBe(200);
    return z.object({ value: z.unknown() }).parse(await response.json()).value;
  };
  const { a } = await project();
  const older = await appendRuntimeQa(env, a, crypto.randomUUID(), { message: 'Older failure' });
  const newer = await appendRuntimeQa(env, a, crypto.randomUUID(), { message: 'Newer failure' });
  const state = env.ACCOUNT_STATE.getByName('account');
  for (const [item, filedAt] of [[older, '2026-10-20T10:00:00.000Z'], [newer, '2026-10-21T10:00:00.000Z']] as const) {
    await state.fileIssue({ id: item.id, projectId: a.projectId, workspaceId: a.workspaceId, title: item.title, excerpt: item.description, tool: null, model: item.model, historyRef: item.historyRef, createdAt: item.createdAt, filedAt, filedBy: 'browser-1' });
  }
  const list = async (payload: Record<string, unknown>) => z.array(FiledIssueSchema).parse(await control('account.issues.list', payload)).map(row => row.id);
  expect(await list({})).toEqual([newer.id, older.id]);
  expect(await list({ before: '2026-10-21T10:00:00.000Z' })).toEqual([older.id]);
  expect(FiledIssueSchema.parse(await control('account.issues.resolve', { id: older.id, commit, note: 'fixed in develop' }))).toMatchObject({ state: 'resolved', resolution: { commit, note: 'fixed in develop' } });
  expect(await list({ state: 'open' })).toEqual([newer.id]);
  expect(await list({ state: 'resolved' })).toEqual([older.id]);
  // Resolving here leaves the workspace's issue as it was.
  expect((await createRuntimeQaServices(env, a).list()).find(entry => entry.id === older.id)).toMatchObject({ state: 'open', fixedIn: null });
});
