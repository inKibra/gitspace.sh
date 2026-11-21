import { env, runDurableObjectAlarm, runInDurableObject, SELF } from 'cloudflare:test';
import { afterEach, expect, test, vi } from 'vitest';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { createSignedControlRequest, credentialProtocolBase64, signCredentialAuthorityGrant, type ControlOperation } from '@gitspace/protocol';
import type { ProjectEvent } from '@gitspace/protocol/project-authority';
import { RuntimeIdentitySchema } from '@gitspace/protocol-runtime';
import { FiledIssueSchema, type RuntimeQaItem } from '@gitspace/protocol-runtime/workspace-controls';
import { z } from 'zod';
import { ProjectAuthorityDO, SpaceAuthorityDO } from '../src/index.js';
import { appendRuntimeQa, createRuntimeQaServices, type RuntimeQaServices } from '../src/runtime-qa.js';
import type { RuntimeIdentity } from '../src/runtime-services.js';
import { tenantRootPrivateKey as rootPrivateKey } from './setup.js';

const actor = { deviceId: 'browser-1', canApprove: true };
const commit = 'a'.repeat(40);
const restores: Array<() => void> = [];
afterEach(() => { for (const restore of restores.splice(0)) restore(); vi.restoreAllMocks(); });

const authorityOf = (projectId: string) => env.PROJECT_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${projectId}`);
/** A project with two live workspaces. */
async function project() {
  const projectId = `qa-${crypto.randomUUID()}`;
  const authority = authorityOf(projectId);
  await authority.bootstrap({ id: projectId, name: projectId, repositoryReference: null, baseBranch: 'main', createdBy: 'user' });
  const [a, b] = ['a', 'b'].map(name => RuntimeIdentitySchema.parse({ projectId, workspaceId: `${projectId}-${name}` }));
  if (!a || !b) throw new Error('Expected two workspaces');
  for (const identity of [a, b]) await authority.putWorkspace({ id: identity.workspaceId, projectId, kind: 'worktree', name: identity.workspaceId, branch: identity.workspaceId, phase: null, sourceKind: 'branch', sourceRef: 'main', sourceCommit: null, lifecycle: 'active', goalId: null, expectedRevision: 0 });
  return { a, b, authority };
}
const filed = async (id: string) => (await env.ACCOUNT_STATE.getByName('account').listFiledIssues({ limit: 100 })).filter(row => row.id === id);
const space = (identity: RuntimeIdentity) => env.SPACE_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${identity.workspaceId}`);
/** `work` with the QA inbox of the workspace's own object, as one-off callers (the relay, the LFS alarm) use it. */
const inbox = <T>(identity: RuntimeIdentity, work: (qa: RuntimeQaServices, storage: DurableObjectStorage) => T | Promise<T>) => runInDurableObject(space(identity), (_instance, state) => work(createRuntimeQaServices(state.storage, env, identity), state.storage));
const titles = (identity: RuntimeIdentity) => inbox(identity, async qa => (await qa.list()).map(item => [item.title, item.state]));
/** Ends the object's instance; the next call builds it again from what it stored. */
async function restart(stub: DurableObjectStub) {
  await runInDurableObject(stub, (_instance, state) => { state.abort('restart'); }).catch(() => {});
}
/** A QA event as code from before workspaces kept their own items wrote it to the project. */
function recorded(workspaceId: string, title: string, state: RuntimeQaItem['state'], id: string = crypto.randomUUID()): Omit<ProjectEvent, 'offset' | 'createdAt' | 'eventId'> {
  return { scope: 'workspace', entity: 'qa', entityId: id, revision: 1, operation: 'created', payload: { workspaceId, item: { id, title, description: title, historyRef: `history://${workspaceId}`, tool: null, model: 'opus', runtimeVersion: 'pi-1.0', state, duplicateOf: null, createdAt: new Date().toISOString() } } };
}
const qaEvents = (authority: DurableObjectStub<ProjectAuthorityDO>) => runInDurableObject(authority, (_instance, state) => state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM project_events WHERE entity='qa'").one().count);
/** The object answers "does not implement the method" for `name`, as an object still on the previous release does. */
function withoutMethod(prototype: object, name: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
  if (!descriptor) throw new Error(`No method ${name}`);
  Reflect.deleteProperty(prototype, name);
  restores.push(() => Object.defineProperty(prototype, name, descriptor));
}
/** A runtime's inbox: it reads the project's copy in the background, collected here, until the move reaches it. */
function runtimeInbox(storage: DurableObjectStorage, identity: RuntimeIdentity) {
  const pending: Promise<unknown>[] = [];
  let changed = 0;
  const qa = createRuntimeQaServices(storage, env, identity, { waitUntil: promise => { pending.push(promise); }, changed: () => { changed++; } });
  return { qa, pending, changed: () => changed };
}

test('copies of an open report are merged into the first, a repeated failure files nothing new, and both hold across a restart', async () => {
  const { a } = await project();
  const first = await inbox(a, (_qa, storage) => {
    const item = appendRuntimeQa(storage, a, crypto.randomUUID(), { message: 'Process observation unavailable' });
    for (let copy = 0; copy < 2; copy++) appendRuntimeQa(storage, a, crypto.randomUUID(), { message: 'Process observation unavailable' });
    return item;
  });
  await restart(space(a));
  expect(await inbox(a, async qa => (await qa.list()).map(item => [item.state, item.duplicateOf]))).toEqual([['open', null], ['merged', first.id], ['merged', first.id]]);
  await inbox(a, qa => { qa.report('Process observation unavailable'); qa.report('Network connection lost.'); qa.report('Network connection lost.'); });
  await restart(space(a));
  expect(await inbox(a, async qa => (await qa.list()).filter(item => item.state === 'open').map(item => item.title))).toEqual(['Process observation unavailable', 'Network connection lost.']);
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
  expect(await inbox(a, async qa => (await qa.list()).find(entry => entry.id === item.id))).toMatchObject({ state: 'open', filedAt: rows[0]!.filedAt });
});

test('only the workspace\'s own unmerged issue can be filed', async () => {
  const { a, b } = await project();
  const [first, copy] = await inbox(a, (_qa, storage) => [appendRuntimeQa(storage, a, crypto.randomUUID(), { message: 'Repeated failure' }), appendRuntimeQa(storage, a, crypto.randomUUID(), { message: 'Repeated failure' })]);
  if (!first || !copy) throw new Error('Expected two filed items');
  expect(copy).toMatchObject({ state: 'merged', duplicateOf: first.id });
  await expect(inbox(a, qa => qa.act({ ...a, itemId: copy.id, action: { kind: 'file', excerpt: 'copy' } }, actor))).rejects.toThrow(/merged/u);
  await expect(inbox(b, qa => qa.act({ ...b, itemId: first.id, action: { kind: 'file', excerpt: 'not mine' } }, actor))).rejects.toThrow(/does not belong/u);
  expect([...await filed(copy.id), ...await filed(first.id)]).toEqual([]);
});

test('marking an issue fixed records the commit, across a restart', async () => {
  const { a } = await project();
  const item = await inbox(a, async (qa, storage) => {
    const reported = appendRuntimeQa(storage, a, crypto.randomUUID(), { message: 'Broken diff view' });
    await qa.act({ ...a, itemId: reported.id, action: { kind: 'fixed', commit } }, actor);
    return reported;
  });
  await restart(space(a));
  expect(await inbox(a, async qa => (await qa.list()).find(entry => entry.id === item.id))).toMatchObject({ state: 'fixed', fixedIn: commit });
});

test('the project\'s QA items move once to the workspaces they belong to, each in its latest state, and the move logs its progress', async () => {
  const { a, b, authority } = await project();
  const dismissedLater = crypto.randomUUID();
  const stale = crypto.randomUUID();
  await authority.appendEvents([recorded(a.workspaceId, 'Failure in A', 'open', dismissedLater), recorded(b.workspaceId, 'Failure in B', 'open'), recorded('deleted-workspace', 'Failure nobody shows', 'open'), recorded(a.workspaceId, 'Failure in A', 'dismissed', dismissedLater), recorded(a.workspaceId, 'Second failure in A', 'open'), recorded(b.workspaceId, 'Fixed since the first move', 'fixed', stale)]);
  // The move of 2026-10-28 left a copy in B's storage, in the table's first shape, in the state it had then.
  await runInDurableObject(space(b), (_instance, state) => {
    state.storage.sql.exec('CREATE TABLE runtime_qa_items(id TEXT PRIMARY KEY, created_at TEXT NOT NULL, state TEXT NOT NULL, history_ref TEXT NOT NULL, title TEXT NOT NULL, item TEXT NOT NULL)');
    const item = { ...z.object({ item: z.record(z.string(), z.unknown()) }).parse(recorded(b.workspaceId, 'Fixed since the first move', 'open', stale).payload).item, createdAt: '2026-10-28T16:48:00.000Z' };
    state.storage.sql.exec('INSERT INTO runtime_qa_items(id,created_at,state,history_ref,title,item) VALUES(?,?,?,?,?,?)', stale, item.createdAt, 'open', `history://${b.workspaceId}`, 'Fixed since the first move', JSON.stringify(item));
  });
  const logged: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((line: unknown) => { logged.push(String(line)); });
  // A release restarts the object; its start schedules the move.
  await restart(authority);
  expect(await runDurableObjectAlarm(authorityOf(a.projectId))).toBe(true);
  expect(await titles(a)).toEqual([['Failure in A', 'dismissed'], ['Second failure in A', 'open']]);
  expect(await titles(b)).toEqual([['Fixed since the first move', 'fixed'], ['Failure in B', 'open']]);
  expect(await qaEvents(authorityOf(a.projectId))).toBe(0);
  const events = logged.flatMap(line => line.startsWith('{"event":"qa_move') ? [JSON.parse(line)] : []);
  expect(events).toEqual([
    { event: 'qa_move_workspace', projectId: a.projectId, workspaceId: a.workspaceId, items: 2 },
    { event: 'qa_move_workspace', projectId: a.projectId, workspaceId: b.workspaceId, items: 2 },
    { event: 'qa_move_finished', projectId: a.projectId, workspaces: 2, items: 4, orphaned: 1, failed: 0, left: 0 },
  ]);
});

test('a workspace still on the previous release keeps its items in the project until a later move reaches it', async () => {
  const { a, authority } = await project();
  await authority.appendEvents([recorded(a.workspaceId, 'Failure before the release', 'open')]);
  withoutMethod(SpaceAuthorityDO.prototype, 'runtimeQaImport');
  const now = Date.now();
  // The move retries across the release, then leaves the items where they are and tries again a minute later.
  expect(await runDurableObjectAlarm(authority)).toBe(true);
  expect(await qaEvents(authority)).toBe(1);
  expect(await runInDurableObject(authority, (_instance, state) => state.storage.getAlarm())).toBeGreaterThanOrEqual(now + 60_000);
  // Until then the workspace's runtime shows them from the project.
  const shown = await runInDurableObject(space(a), async (_instance, state) => {
    const runtime = runtimeInbox(state.storage, a);
    await runtime.qa.list();
    await Promise.all(runtime.pending);
    return (await runtime.qa.list()).map(item => item.title);
  });
  expect(shown).toEqual(['Failure before the release']);
  for (const restore of restores.splice(0)) restore();
  // The next run, a minute later and on the new code, moves them.
  const later = Date.now() + 61_000;
  vi.spyOn(Date, 'now').mockReturnValue(later);
  expect(await runDurableObjectAlarm(authority)).toBe(true);
  expect(await qaEvents(authority)).toBe(0);
  expect(await titles(a)).toEqual([['Failure before the release', 'open']]);
});

test('until the move reaches a workspace its runtime shows the project\'s items too, without waiting on the project, and keeps its own later changes', async () => {
  const { a, b, authority } = await project();
  const kept = crypto.randomUUID();
  await authority.appendEvents([recorded(a.workspaceId, 'Kept in the project', 'open', kept)]);
  const local = await runInDurableObject(space(a), async (_instance, state) => {
    appendRuntimeQa(state.storage, a, crypto.randomUUID(), { message: 'Filed here' });
    const runtime = runtimeInbox(state.storage, a);
    // The first snapshot lists what this object holds; the project's copy arrives in the background.
    const first = (await runtime.qa.list()).map(item => item.title);
    await Promise.all(runtime.pending);
    const second = (await runtime.qa.list()).map(item => item.title).sort();
    // Dismissing an item of the project's copy writes it here, later than that copy.
    await runtime.qa.act({ ...a, itemId: kept, action: { kind: 'dismiss' } }, actor);
    return { first, second, changed: runtime.changed() };
  });
  expect(local).toEqual({ first: ['Filed here'], second: ['Filed here', 'Kept in the project'], changed: 1 });
  // The move carries the project's older, open copy: the dismissal stays, and the workspace reads only its own from now on.
  expect(await runDurableObjectAlarm(authority)).toBe(true);
  const after = await runInDurableObject(space(a), async (_instance, state) => {
    const runtime = runtimeInbox(state.storage, a);
    const items = (await runtime.qa.list()).map(item => [item.title, item.state]);
    return { items, reads: runtime.pending.length };
  });
  expect(after).toEqual({ items: [['Kept in the project', 'dismissed'], ['Filed here', 'open']], reads: 0 });
  // A workspace the project kept nothing for records that on its first read, publishes nothing new, and never asks again.
  const empty = await runInDurableObject(space(b), async (_instance, state) => {
    const runtime = runtimeInbox(state.storage, b);
    await runtime.qa.list();
    await Promise.all(runtime.pending);
    const again = runtimeInbox(state.storage, b);
    await again.qa.list();
    return { first: runtime.pending.length, changed: runtime.changed(), again: again.pending.length };
  });
  expect(empty).toEqual({ first: 1, changed: 0, again: 0 });
});

test('a runtime lists its own items while the project object answers nothing, or still runs code without workspaceQa', async () => {
  const { a, b } = await project();
  const stalled = Promise.withResolvers<void>();
  const descriptor = Object.getOwnPropertyDescriptor(ProjectAuthorityDO.prototype, 'workspaceQa');
  if (!descriptor || typeof descriptor.value !== 'function') throw new Error('No workspaceQa');
  const original: (workspaceId: string) => unknown = descriptor.value;
  Object.defineProperty(ProjectAuthorityDO.prototype, 'workspaceQa', { ...descriptor, value(this: ProjectAuthorityDO, workspaceId: string) { return stalled.promise.then(() => original.call(this, workspaceId)); } });
  restores.push(() => Object.defineProperty(ProjectAuthorityDO.prototype, 'workspaceQa', descriptor));
  const listed = await runInDurableObject(space(a), async (_instance, state) => {
    appendRuntimeQa(state.storage, a, crypto.randomUUID(), { message: 'Filed here' });
    const runtime = runtimeInbox(state.storage, a);
    const items = (await runtime.qa.list()).map(item => item.title);
    stalled.resolve();
    await Promise.all(runtime.pending);
    return items;
  });
  expect(listed).toEqual(['Filed here']);
  for (const restore of restores.splice(0)) restore();
  // A workspace whose project object still runs code without `workspaceQa` lists its own items, and the next snapshot
  // waits a minute before it reads again.
  withoutMethod(ProjectAuthorityDO.prototype, 'workspaceQa');
  const warned: string[] = [];
  vi.spyOn(console, 'warn').mockImplementation((line: unknown) => { warned.push(String(line)); });
  const fallback = await runInDurableObject(space(b), async (_instance, state) => {
    appendRuntimeQa(state.storage, b, crypto.randomUUID(), { message: 'Filed in B' });
    const runtime = runtimeInbox(state.storage, b);
    await runtime.qa.list();
    await Promise.all(runtime.pending);
    await runtime.qa.list();
    return { items: (await runtime.qa.list()).map(item => item.title), reads: runtime.pending.length };
  });
  expect(fallback).toEqual({ items: ['Filed in B'], reads: 1 });
  expect(warned.some(line => line.includes('qa_project_copy_failed'))).toBe(true);
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
  expect(await inbox(a, async qa => (await qa.list()).find(entry => entry.id === older.id))).toMatchObject({ state: 'open', fixedIn: null });
});
