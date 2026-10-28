import { env, runDurableObjectAlarm, runInDurableObject, SELF } from 'cloudflare:test';
import { expect, test } from 'vitest';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { createSignedControlRequest, credentialProtocolBase64, signCredentialAuthorityGrant, type ControlOperation } from '@gitspace/protocol';
import { projectEventSchema, type ProjectEvent } from '@gitspace/protocol/project-authority';
import { RuntimeIdentitySchema } from '@gitspace/protocol-runtime';
import { FiledIssueSchema } from '@gitspace/protocol-runtime/workspace-controls';
import { z } from 'zod';
import { appendRuntimeQa, createRuntimeQaServices, type RuntimeQaServices } from '../src/runtime-qa.js';
import type { RuntimeIdentity } from '../src/runtime-services.js';
import { tenantRootPrivateKey as rootPrivateKey } from './setup.js';

const actor = { deviceId: 'browser-1', canApprove: true };
const commit = 'a'.repeat(40);

async function project() {
  const projectId = `qa-${crypto.randomUUID()}`;
  await env.PROJECT_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${projectId}`).bootstrap({ id: projectId, name: projectId, repositoryReference: null, baseBranch: 'main', createdBy: 'user' });
  return { a: RuntimeIdentitySchema.parse({ projectId, workspaceId: `${projectId}-a` }), b: RuntimeIdentitySchema.parse({ projectId, workspaceId: `${projectId}-b` }) };
}
const filed = async (id: string) => (await env.ACCOUNT_STATE.getByName('account').listFiledIssues({ limit: 100 })).filter(row => row.id === id);
const space = (identity: RuntimeIdentity) => env.SPACE_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${identity.workspaceId}`);
/** `work` with the QA inbox of the workspace's own object. */
const inbox = <T>(identity: RuntimeIdentity, work: (qa: RuntimeQaServices, storage: DurableObjectStorage) => T | Promise<T>) => runInDurableObject(space(identity), (_instance, state) => work(createRuntimeQaServices(state.storage, env, identity), state.storage));
/** Ends the object's instance; the next call builds it again from what it stored. */
async function restart(stub: DurableObjectStub) {
  await runInDurableObject(stub, (_instance, state) => { state.abort('restart'); }).catch(() => {});
}

test('copies of an open report are merged into the first, a repeated failure files nothing new, and both hold across a restart', async () => {
  const { a } = await project();
  const first = await inbox(a, (_qa, storage) => {
    const item = appendRuntimeQa(storage, a, crypto.randomUUID(), { message: 'Process observation unavailable' });
    for (let copy = 0; copy < 2; copy++) appendRuntimeQa(storage, a, crypto.randomUUID(), { message: 'Process observation unavailable' });
    return item;
  });
  await restart(space(a));
  expect(await inbox(a, qa => qa.list().map(item => [item.state, item.duplicateOf]))).toEqual([['open', null], ['merged', first.id], ['merged', first.id]]);
  await inbox(a, qa => { qa.report('Process observation unavailable'); qa.report('Network connection lost.'); qa.report('Network connection lost.'); });
  await restart(space(a));
  expect(await inbox(a, qa => qa.list().filter(item => item.state === 'open').map(item => item.title))).toEqual(['Process observation unavailable', 'Network connection lost.']);
});

test('filing an issue twice leaves one account row with the latest reviewed copy, and the workspace records when, across a restart', async () => {
  const { a } = await project();
  const item = await inbox(a, async (qa, storage) => {
    const reported = appendRuntimeQa(storage, a, crypto.randomUUID(), { message: 'Proc watch failed\nsecret token here', tool: 'proc', model: 'opus' });
    await qa.act({ ...a, itemId: reported.id, action: { kind: 'file', excerpt: 'Proc watch failed' } }, actor);
    await qa.act({ ...a, itemId: reported.id, action: { kind: 'file', excerpt: 'Proc watch failed (trimmed)' } }, actor);
    return reported;
  });
  const rows = await filed(item.id);
  expect(rows).toEqual([expect.objectContaining({ projectId: a.projectId, workspaceId: a.workspaceId, title: 'Proc watch failed', excerpt: 'Proc watch failed (trimmed)', tool: 'proc', model: 'opus', filedBy: 'browser-1', state: 'open', resolution: null })]);
  await restart(space(a));
  // The item itself stays open.
  expect(await inbox(a, qa => qa.list().find(entry => entry.id === item.id))).toMatchObject({ state: 'open', filedAt: rows[0]!.filedAt });
});

