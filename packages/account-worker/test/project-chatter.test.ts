import { env, runDurableObjectAlarm, runInDurableObject, SELF } from 'cloudflare:test';
import { ed25519 } from '@noble/curves/ed25519.js';
import { createDeviceBinding, credentialProtocolBase64, signDeviceInvite, signRpcRequest, type DeviceCapability, type DeviceScope } from '@gitspace/protocol';
import { CHATTER_RETENTION_MS, type ChatterAuthor } from '@gitspace/protocol/chatter-contract';
import { projectLiveKey } from '@gitspace/protocol/live-notice';
import { parse, stringify } from 'devalue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UserProjectIndexDO } from '../src/project-authority.js';
import { tenantRootPrivateKey } from './setup.js';

const DAY = 24 * 60 * 60_000;
const person: ChatterAuthor = { kind: 'person', id: 'device-1', name: 'Ada' };

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function chatter() {
  const projectId = `project-${crypto.randomUUID()}`;
  const object = env.PROJECT_CHATTER.getByName(`${env.ACCOUNT_ID}:${projectId}`);
  const post = (topic: string, text: string, kind: 'status' | 'tooling' | 'workaround' = 'status') => object.post({ projectId, id: crypto.randomUUID(), topic, kind, text, author: person });
  return { projectId, object, post };
}

/** A project the account knows. */
async function project() {
  const projectId = `project-${crypto.randomUUID()}`;
  const authority = env.PROJECT_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${projectId}`);
  const created = await authority.bootstrap({ id: projectId, name: `Chatter ${projectId}`, repositoryReference: null, baseBranch: 'main', createdBy: 'human' });
  await env.USER_PROJECTS.getByName(env.ACCOUNT_ID).put(await authority.setProjectLifecycle(created.revision, 'active'));
  return projectId;
}

/** A device enrolled with `scope`, and a signed single-call RPC. */
async function device(scope: DeviceScope, capabilities: DeviceCapability[] = ['rpc.read', 'rpc.write']) {
  const userId = env.ACCOUNT_ID;
  const vault = env.CREDENTIALS.getByName(userId);
  await vault.bootstrap({ userId, rootPublicKey: env.AUTH_PUBLIC_KEY, vaultKey: credentialProtocolBase64.encode(new Uint8Array(32).fill(71)) });
  await env.USER_SETTINGS.getByName(userId).setHandle('bootstrap', 0, env.TENANT_ID);
  const key = crypto.getRandomValues(new Uint8Array(32));
  const invite = signDeviceInvite({ version: 1, userId, inviteId: crypto.randomUUID(), kind: 'client', label: null, scope, capabilities, canDelegate: false, issuedAt: Date.now(), expiresAt: Date.now() + 60_000, grantTtlMs: null, enrollUrl: 'https://api.gitspace.sh' }, tenantRootPrivateKey);
  const binding = createDeviceBinding({ inviteId: invite.invite.inviteId, deviceId: crypto.randomUUID(), signingPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(key)), label: 'Client', boundAt: Date.now(), signingPrivateKey: key });
  const enrolled = await vault.enrollDevice({ invite, binding });
  if (enrolled.status !== 'ok') throw new Error(enrolled.error.message);
  return async (path: string, input: unknown): Promise<unknown> => {
    const body = stringify({ v: 1, path, input });
    const signature = signRpcRequest({ deviceId: binding.deviceId, method: 'POST', path: '/rpc', body: new TextEncoder().encode(body), signingPrivateKey: key });
    const response = await SELF.fetch(new Request(`https://${env.TENANT_ID}.gitspace.sh/rpc`, { method: 'POST', body, headers: { 'content-type': 'application/result-rpc+devalue; sv=1', 'x-gitspace-user': userId, 'x-gitspace-device': signature } }));
    const text = await response.text();
    return response.ok ? parse(text) : { status: 'error', http: response.status, text };
  };
}

