import { env, runDurableObjectAlarm, runInDurableObject, SELF } from 'cloudflare:test';
import { ed25519 } from '@noble/curves/ed25519.js';
import { createDeviceBinding, credentialProtocolBase64, signDeviceInvite, signRpcRequest, type DeviceCapability, type DeviceScope } from '@gitspace/protocol';
import { CHATTER_RETENTION_MS, type ChatterAuthor, type ChatterDigest, type ChatterKind } from '@gitspace/protocol/chatter-contract';
import { projectLiveKey } from '@gitspace/protocol/live-notice';
import { parse, stringify } from 'devalue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ChatterListener, DigestDecide } from '../src/chatter-digest.js';
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
async function device(scope: DeviceScope, capabilities: DeviceCapability[] = ['rpc.read', 'rpc.write', 'session.prompt']) {
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
    // The digest build the posts asked for is due first (no later than two minutes after the first post); once it ran,
    // the alarm follows the oldest topic's expiry.
    expect(await runInDurableObject(object, (_instance, state) => state.storage.getAlarm())).toBe(start + 2 * 60_000);
    expect(await runDurableObjectAlarm(object)).toBe(true);
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

describe('issues in Chatter', () => {
  const failure = (projectId: string, workspace: { id: string; name: string }, message = 'Network connection lost (ref 0fea5eaeb2ba)') =>
    env.PROJECT_CHATTER.getByName(`${env.ACCOUNT_ID}:${projectId}`).runtimeFailure({ projectId, workspace, source: 'model request', message });

  it('posts a runtime failure as GitSpace under a fixed topic, folds a repeat from the same workspace into counts, and posts again once resolved', async () => {
    const { projectId, object } = chatter();
    const parser = { id: 'ws-parser', name: 'Parser' };
    expect(await failure(projectId, parser)).toMatchObject({ kind: 'posted', post: { author: { kind: 'gitspace', id: 'ws-parser', name: 'Parser' }, spot: { tool: 'model request', reference: 'history://ws-parser' } }, topic: { key: 'model request network connection lost ref', state: 'open', posts: 1 } });
    // Another occurrence, with a different reference id in its text: the same topic, counted.
    expect(await failure(projectId, parser, 'Network connection lost (ref 77aa00cc11dd)')).toMatchObject({ kind: 'repeated', topic: { posts: 1, repeats: 1 } });
    expect(await failure(projectId, { id: 'ws-billing', name: 'Billing' })).toMatchObject({ kind: 'posted', topic: { posts: 2, repeats: 1 } });
    await object.act({ projectId, key: 'model request network connection lost ref', action: { kind: 'state', state: 'resolved', fixedIn: null }, author: person });
    expect(await failure(projectId, parser)).toMatchObject({ kind: 'posted', topic: { posts: 3, state: 'open' } });
  });

  it('reads the issue topics a workspace posted in, with its tooling posts, and the active topics for agents', async () => {
    const { projectId, object, post } = chatter();
    const agent: ChatterAuthor = { kind: 'workspace', id: 'ws-a', name: 'Parser' };
    await object.post({ projectId, id: 'tooling-a', topic: 'sync drops files · sync', kind: 'tooling', text: 'sync now left 3 files', author: agent, phase: 'code', spot: { tool: 'sync', reference: 'history://ws-a/main#4', machine: 'm-1' } });
    await object.post({ projectId, id: 'status-a', topic: 'release notes', kind: 'status', text: 'Moved the changelog.', author: agent, phase: 'code' });
    await post('other issue', 'Someone else broke it.', 'tooling');
    await failure(projectId, { id: 'ws-a', name: 'Parser' });
    const issues = await object.issues('ws-a');
    expect(issues.topics.map(topic => topic.key)).toEqual(['model request network connection lost ref', 'sync drops files sync']);
    expect(issues.posts.map(entry => [entry.topicKey, entry.phase, entry.spot?.machine ?? null])).toEqual([['model request network connection lost ref', null, null], ['sync drops files sync', 'code', 'm-1']]);
    expect((await object.read({ issue: true })).topics.map(topic => topic.key).sort()).toEqual(['model request network connection lost ref', 'other issue', 'sync drops files sync']);
    expect((await object.read({ kind: 'status' })).posts.map(entry => entry.text)).toEqual(['Moved the changelog.']);
    expect((await object.read({})).topics).toHaveLength(4);
  });

  it('lists a workspace\'s issues to a person, resolves one through topicAct, and needs session.prompt to post', async () => {
    const projectId = await project();
    await env.PROJECT_CHATTER.getByName(`${env.ACCOUNT_ID}:${projectId}`).post({ projectId, id: 'tooling', topic: 'proc watch failed', kind: 'tooling', text: 'proc watch lost the process', author: { kind: 'workspace', id: 'ws-a', name: 'Parser' }, spot: { tool: 'proc', reference: 'history://ws-a', machine: null } });
    const rpc = await device({ kind: 'project', projectId });
    expect(await rpc('chatter.issues', { projectId, workspaceId: 'ws-a' })).toMatchObject({ status: 'ok', value: { topics: [{ key: 'proc watch failed', state: 'open' }], posts: [{ text: 'proc watch lost the process' }] } });
    expect(await rpc('chatter.topicAct', { projectId, key: 'proc watch failed', action: { kind: 'state', state: 'resolved', fixedIn: 'abc1234' } })).toMatchObject({ status: 'ok', value: { topic: { state: 'resolved', fixedIn: 'abc1234' } } });
    expect(await rpc('chatter.issues', { projectId, workspaceId: 'ws-a' })).toMatchObject({ status: 'ok', value: { topics: [{ key: 'proc watch failed', state: 'resolved' }] } });
    const writer = await device({ kind: 'project', projectId }, ['rpc.read', 'rpc.write']);
    expect(await writer('chatter.post', { projectId, id: 'z', topic: 'a topic', kind: 'status', text: 'hello' })).toMatchObject({ status: 'error' });
  });
});

describe('Chatter digests', () => {
  const workspace = (id: string): ChatterAuthor => ({ kind: 'workspace', id, name: id });
  const named = (id: string) => ({ id, name: id });
  const listener = (id: string, described: Partial<ChatterListener> = {}): ChatterListener => ({ listener: id, name: id, phase: 'code', goal: 'Ship the invoice export.', head: null, stack: [], waitsOn: [], ...described });
  /** Why each post is in a digest or left out of it, by offset. */
  const why = (digest: ChatterDigest) => Object.fromEntries([...digest.heard.map(entry => [entry.offset, entry.reason]), ...digest.left.map(entry => [entry.offset, entry.why])]);
  /** A Decisions model giving each offered topic the bearing named for it, with that probability; any other topic none. */
  const picker = (bearings: Record<string, { choice: string; probability: number }>) => vi.fn<DigestDecide>(async args => {
    const { topics } = z.object({ topics: z.array(z.object({ id: z.string(), topic: z.string() })) }).parse(args.state);
    return { model: 'test/picker', answers: Object.fromEntries(topics.map(entry => {
      const { choice, probability } = bearings[entry.topic] ?? { choice: 'none', probability: 0.9 };
      return [entry.id, { choice, probabilities: { [choice]: probability }, confidence: probability }];
    })) };
  });

  function digests() {
    const { projectId, object } = chatter();
    let posts = 0;
    const say = async (author: ChatterAuthor, topic: string, text: string, kind: ChatterKind = 'status', phase: string | null = 'code') => {
      const posted = await object.post({ projectId, id: `post-${++posts}`, topic, kind, text, author, phase });
      if (posted.status !== 'ok') throw new Error('post refused');
      return posted.value.post.offset;
    };
    /** Runs the digest build once its posts have settled, with `decide` as the Decisions model. */
    const build = async (decide: DigestDecide) => {
      await runInDurableObject(object, instance => { instance.decider = async () => decide; });
      vi.setSystemTime(Date.now() + 3 * 60_000);
      expect(await runDurableObjectAlarm(object)).toBe(true);
    };
    return { projectId, object, say, build };
  }

  it('a turn start hears its floor: its stack\'s head, a workspace it waits on, a mention of it and the project agent; its own posts are left out', async () => {
    const { projectId, object, say } = digests();
    const head = await say(workspace('ws-head'), 'schema change', 'The users table gains a tenant column.');
    const blocker = await say(workspace('ws-auth'), 'auth tokens', 'Tokens now expire after an hour.');
    const mention = await say(workspace('ws-ui'), 'button styles', 'Heads up @ws-billing: the button styles moved.');
    const agent = await say({ kind: 'project', id: projectId, name: 'demo' }, 'priorities', 'Billing ships first this week.', 'status', null);
    const own = await say(workspace('ws-billing'), 'invoice export', 'Started the invoice export.');
    const others: number[] = [];
    for (const topic of ['cache warmup', 'lint config', 'docs build', 'e2e flake', 'font loading']) others.push(await say(workspace('ws-other'), topic, `About ${topic}.`));
    const { digest, posts, others: rest } = await object.hear({ listener: listener('ws-billing', { head: named('ws-head'), waitsOn: [named('ws-auth')] }), after: 0 });
    expect(digest).toMatchObject({ builtAt: null, model: null, muted: false });
    expect(why(digest)).toEqual({
      [head]: 'its stack\'s head', [blocker]: 'it waits on this workspace', [mention]: 'mentions it', [agent]: 'the project agent',
      // No build yet: the newest topics up to the pick limit, and the oldest left to chatter_read.
      [others[0]!]: 'not among the newest topics (no model pick)',
      ...Object.fromEntries(others.slice(1).map(offset => [offset, 'among the newest topics (no model pick)'])),
    });
    expect(why(digest)[own]).toBeUndefined();
    expect(posts.map(post => post.offset)).toEqual([head, blocker, mention, agent, ...others.slice(1)]);
    expect(rest).toBe(1);

    const tooling = await say(workspace('ws-ui'), 'vite crash · bash', 'vite build crashed.', 'tooling');
    const resource = await say(workspace('ws-ui'), 'bigger machine', 'Need 32 GB for the e2e run.', 'resource');
    await say({ kind: 'project', id: projectId, name: 'demo' }, 'bigger machine', 'Moved ws-ui to a 32 GB machine until 18:00.', 'resource', null);
    const project = (await object.hear({ listener: listener('project', { name: 'demo', phase: null }), after: digest.through })).digest;
    expect(why(project)).toEqual({ [tooling]: 'a tooling post: it acts on these', [resource]: 'a resource ask: it acts on these' });
  });

  it('builds each active listener\'s digest after posts settle, one decision per listener, and a turn start reads that row without a model call', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { object, say, build } = digests();
    const billing = listener('ws-billing');
    await object.hear({ listener: billing, after: 0 });
    const sqlite = [await say(workspace('ws-db'), 'SQLite 2 MB cap', 'Writes over 2 MB fail with SQLITE_TOOBIG.'), await say(workspace('ws-db'), 'SQLite 2 MB cap', 'Split the blob into rows.')];
    const lint = await say(workspace('ws-ui'), 'lint config', 'Prettier now runs on save.');
    const decide = picker({ 'SQLite 2 MB cap': { choice: 'problem', probability: 0.9 } });
    await build(decide);
    expect(decide).toHaveBeenCalledTimes(1);
    expect(Object.keys(decide.mock.calls[0]![0].questions)).toHaveLength(2);

    const refuse = vi.fn(async (): Promise<DigestDecide> => { throw new Error('No model call on a turn start'); });
    await runInDurableObject(object, instance => { instance.decider = refuse; });
    const { digest, posts } = await object.hear({ listener: billing, after: 0 });
    expect(refuse).not.toHaveBeenCalled();
    expect(digest).toMatchObject({ builtAt: expect.any(Date), model: 'test/picker' });
    expect(digest.heard).toEqual(sqlite.map(offset => ({ offset, via: 'pick', reason: 'it may hit the same problem', strong: true })));
    expect(digest.left).toEqual([{ offset: lint, why: 'the model passed it over' }]);
    expect(posts.map(post => post.text)).toEqual(['Writes over 2 MB fail with SQLITE_TOOBIG.', 'Split the blob into rows.']);
    expect(await object.hearings(sqlite[0]!)).toEqual({ level: 'normal', heard: [{ listener: 'ws-billing', name: 'ws-billing', via: 'pick', reason: 'it may hit the same problem', strong: true }], missed: [] });
    expect(await object.hearings(lint)).toMatchObject({ heard: [], missed: [{ listener: 'ws-billing', why: 'the model passed it over' }] });

    // A failed decision leaves the floor plus the newest topics.
    const late = await say(workspace('ws-ui'), 'lint config', 'And on commit.');
    await build(async () => { throw new Error('Decisions is unavailable'); });
    expect(await object.digestPreview({ listener: 'ws-billing', name: 'ws-billing' })).toMatchObject({ model: null, heard: [{ offset: late, via: 'pick', reason: 'among the newest topics (no model pick)' }] });
  });

  it('rebuilds a listener in a long run at most every 10 minutes, and builds nothing for one idle past 2 hours', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { object, say, build } = digests();
    await object.hear({ listener: listener('ws-billing'), after: 0 });
    await object.hear({ listener: listener('ws-idle'), after: 0 });
    vi.setSystemTime(Date.now() + 3 * 60 * 60_000);
    await object.hear({ listener: listener('ws-billing'), after: 0 });
    await say(workspace('ws-db'), 'SQLite 2 MB cap', 'Writes over 2 MB fail.');
    const decide = picker({});
    await build(decide);
    expect(decide.mock.calls.map(([args]) => z.object({ listener: z.object({ agent: z.string() }) }).parse(args.state).listener.agent)).toEqual(['the main agent of workspace ws-billing']);
    // No turn start since that build: a post three minutes later waits for the 10-minute mark after it.
    await say(workspace('ws-db'), 'SQLite 2 MB cap', 'Split the blob into rows.');
    await build(decide);
    expect(decide).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 8 * 60_000);
    expect(await runDurableObjectAlarm(object)).toBe(true);
    expect(decide).toHaveBeenCalledTimes(2);
  });

  it('levels shape the digest: a muted author reaches none, mention included; Low only on a strong pick, a Plan workspace starting at Low; High always', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { projectId, object, say, build } = digests();
    await object.setVolume({ projectId, strip: 'ws-quiet', name: 'ws-quiet', phase: 'code', muted: true, author: person });
    await object.setVolume({ projectId, strip: 'ws-low', name: 'ws-low', phase: 'code', level: 'low', author: person });
    await object.setVolume({ projectId, strip: 'ws-loud', name: 'ws-loud', phase: 'code', level: 'high', author: person });
    await object.hear({ listener: listener('ws-billing'), after: 0 });
    const muted = await say(workspace('ws-quiet'), 'invoice ids', '@ws-billing invoice ids are UUIDs now.');
    const loud = await say(workspace('ws-loud'), 'deploy freeze', 'No deploys after 4pm.');
    const low = await say(workspace('ws-low'), 'flaky checkout spec', 'The checkout spec flakes.');
    const planned = await say(workspace('ws-plan'), 'csv streaming idea', 'Thinking of streaming the CSV.', 'discovery', 'plan');
    const normal = await say(workspace('ws-normal'), 'currency rounding', 'Totals round half to even.');
    const weak = { choice: 'depends', probability: 0.6 };
    await build(picker({ 'flaky checkout spec': weak, 'csv streaming idea': weak, 'currency rounding': weak }));
    const { digest } = await object.hear({ listener: listener('ws-billing'), after: null });
    const notStrong = 'Low, and the model\'s pick wasn\'t strong: "it touches what its goal depends on"';
    expect(why(digest)).toEqual({ [muted]: 'its author is muted', [loud]: 'High: every agent hears it', [low]: notStrong, [planned]: notStrong, [normal]: 'it touches what its goal depends on' });

    const again = await say(workspace('ws-low'), 'flaky checkout spec', 'It is the clock: freeze it in the spec.');
    await build(picker({ 'flaky checkout spec': { choice: 'problem', probability: 0.95 } }));
    expect((await object.hear({ listener: listener('ws-billing'), after: digest.through })).digest.heard).toEqual([{ offset: again, via: 'pick', reason: 'it may hit the same problem', strong: true }]);
  });

  it('muting Chatter for the project gives no agent a digest and writes lines into the stream; unmuting resumes', async () => {
    const { projectId, object, say } = digests();
    expect(await object.setVolume({ projectId, strip: 'ws-ui', name: 'UI', phase: 'code', level: 'high', author: person })).toMatchObject({ line: { type: 'volume', strip: 'ws-ui', name: 'UI', level: 'high', from: 'normal', muted: false }, volumes: { strips: [{ strip: 'ws-ui', level: 'high', by: 'Ada' }] } });
    expect(await object.setVolume({ projectId, strip: 'ws-ui', name: 'UI', phase: 'code', level: 'high', author: person })).toMatchObject({ line: null });
    expect(await object.setProjectMute({ projectId, on: true, author: person })).toMatchObject({ line: { type: 'project-mute', on: true }, volumes: { projectMuted: { on: true, by: 'Ada' } } });
    await say(workspace('ws-ui'), 'schema change', '@ws-billing the users table changed.');
    const muted = await object.hear({ listener: listener('ws-billing'), after: 0 });
    expect(muted.digest).toMatchObject({ muted: true, heard: [], left: [] });
    expect(muted.others).toBe(0);
    expect(await object.digestPreview({ listener: 'ws-billing', name: 'ws-billing' })).toMatchObject({ muted: true, heard: [], left: [] });
    await object.setProjectMute({ projectId, on: false, author: person });
    const mention = await say(workspace('ws-ui'), 'schema change', '@ws-billing and the orders table.');
    expect((await object.hear({ listener: listener('ws-billing'), after: muted.digest.through })).digest.heard).toEqual([{ offset: mention, via: 'floor', reason: 'High: every agent hears it', strong: false }]);
    expect((await object.watch({})).events.map(event => event.type)).toEqual(['volume', 'project-mute', 'post', 'project-mute', 'post']);
  });

  it('hears a post once: the next turn starts after what the last one heard, and a conversation that never heard starts at its listener\'s position', async () => {
    const { object, say } = digests();
    const billing = listener('ws-billing', { head: named('ws-head') });
    const first = await say(workspace('ws-head'), 'schema change', 'The users table gains a tenant column.');
    const heard = await object.hear({ listener: billing, after: null });
    expect(heard.digest.heard.map(entry => entry.offset)).toEqual([first]);
    const again = await object.hear({ listener: billing, after: heard.digest.through });
    expect(again).toMatchObject({ digest: { heard: [], left: [] }, posts: [], others: 0 });
    const second = await say(workspace('ws-head'), 'schema change', 'Backfill runs tonight.');
    expect((await object.hear({ listener: billing, after: null })).digest.heard.map(entry => entry.offset)).toEqual([second]);
  });

  it('sets volumes and reads Hear as for a person through the RPC', async () => {
    const projectId = await project();
    const rpc = await device({ kind: 'project', projectId });
    expect(await rpc('chatter.setVolume', { projectId, strip: 'project', level: 'high' })).toMatchObject({ status: 'ok', value: { line: { type: 'volume', strip: 'project', name: 'the project agent', level: 'high', from: 'normal' }, volumes: { strips: [{ strip: 'project', level: 'high', muted: false }] } } });
    expect(await rpc('chatter.setVolume', { projectId, strip: 'ws-elsewhere', muted: true })).toMatchObject({ status: 'error' });
    expect(await rpc('chatter.volumes', { projectId })).toMatchObject({ status: 'ok', value: { strips: [{ strip: 'project', level: 'high' }], projectMuted: null } });
    expect(await rpc('chatter.digestPreview', { projectId, listener: 'project' })).toMatchObject({ status: 'ok', value: { listener: 'project', name: 'the project agent', builtAt: null } });
    const reader = await device({ kind: 'project', projectId }, ['rpc.read']);
    expect(await reader('chatter.setProjectMute', { projectId, on: true })).toMatchObject({ status: 'error' });
  });
});