test('only the workspace\'s own unmerged issue can be filed', async () => {
  const { a, b } = await project();
  const [first, copy] = await inbox(a, (_qa, storage) => [appendRuntimeQa(storage, a, crypto.randomUUID(), { message: 'Repeated failure' }), appendRuntimeQa(storage, a, crypto.randomUUID(), { message: 'Repeated failure' })]);
  expect(copy).toMatchObject({ state: 'merged', duplicateOf: first!.id });
  await expect(inbox(a, qa => qa.act({ ...a, itemId: copy!.id, action: { kind: 'file', excerpt: 'copy' } }, actor))).rejects.toThrow(/merged/u);
  await expect(inbox(b, qa => qa.act({ ...b, itemId: first!.id, action: { kind: 'file', excerpt: 'not mine' } }, actor))).rejects.toThrow(/does not belong/u);
  expect([...await filed(copy!.id), ...await filed(first!.id)]).toEqual([]);
});

test('marking an issue fixed records the commit, across a restart', async () => {
  const { a } = await project();
  const item = await inbox(a, async (qa, storage) => {
    const reported = appendRuntimeQa(storage, a, crypto.randomUUID(), { message: 'Broken diff view' });
    await qa.act({ ...a, itemId: reported.id, action: { kind: 'fixed', commit } }, actor);
    return reported;
  });
  await restart(space(a));
  expect(await inbox(a, qa => qa.list().find(entry => entry.id === item.id))).toMatchObject({ state: 'fixed', fixedIn: commit });
});

test('the project\'s QA items move once to the workspaces they belong to, each in its latest state', async () => {
  const { a, b } = await project();
  const authority = env.PROJECT_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${a.projectId}`);
  for (const identity of [a, b]) await authority.putWorkspace({ id: identity.workspaceId, projectId: identity.projectId, kind: 'worktree', name: identity.workspaceId, branch: identity.workspaceId, phase: null, sourceKind: 'branch', sourceRef: 'main', sourceCommit: null, lifecycle: 'active', goalId: null, expectedRevision: 0 });
  const recorded = (workspaceId: string, title: string, state: 'open' | 'dismissed', id: string = crypto.randomUUID()): Omit<ProjectEvent, 'offset' | 'createdAt' | 'eventId'> => ({ scope: 'workspace', entity: 'qa', entityId: id, revision: 1, operation: 'created', payload: { workspaceId, item: { id, title, description: title, historyRef: `history://${workspaceId}`, tool: null, model: 'opus', runtimeVersion: 'pi-1.0', state, duplicateOf: null, createdAt: new Date().toISOString() } } });
  // Live projects finished their legacy event purge, which deletes the events of entities no longer kept.
  await runInDurableObject(authority, (_instance, state) => { state.storage.sql.exec('CREATE TABLE IF NOT EXISTS legacy_events_purged(done INTEGER)'); });
  const dismissedLater = crypto.randomUUID();
  await authority.appendEvents([recorded(a.workspaceId, 'Failure in A', 'open', dismissedLater), recorded(b.workspaceId, 'Failure in B', 'open'), recorded('deleted-workspace', 'Failure nobody shows', 'open'), recorded(a.workspaceId, 'Failure in A', 'dismissed', dismissedLater), recorded(a.workspaceId, 'Second failure in A', 'open')]);
  // A release restarts the object; its start schedules the move.
  await restart(authority);
  const restarted = env.PROJECT_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${a.projectId}`);
  expect(await runDurableObjectAlarm(restarted)).toBe(true);
  const titles = (identity: RuntimeIdentity) => inbox(identity, qa => qa.list().map(item => [item.title, item.state]));
  expect(await titles(a)).toEqual([['Failure in A', 'dismissed'], ['Second failure in A', 'open']]);
  expect(await titles(b)).toEqual([['Failure in B', 'open']]);
  const events = z.array(projectEventSchema).parse(await (await restarted.listEvents(0)).json());
  expect(events.filter(event => event.entity === 'qa')).toEqual([]);
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
  const [older, newer] = await inbox(a, (_qa, storage) => [appendRuntimeQa(storage, a, crypto.randomUUID(), { message: 'Older failure' }), appendRuntimeQa(storage, a, crypto.randomUUID(), { message: 'Newer failure' })]);
  if (!older || !newer) throw new Error('Expected two filed items');
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
  expect(await inbox(a, qa => qa.list().find(entry => entry.id === older.id))).toMatchObject({ state: 'open', fixedIn: null });
});