describe('ProjectChatterDO', () => {
  it('joins posts whose topics differ only in case, punctuation and whitespace into one thread', async () => {
    const { object, post } = chatter();
    const first = await post('SQLite: 2 MB cap!', 'Writes over 2 MB fail with SQLITE_TOOBIG.');
    const second = await post('  sqlite 2 mb   CAP ', 'Split the blob into rows.');
    if (first.status !== 'ok' || second.status !== 'ok') throw new Error('posts refused');
    expect(second.value.post.topicKey).toBe('sqlite 2 mb cap');
    expect(second.value.post.topicKey).toBe(first.value.post.topicKey);
    expect(second.value.topic).toMatchObject({ key: 'sqlite 2 mb cap', display: 'SQLite: 2 MB cap!', posts: 2, state: null });
    expect(second.value.similar).toBeNull();
    const page = await object.watch({});
    expect(page.events.map(event => event.topicKey)).toEqual(['sqlite 2 mb cap', 'sqlite 2 mb cap']);
    expect(page.topics).toHaveLength(1);
    expect(await object.watch({ topic: 'SQLITE 2 MB CAP' })).toMatchObject({ events: [{ text: 'Writes over 2 MB fail with SQLITE_TOOBIG.' }, { text: 'Split the blob into rows.' }] });
  });

  it('posts a new topic close to an active one under its own topic, naming the active one', async () => {
    const { object, post } = chatter();
    await post('bun test hang', 'bun test never exits in CI.');
    await post('bun test hang', 'It hangs on the watcher.');
    const near = await post('bun test hangs', 'Same here on my branch.');
    if (near.status !== 'ok') throw new Error('post refused');
    expect(near.value.topic).toMatchObject({ key: 'bun test hangs', posts: 1 });
    expect(near.value.similar).toMatchObject({ key: 'bun test hang', posts: 2 });
    const unrelated = await post('deploy dry run size', 'The bundle is 9 MB.');
    expect(unrelated).toMatchObject({ status: 'ok', value: { similar: null } });
    expect((await object.topics({})).map(topic => topic.key)).toEqual(['deploy dry run size', 'bun test hangs', 'bun test hang']);
  });

  it('opens an issue with a tooling post, resolves it, and reopens it only on a new tooling post', async () => {
    const { projectId, object, post } = chatter();
    const status = await post('wrangler dev crash', 'wrangler dev exits on reload.');
    expect(status).toMatchObject({ status: 'ok', value: { topic: { state: null }, line: null } });
    // A topic that is not an issue can only be opened.
    expect(await object.act({ projectId, key: 'wrangler dev crash', action: { kind: 'state', state: 'resolved', fixedIn: null }, author: person })).toMatchObject({ status: 'error', failure: { kind: 'invalid', field: 'action' } });
    const report = await post('Wrangler dev crash', 'Crashes again after the upgrade.', 'tooling');
    expect(report).toMatchObject({ status: 'ok', value: { topic: { state: 'open', stateBy: 'Ada' }, line: { type: 'topic', change: { kind: 'state', state: 'open', from: null } } } });
    expect(await object.act({ projectId, key: 'wrangler dev crash', action: { kind: 'state', state: 'dismissed', fixedIn: 'abc123' }, author: person })).toMatchObject({ status: 'error', failure: { kind: 'invalid' } });
    const resolved = await object.act({ projectId, key: 'wrangler dev crash', action: { kind: 'state', state: 'resolved', fixedIn: 'abc123' }, author: person });
    expect(resolved).toMatchObject({ status: 'ok', value: { topic: { state: 'resolved', fixedIn: 'abc123' }, line: { change: { kind: 'state', state: 'resolved', from: 'open', fixedIn: 'abc123' } } } });
    expect(await object.act({ projectId, key: 'wrangler dev crash', action: { kind: 'state', state: 'resolved', fixedIn: 'abc123' }, author: person })).toMatchObject({ status: 'ok', value: { line: null } });
    // Talk about the fix is not a report of the failure.
    expect(await post('wrangler dev crash', 'Confirmed fixed on my machine.', 'workaround')).toMatchObject({ status: 'ok', value: { topic: { state: 'resolved' }, line: null } });
    const again = await post('wrangler dev crash', 'Back after the rebase.', 'tooling');
    expect(again).toMatchObject({ status: 'ok', value: { topic: { state: 'open', fixedIn: 'abc123', posts: 4 }, line: { change: { kind: 'state', state: 'open', from: 'resolved' } } } });
    expect(await object.act({ projectId, key: 'nothing like it', action: { kind: 'state', state: 'open', fixedIn: null }, author: person })).toMatchObject({ status: 'error', failure: { kind: 'notFound' } });
  });

  it('merges a topic into another: its posts move, and a later post under it lands in the other', async () => {
    const { projectId, object, post } = chatter();
    await post('bun test hang', 'bun test never exits.', 'tooling');
    await post('bun test hangs', 'Watcher keeps it alive.');
    const merged = await object.act({ projectId, key: 'bun test hangs', action: { kind: 'merge', into: 'Bun test hang' }, author: person });
    expect(merged).toMatchObject({ status: 'ok', value: { topic: { key: 'bun test hang', posts: 2, state: 'open' }, line: { change: { kind: 'merge', from: 'bun test hangs' } } } });
    const later = await post('bun-test hangs', 'Fixed by closing the watcher.');
    expect(later).toMatchObject({ status: 'ok', value: { post: { topicKey: 'bun test hang', topic: 'bun-test hangs' }, topic: { posts: 3 } } });
    expect((await object.topics({})).map(topic => topic.key)).toEqual(['bun test hang']);
    expect(await object.act({ projectId, key: 'bun test hang', action: { kind: 'merge', into: 'bun test hangs' }, author: person })).toMatchObject({ status: 'error', failure: { kind: 'invalid', field: 'into' } });
  });

  it('drops a topic and all its events 90 days after its last post, keeping topics posted in since', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.now();
    const { object, post } = chatter();
    await post('flaky e2e', 'The checkout spec flakes.', 'tooling');
    await post('cache warmup', 'Warm the cache before the run.');
    vi.setSystemTime(start + 50 * DAY);
    await post('cache warmup', 'Still needed.');
    expect(await runInDurableObject(object, (_instance, state) => state.storage.getAlarm())).toBe(start + CHATTER_RETENTION_MS);
    vi.setSystemTime(start + CHATTER_RETENTION_MS + 1);
    expect(await runDurableObjectAlarm(object)).toBe(true);
    const page = await object.watch({});
    expect(page.events.map(event => event.topicKey)).toEqual(['cache warmup', 'cache warmup']);
    expect(page.topics.map(topic => topic.key)).toEqual(['cache warmup']);
    expect(await object.watch({ topic: 'flaky e2e' })).toMatchObject({ events: [], topics: [] });
    const rows = await runInDurableObject(object, (_instance, state) => state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM chatter_topics WHERE key = 'flaky e2e'").one().count);
    expect(rows).toBe(0);
    expect(await runInDurableObject(object, (_instance, state) => state.storage.getAlarm())).toBe(start + 50 * DAY + CHATTER_RETENTION_MS);
  });

  it('pages older events with before and newer events with after', async () => {
    const { object, post } = chatter();
    for (let index = 0; index < 5; index++) await post('paging', `post ${index}`);
    const newest = await object.watch({ limit: 2 });
    expect(newest).toMatchObject({ events: [{ text: 'post 3' }, { text: 'post 4' }], more: true });
    const older = await object.watch({ before: newest.events[0]?.offset, limit: 2 });
    expect(older).toMatchObject({ events: [{ text: 'post 1' }, { text: 'post 2' }], more: true });
    await post('paging', 'post 5');
    expect(await object.watch({ after: newest.cursor })).toMatchObject({ events: [{ text: 'post 5' }], more: false });
  });
});

describe('chatter RPC', () => {
  it('reads and posts for a device whose scope reaches the project, and tells open tabs', async () => {
    const projectId = await project();
    const notices = vi.spyOn(UserProjectIndexDO.prototype, 'liveNotices');
    const rpc = await device({ kind: 'project', projectId });
    expect(await rpc('chatter.post', { projectId, id: 'post-1', topic: 'Release notes', kind: 'discovery', text: 'Changelog moved to docs/.' })).toMatchObject({ status: 'ok', value: { post: { topicKey: 'release notes', author: { kind: 'person' } } } });
    expect(await rpc('chatter.watch', { projectId })).toMatchObject({ status: 'ok', value: { events: [{ text: 'Changelog moved to docs/.' }], topics: [{ key: 'release notes', posts: 1 }] } });
    expect(await rpc('chatter.topics', { projectId, query: 'release' })).toMatchObject({ status: 'ok', value: { topics: [{ key: 'release notes' }] } });
    expect(notices.mock.calls.flatMap(([sent]) => sent)).toContainEqual(expect.objectContaining(projectLiveKey(projectId, 'chatter')));
  });

  it('refuses another project\'s Chatter to a project-scoped grant, and any Chatter to a workspace-scoped one', async () => {
    const mine = await project();
    const other = await project();
    await env.PROJECT_CHATTER.getByName(`${env.ACCOUNT_ID}:${other}`).post({ projectId: other, id: 'secret', topic: 'other project', kind: 'status', text: 'Not for you.', author: person });
    const scoped = await device({ kind: 'project', projectId: mine });
    const read = await scoped('chatter.watch', { projectId: other });
    expect(read).toMatchObject({ status: 'error' });
    expect(JSON.stringify(read)).not.toContain('Not for you.');
    expect(await scoped('chatter.post', { projectId: other, id: 'x', topic: 'other project', kind: 'status', text: 'hello' })).toMatchObject({ status: 'error' });
    const several = await device({ kind: 'projects', projectIds: [mine, other] });
    expect(await several('chatter.watch', { projectId: other })).toMatchObject({ status: 'ok', value: { events: [{ text: 'Not for you.' }] } });
    const workspace = await device({ kind: 'workspace', workspaceId: mine });
    expect(await workspace('chatter.watch', { projectId: mine })).toMatchObject({ status: 'error' });
    const reader = await device({ kind: 'project', projectId: mine }, ['rpc.read']);
    expect(await reader('chatter.post', { projectId: mine, id: 'y', topic: 'a topic', kind: 'status', text: 'hello' })).toMatchObject({ status: 'error' });
  });
});
