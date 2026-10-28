import { env, runDurableObjectAlarm, SELF } from 'cloudflare:test';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { createBrowserClient } from 'result-rpc/client';
import { createDeviceBinding, createSignedRpcFetch, credentialProtocolBase64, signDeviceInvite } from '@gitspace/protocol';
import { gitspaceContract } from '@gitspace/protocol/rpc-contract';
import { createRoutedTransport } from '@gitspace/protocol/routed-transport';
import type { AutomationDraft } from '@gitspace/protocol/automations-contract';
import { ArtifactsCodeStore } from '@gitspace/runtime-workspace-do';
import { archiveCloudWorkspace } from '../src/cloud-workspace-lifecycle.js';
import { ProjectAutomationsDO, automationValue } from '../src/project-automations.js';
import { SpaceAuthorityDO } from '../src/space-authority.js';
import { network } from './network.js';
import { tenantRootPrivateKey } from './setup.js';

const API = 'https://api.github.com';
const WEBHOOK_SECRET = 'webhook-secret-from-github';
const REPOSITORY = { full_name: 'inKibra/pantry', html_url: 'https://github.com/inKibra/pantry' };
const commit = (digit: string) => digit.repeat(40);

afterEach(() => { vi.restoreAllMocks(); });

/** An RSA key as GitHub issues an App's (PKCS#1). */
async function appKey(): Promise<string> {
  const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  if (!('privateKey' in pair)) throw new Error('RSA generation returned no key pair');
  const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey)).subarray(26);
  const label = 'RSA PRIVATE KEY';
  return `-----BEGIN ${label}-----\n${btoa(String.fromCharCode(...der)).replace(/(.{64})/gu, '$1\n')}\n-----END ${label}-----\n`;
}

async function signature(body: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(WEBHOOK_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return `sha256=${[...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)))].map(byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

/** Artifacts is the only service outside the account: refs per repository, forks and branch writes. */
function cloudArtifacts(refs: Map<string, string>): void {
  const repository = (name: string): ArtifactsRepoInfo => ({ id: name, name, description: null, defaultBranch: 'main', createdAt: '', updatedAt: '', lastPushAt: null, source: null, readOnly: false, remote: `https://artifacts.invalid/${name}.git` });
  const ref = (name: string, value: string) => `${name} ${value.startsWith('refs/') ? value : `refs/heads/${value}`}`;
  vi.spyOn(ArtifactsCodeStore.prototype, 'importProject').mockImplementation(async projectId => repository(`project-${projectId}`));
  vi.spyOn(ArtifactsCodeStore.prototype, 'forkWorkspace').mockImplementation(async (_projectId, workspaceId) => repository(`workspace-${workspaceId}`));
  vi.spyOn(ArtifactsCodeStore.prototype, 'resolveRef').mockImplementation(async (name, value) => refs.get(ref(name, value)) ?? null);
  vi.spyOn(ArtifactsCodeStore.prototype, 'resolveAdvertisedRef').mockImplementation(async (name, value) => refs.get(ref(name, value)) ?? null);
  vi.spyOn(ArtifactsCodeStore.prototype, 'setBranch').mockImplementation(async (name, branch, value) => { refs.set(ref(name, branch), value); });
  vi.spyOn(ArtifactsCodeStore.prototype, 'initialCheckpoint').mockImplementation(async (name, workspaceId, branch) => {
    const head = refs.get(ref(name, branch));
    return head ? { checkpointRef: `refs/gitspace/spaces/${workspaceId}/checkpoints`, headCommit: head, branch, indexCommit: head, trackedWorktreeCommit: head, worktreeCommit: head, indexTree: commit('9'), worktreeTree: commit('9') } : null;
  });
}

/**
 * The account's GitHub App installed on inKibra/pantry, a project using that repository, and one workspace on the
 * branch `feature/search`. GitHub answers write access for `writers` only. The automations' workspaces never run an
 * agent: what a run submits or notes is recorded instead.
 */
async function installed(writers: readonly string[]) {
  await env.CREDENTIALS.getByName(env.ACCOUNT_ID).bootstrap({ userId: env.ACCOUNT_ID, rootPublicKey: env.AUTH_PUBLIC_KEY, vaultKey: credentialProtocolBase64.encode(new Uint8Array(32).fill(23)) });
  const pem = await appKey();
  network.use(
    http.post(`${API}/app-manifests/:code/conversions`, () => HttpResponse.json({
      id: 4242, slug: 'gitspace-test', name: 'GitSpace test', html_url: 'https://github.com/apps/gitspace-test',
      owner: { login: 'inKibra', type: 'Organization' }, client_id: 'Iv1.client', client_secret: 'client-secret', webhook_secret: WEBHOOK_SECRET, pem,
    }, { status: 201 })),
    http.get(`${API}/app/installations/91`, () => HttpResponse.json({ id: 91, account: { login: 'inKibra', type: 'Organization' }, repository_selection: 'selected', permissions: { metadata: 'read' }, created_at: '2026-10-17T12:00:00Z' })),
    http.post(`${API}/app/installations/91/access_tokens`, () => HttpResponse.json({ token: 'installation-token-91', expires_at: new Date(Date.now() + 3_600_000).toISOString() }, { status: 201 })),
    http.get(`${API}/installation/repositories`, () => HttpResponse.json({ total_count: 1, repositories: [{ full_name: 'inKibra/pantry' }] })),
    http.get(`${API}/repos/inKibra/pantry/collaborators/:login/permission`, ({ params }) => writers.includes(String(params.login))
      ? HttpResponse.json({ permission: 'write' }) : HttpResponse.json({ message: 'Not Found' }, { status: 404 })),
  );
  const projectId = crypto.randomUUID();
  const authority = env.PROJECT_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${projectId}`);
  const created = await authority.bootstrap({ id: projectId, name: 'Pantry', repositoryReference: 'https://github.com/inKibra/pantry.git', baseBranch: 'main', createdBy: 'user' });
  await env.USER_PROJECTS.getByName(env.ACCOUNT_ID).put(await authority.setProjectLifecycle(created.revision, 'active'));
  const searchId = `search-${crypto.randomUUID()}`;
  await authority.putWorkspace({ id: searchId, projectId, kind: 'worktree', name: 'search-work', branch: 'feature/search', phase: 'code', sourceKind: 'base', sourceRef: 'main', sourceCommit: null, lifecycle: 'active', goalId: null, expectedRevision: 0 });
  const refs = new Map([[`project-${projectId} refs/heads/main`, commit('1')], [`project-${projectId} refs/pull/12/head`, commit('2')]]);
  cloudArtifacts(refs);
  vi.spyOn(SpaceAuthorityDO.prototype, 'runtimeProjectNotice').mockResolvedValue(undefined);
  const submitted = vi.spyOn(SpaceAuthorityDO.prototype, 'runtimeAutomationSubmit').mockResolvedValue({ conversationId: 'root' });
  const noticed = vi.spyOn(SpaceAuthorityDO.prototype, 'runtimeAutomationNotice').mockResolvedValue(undefined);

  const github = env.GITHUB_APP.getByName(env.ACCOUNT_ID);
  const form = await github.startApp({ kind: 'organization', login: 'inKibra' });
  expect((await SELF.fetch(`${env.ACCOUNT_URL}/github/app/created?code=manifest-code&state=${new URL(form.action).searchParams.get('state')}`, { redirect: 'manual' })).status).toBe(303);
  const install = new URL(`${env.ACCOUNT_URL}/github/installed?installation_id=91&setup_action=install&state=${new URL((await github.startInstall()).url).searchParams.get('state')}`);
  expect((await SELF.fetch(install, { redirect: 'manual' })).headers.get('location')).toContain('github=installed');

  const automations = env.PROJECT_AUTOMATIONS.getByName(`${env.ACCOUNT_ID}:${projectId}`);
  const send = async (event: string, payload: Record<string, unknown>): Promise<string> => {
    const deliveryId = crypto.randomUUID();
    const body = JSON.stringify({ ...payload, repository: REPOSITORY, installation: { id: 91 } });
    const response = await SELF.fetch(`${env.ACCOUNT_URL}/github/webhook`, { method: 'POST', body, headers: { 'content-type': 'application/json', 'x-github-event': event, 'x-github-delivery': deliveryId, 'x-hub-signature-256': await signature(body) } });
    expect(response.status).toBe(202);
    return deliveryId;
  };
  /** Runs the queue; the alarm may also have fired on its own. */
  const work = async () => { await runDurableObjectAlarm(automations); };
  const runs = async () => automationValue(await automations.runs({ projectId }));
  return { projectId, searchId, authority, automations, send, work, runs, submitted, noticed };
}

/** A browser enrolled on the account (whose vault `installed` bootstrapped), calling the account's RPC as a person. */
async function signedClient() {
  const vault = env.CREDENTIALS.getByName(env.ACCOUNT_ID);
  await env.USER_SETTINGS.getByName(env.ACCOUNT_ID).setHandle('bootstrap', 0, env.TENANT_ID);
  const browserKey = crypto.getRandomValues(new Uint8Array(32));
  const invite = signDeviceInvite({ version: 1, userId: env.ACCOUNT_ID, inviteId: crypto.randomUUID(), kind: 'browser', label: null, scope: { kind: 'user' }, capabilities: ['rpc.read', 'rpc.write'], canDelegate: false, issuedAt: Date.now(), expiresAt: Date.now() + 60_000, grantTtlMs: null, enrollUrl: 'https://api.gitspace.sh' }, tenantRootPrivateKey);
  const binding = createDeviceBinding({ inviteId: invite.invite.inviteId, deviceId: crypto.randomUUID(), signingPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(browserKey)), label: 'Browser', boundAt: Date.now(), signingPrivateKey: browserKey });
  const enrolled = await vault.enrollDevice({ invite, binding });
  if (enrolled.status !== 'ok') throw new Error(enrolled.error.message);
  return createBrowserClient({ contract: gitspaceContract, transport: createRoutedTransport({
    homeUrl: `https://${env.TENANT_ID}.gitspace.sh/rpc`,
    fetch: createSignedRpcFetch({ deviceId: binding.deviceId, userId: env.ACCOUNT_ID, signingPrivateKey: browserKey, fetch: async (input: RequestInfo | URL, init?: RequestInit) => SELF.fetch(new Request(input, init)) }),
  }) });
}

/** A project on the covered repository that never got the default automations, as one linked before they existed. */
async function linkedBeforeDefaults(): Promise<string> {
  const projectId = crypto.randomUUID();
  const authority = env.PROJECT_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${projectId}`);
  const created = await authority.bootstrap({ id: projectId, name: 'Pantry before A1', repositoryReference: 'git@github.com:inKibra/pantry.git', baseBranch: 'main', createdBy: 'user' });
  await env.USER_PROJECTS.getByName(env.ACCOUNT_ID).put(await authority.setProjectLifecycle(created.revision, 'active'));
  return projectId;
}

const DEFAULT_NAMES = ['Failed checks to its workspace', 'Mentions of @gitspace-test', 'Merged or closed', 'Review feedback to its workspace'];
const defaultsOf = async (projectId: string) => (await env.PROJECT_AUTOMATIONS.getByName(`${env.ACCOUNT_ID}:${projectId}`).list(projectId)).automations.filter(automation => automation.isDefault).map(automation => automation.name);

const pull = (number: number, change: { author: string; base?: string; head: string; draft?: boolean; body?: string }) => ({
  number, title: `Change ${number}`, html_url: `https://github.com/inKibra/pantry/pull/${number}`, body: change.body ?? '', draft: change.draft ?? false, merged: false,
  user: { login: change.author }, base: { ref: change.base ?? 'main' }, head: { ref: change.head }, labels: [],
});

const reviewPullRequests: AutomationDraft = {
  name: 'Review pull requests', enabled: true,
  trigger: { kind: 'github', events: [{ event: 'pull_request', actions: ['opened', 'ready_for_review'] }] },
  conditions: [{ kind: 'baseBranch', mode: 'oneOf', values: ['main'] }, { kind: 'draft', draft: false }],
  action: { kind: 'startWorkspace', mode: 'review', instruction: 'Review {{pull_request.html_url}} against {{pull_request.base.ref}}.' },
};
const startFromLabels: AutomationDraft = {
  name: 'Start work from labels', enabled: true, trigger: { kind: 'label' }, conditions: [],
  action: { kind: 'startWorkspace', mode: null, instruction: 'Work on {{subject.url}}, labeled {{label.name}}.' },
};

describe('automations on GitHub events', () => {
  it('starts a Review workspace for a trusted pull request into main, skips an outsider\'s, and lets a review comment reach the workspace a pull request was opened from', async () => {
    const { projectId, searchId, authority, automations, send, work, runs, submitted } = await installed(['bradleat', 'dana']);
    // Installing the App added the four default automations.
    await vi.waitFor(async () => expect((await automations.list(projectId)).automations.filter(automation => automation.isDefault).map(automation => automation.name)).toEqual(['Failed checks to its workspace', 'Mentions of @gitspace-test', 'Merged or closed', 'Review feedback to its workspace']));
    automationValue(await automations.create({ projectId, draft: reviewPullRequests }));

    await send('pull_request', { action: 'opened', sender: { login: 'bradleat' }, pull_request: pull(12, { author: 'bradleat', head: 'fix-pantry' }) });
    await work();
    const [started] = await runs();
    expect(started).toMatchObject({ automationName: 'Review pull requests', trigger: 'github', event: 'pull_request.opened', subject: { kind: 'pullRequest', number: 12 }, checks: [{ label: '@bradleat has write access', passed: true }, { label: 'base branch is main', passed: true }, { label: 'not a draft', passed: true }] });
    const reviewId = started?.workspaceId ?? '';
    await vi.waitFor(() => expect(submitted).toHaveBeenCalledWith({ projectId, workspaceId: reviewId, requestId: `automation:${started?.id}`, text: expect.stringContaining('Review https://github.com/inKibra/pantry/pull/12 against main.') }));
    expect(await authority.getWorkspace(reviewId)).toMatchObject({ name: 'review-pr-12', branch: 'review-pr-12', phase: 'review', sourceKind: 'pull-request', sourceRef: '12', sourceCommit: commit('2'), lifecycle: 'active' });

    // An outsider's pull request matches nothing, and the run history says why.
    await send('pull_request', { action: 'opened', sender: { login: 'outside-dev' }, pull_request: pull(13, { author: 'outside-dev', head: 'patch-1' }) });
    const [outsider] = await runs();
    expect(outsider).toMatchObject({ subject: { number: 13 }, state: 'skipped', outcome: 'Skipped: author not trusted (@outside-dev)', workspaceId: null, checks: [{ label: '@outside-dev has no write access and is not on the trust list', passed: false }, { passed: null }, { passed: null }] });

    // A pull request from a workspace's branch links to that workspace, so no Review workspace starts for it ...
    await send('pull_request', { action: 'opened', sender: { login: 'bradleat' }, pull_request: pull(14, { author: 'bradleat', head: 'feature/search', body: 'Fixes #7' }) });
    expect((await runs())[0]).toMatchObject({ subject: { number: 14 }, state: 'skipped', outcome: 'Skipped: PR #14 already has workspace search-work' });
    // ... and a person's review comment on it wakes that workspace's agent.
    await send('pull_request_review_comment', { action: 'created', sender: { login: 'dana' }, pull_request: pull(14, { author: 'bradleat', head: 'feature/search' }), comment: { html_url: 'https://github.com/inKibra/pantry/pull/14#discussion_r1', body: 'Please handle empty queries.', user: { login: 'dana' }, path: 'src/search.ts' } });
    const [feedback] = await runs();
    expect(feedback).toMatchObject({ automationName: 'Review feedback to its workspace', outcome: null, workspaceId: searchId });
    await work();
    await vi.waitFor(() => expect(submitted).toHaveBeenCalledWith({ projectId, workspaceId: searchId, requestId: `automation:${feedback?.id}`, text: expect.stringContaining('Please handle empty queries.') }));

    const { links } = await automations.list(projectId);
    expect(links.map(link => [link.subject.kind, link.subject.number, link.workspaceId, link.source])).toEqual(expect.arrayContaining([
      ['pullRequest', 12, reviewId, 'started'], ['pullRequest', 14, searchId, 'branch'], ['issue', 7, searchId, 'closes'],
    ]));
  });

  it('starts a Plan workspace when gitspace:plan is added to an issue', async () => {
    const { projectId, authority, automations, send, work, runs, submitted } = await installed(['bradleat']);
    automationValue(await automations.create({ projectId, draft: startFromLabels }));
    // A second automation starting work on the same delivery finds the subject's workspace already starting.
    automationValue(await automations.create({ projectId, draft: { name: 'Triage labeled issues', enabled: true, trigger: { kind: 'github', events: [{ event: 'issues', actions: ['labeled'] }] }, conditions: [], action: { kind: 'startWorkspace', mode: 'code', instruction: 'Triage it.' } } }));
    await send('issues', { action: 'labeled', sender: { login: 'bradleat' }, label: { name: 'gitspace:plan' }, issue: { number: 7, title: 'Pantry search is slow', html_url: 'https://github.com/inKibra/pantry/issues/7', body: 'Searching takes seconds.', user: { login: 'outside-dev' }, labels: [{ name: 'gitspace:plan' }] } });
    await work();
    const [triage, run] = await runs();
    expect(run).toMatchObject({ trigger: 'label', event: 'issues.labeled', checks: [{ label: '@bradleat has write access', passed: true }] });
    expect(triage).toMatchObject({ automationName: 'Triage labeled issues', state: 'skipped', outcome: 'Skipped: Issue #7 already has workspace plan-issue-7 starting' });
    await vi.waitFor(() => expect(submitted).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: run?.workspaceId, text: expect.stringContaining('Work on https://github.com/inKibra/pantry/issues/7, labeled gitspace:plan.') })));
    expect(await authority.getWorkspace(run?.workspaceId ?? '')).toMatchObject({ name: 'plan-issue-7', phase: 'plan', sourceKind: 'base', sourceCommit: commit('1') });
    expect((await runs())[1]?.timeline.map(entry => entry.label)).toEqual(expect.arrayContaining(['Started workspace plan-issue-7 in Plan', 'Linked to Issue #7']));
    expect((await automations.list(projectId)).links).toMatchObject([{ subject: { kind: 'issue', number: 7, title: 'Pantry search is slow' }, workspaceId: run?.workspaceId, source: 'started', detail: 'Start work from labels · gitspace:plan' }]);
  });

  it('runs an outsider\'s events once they are on the trust list, sends a mention without a linked workspace to the project agent, and closes with a notice that wakes no agent', async () => {
    const { projectId, searchId, automations, send, work, runs, submitted, noticed } = await installed(['bradleat']);
    await vi.waitFor(async () => expect((await automations.list(projectId)).automations).toHaveLength(4));
    const comment = (body: string, login: string) => ({ action: 'created', sender: { login }, issue: { number: 30, title: 'Question', html_url: 'https://github.com/inKibra/pantry/issues/30', user: { login }, labels: [] }, comment: { html_url: 'https://github.com/inKibra/pantry/issues/30#issuecomment-1', body, user: { login } } });

    await send('issue_comment', comment('@gitspace-test can you look?', 'mira'));
    expect((await runs())[0]).toMatchObject({ automationName: 'Mentions of @gitspace-test', outcome: 'Skipped: author not trusted (@mira)' });
    await automations.updateSettings({ projectId, settings: { concurrency: 2, dailyRunCap: 50, trusted: ['@mira'] } });
    await send('issue_comment', comment('@gitspace-test can you look?', 'mira'));
    const [mention] = await runs();
    expect(mention).toMatchObject({ outcome: null, workspaceId: projectId, checks: [{ label: '@mira is on the trust list', passed: true }, { label: 'it mentions @gitspace-test', passed: true }] });
    await work();
    await vi.waitFor(() => expect(submitted).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: projectId, text: expect.stringContaining('@gitspace-test can you look?') })));
    // A comment that does not mention the bot is skipped by its condition.
    await send('issue_comment', comment('Thanks!', 'mira'));
    expect((await runs())[0]).toMatchObject({ state: 'skipped', outcome: 'Skipped: it does not mention @gitspace-test' });

    await send('pull_request', { action: 'opened', sender: { login: 'bradleat' }, pull_request: pull(14, { author: 'bradleat', head: 'feature/search' }) });
    await send('pull_request', { action: 'closed', sender: { login: 'bradleat' }, pull_request: { ...pull(14, { author: 'bradleat', head: 'feature/search' }), merged: true } });
    const [closed] = await runs();
    expect(closed).toMatchObject({ automationName: 'Merged or closed', workspaceId: searchId });
    await work();
    await vi.waitFor(async () => expect((await runs())[0]).toMatchObject({ id: closed?.id, state: 'finished', outcome: 'Notice added; the agent stays asleep' }));
    expect(noticed).toHaveBeenCalledWith({ projectId, workspaceId: searchId, requestId: `automation:${closed?.id}`, text: expect.stringContaining('PR #14 · Change 14 merged by @bradleat') });
    expect(submitted).not.toHaveBeenCalledWith(expect.objectContaining({ workspaceId: searchId }));
  });

  it('sends one delivery to a linked workspace once, however many automations match it', async () => {
    const { projectId, searchId, automations, send, runs } = await installed(['bradleat', 'dana']);
    await vi.waitFor(async () => expect((await automations.list(projectId)).automations).toHaveLength(4));
    await send('pull_request', { action: 'opened', sender: { login: 'bradleat' }, pull_request: pull(14, { author: 'bradleat', head: 'feature/search' }) });
    await send('pull_request_review_comment', { action: 'created', sender: { login: 'dana' }, pull_request: pull(14, { author: 'bradleat', head: 'feature/search' }), comment: { html_url: 'https://github.com/inKibra/pantry/pull/14#discussion_r2', body: '@gitspace-test this breaks paging.', user: { login: 'dana' } } });
    const [later, first] = await runs();
    expect(first).toMatchObject({ automationName: 'Mentions of @gitspace-test', outcome: null, workspaceId: searchId });
    expect(later).toMatchObject({ automationName: 'Review feedback to its workspace', state: 'skipped', outcome: 'Skipped: already sent to search-work by Mentions of @gitspace-test' });
  });

  it('tests a draft against a recorded delivery without acting, and Run it acts on that delivery once', async () => {
    const { projectId, automations, send, runs } = await installed(['bradleat']);
    const outsider = await send('pull_request', { action: 'opened', sender: { login: 'outside-dev' }, pull_request: pull(13, { author: 'outside-dev', head: 'patch-1' }) });
    const draft = await send('pull_request', { action: 'opened', sender: { login: 'bradleat' }, pull_request: pull(15, { author: 'bradleat', head: 'wip', draft: true }) });
    const ready = await send('pull_request', { action: 'ready_for_review', sender: { login: 'bradleat' }, pull_request: pull(15, { author: 'bradleat', head: 'wip' }) });
    expect(await automations.recordedEvents({ projectId, limit: 10 })).toMatchObject([
      { deliveryId: ready, event: 'pull_request.ready_for_review', label: 'PR #15 · Change 15 ready_for_review by @bradleat' },
      { deliveryId: draft, event: 'pull_request.opened' },
      { deliveryId: outsider, event: 'pull_request.opened' },
    ]);
    const test = (deliveryId: string) => automations.testDraft({ projectId, draft: reviewPullRequests, requestedBy: 'Brad', deliveryId });
    expect(automationValue(await test(outsider))).toMatchObject({ results: [{ result: 'Skipped: author not trusted (@outside-dev)', runs: false }], checks: [{ passed: false }, { passed: null }, { passed: null }] });
    expect(automationValue(await test(draft))).toMatchObject({ results: [{ result: 'Skipped: the pull request is a draft', runs: false }], checks: [{ passed: true }, { passed: true }, { label: 'not a draft', passed: false }] });
    expect(automationValue(await test(ready))).toMatchObject({ results: [{ result: 'Would start workspace review-pr-15 in Review, linked to PR #15', runs: true }], instruction: 'Review https://github.com/inKibra/pantry/pull/15 against main.' });
    expect(await runs()).toEqual([]);

    const saved = automationValue(await automations.create({ projectId, draft: reviewPullRequests }));
    const run = automationValue(await automations.runOnEvent({ projectId, automationId: saved.id, deliveryId: ready, requestedBy: 'Brad' }));
    expect(run).toMatchObject({ outcome: null, subject: { number: 15 } });
    expect(run.timeline.slice(0, 4).map(entry => entry.label)).toEqual([expect.stringMatching(/^Run it by Brad on a delivery received /u), '@bradleat has write access', 'Conditions passed', 'Queued']);
    expect(await automations.runOnEvent({ projectId, automationId: saved.id, deliveryId: crypto.randomUUID(), requestedBy: 'Brad' })).toMatchObject({ status: 'error', failure: { kind: 'invalid', field: 'deliveryId' } });
  });

  it('reopens a closed linked workspace before sending to it, and keeps a person\'s link over one found by branch', async () => {
    const { projectId, searchId, authority, automations, send, work, runs, submitted } = await installed(['bradleat', 'dana']);
    await vi.waitFor(async () => expect((await automations.list(projectId)).automations).toHaveLength(4));
    automationValue(await automations.create({ projectId, draft: reviewPullRequests }));
    await send('pull_request', { action: 'opened', sender: { login: 'bradleat' }, pull_request: pull(12, { author: 'bradleat', head: 'fix-pantry' }) });
    await work();
    const [review] = await runs();
    const reviewId = review?.workspaceId ?? '';
    await vi.waitFor(() => expect(submitted).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: reviewId })));
    // Each turn ends as its workspace reports, freeing its slot.
    await automations.runTurnChanged({ projectId, workspaceId: reviewId, requestId: `automation:${review?.id}`, state: 'ended', outcome: 'finished', text: 'Reviewed.' });
    const placement = await env.SPACE_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${reviewId}`).get();
    expect(await archiveCloudWorkspace(env, env.ACCOUNT_ID, { projectId, spaceId: reviewId, expectedGeneration: placement?.generation ?? null })).toMatchObject({ lifecycle: 'archived' });

    const reviewComment = (number: number, head: string, body: string) => ({ action: 'created', sender: { login: 'dana' }, pull_request: pull(number, { author: 'bradleat', head }), comment: { html_url: `https://github.com/inKibra/pantry/pull/${number}#discussion_r3`, body, user: { login: 'dana' } } });
    await send('pull_request_review_comment', reviewComment(12, 'fix-pantry', 'One more case.'));
    await work();
    await vi.waitFor(() => expect(submitted).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: reviewId, text: expect.stringContaining('One more case.') })));
    expect(await authority.getWorkspace(reviewId)).toMatchObject({ lifecycle: 'active' });
    const [reopened] = await runs();
    expect(reopened?.timeline.map(entry => entry.label)).toContain('Reopened review-pr-12');
    await automations.runTurnChanged({ projectId, workspaceId: reviewId, requestId: `automation:${reopened?.id}`, state: 'ended', outcome: 'finished', text: 'Handled.' });

    // A person links PR #14 to the review workspace; its branch, which is another workspace's, does not take it back.
    automationValue(await automations.link({ projectId, subject: { kind: 'pullRequest', number: 14 }, workspaceId: reviewId, source: 'person', detail: 'Brad' }));
    await send('pull_request', { action: 'synchronize', sender: { login: 'bradleat' }, pull_request: pull(14, { author: 'bradleat', head: 'feature/search' }) });
    await send('pull_request_review_comment', reviewComment(14, 'feature/search', 'Rename this.'));
    await work();
    await vi.waitFor(() => expect(submitted).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: reviewId, text: expect.stringContaining('Rename this.') })));
    expect(submitted).not.toHaveBeenCalledWith(expect.objectContaining({ workspaceId: searchId }));
    expect((await automations.list(projectId)).links.find(link => link.subject.number === 14)).toMatchObject({ workspaceId: reviewId, source: 'person', detail: 'Brad' });
  });

  it('gives a project the App covered before the defaults existed its defaults once, on the automations overview', async () => {
    const { projectId: installedId } = await installed([]);
    await vi.waitFor(async () => expect(await defaultsOf(installedId)).toEqual(DEFAULT_NAMES));
    const earlier = await linkedBeforeDefaults();
    expect(await defaultsOf(earlier)).toEqual([]);
    const added = vi.spyOn(ProjectAutomationsDO.prototype, 'addDefaults');
    const client = await signedClient();
    const overview = await client.automations.overview({});
    expect(overview).toMatchObject({ status: 'ok', value: { projects: expect.arrayContaining([expect.objectContaining({ projectId: earlier, total: 4, on: 4 })]) } });
    expect(await defaultsOf(earlier)).toEqual(DEFAULT_NAMES);
    // Later overviews open no project's automations for it again.
    expect(await client.automations.overview({})).toMatchObject({ status: 'ok' });
    expect(added.mock.calls.filter(([input]) => input.projectId === earlier)).toHaveLength(1);
  });

  it('does not bring back a default a person deleted', async () => {
    const { send } = await installed([]);
    const earlier = await linkedBeforeDefaults();
    // Its first delivery gave it the defaults; the App has not recorded that.
    await send('issues', { action: 'opened', sender: { login: 'bradleat' }, issue: { number: 3, title: 'A question', html_url: 'https://github.com/inKibra/pantry/issues/3', user: { login: 'bradleat' }, labels: [] } });
    expect(await defaultsOf(earlier)).toEqual(DEFAULT_NAMES);
    const automations = env.PROJECT_AUTOMATIONS.getByName(`${env.ACCOUNT_ID}:${earlier}`);
    const closed = (await automations.list(earlier)).automations.find(automation => automation.name === 'Merged or closed');
    automationValue(await automations.delete({ projectId: earlier, automationId: closed?.id ?? '' }));
    expect(await (await signedClient()).automations.overview({})).toMatchObject({ status: 'ok' });
    expect(await defaultsOf(earlier)).toEqual(DEFAULT_NAMES.filter(name => name !== 'Merged or closed'));
  });

  it('gives a project created under an existing installation its defaults', async () => {
    await installed([]);
    const created = await (await signedClient()).project.create({ name: 'Pantry again', baseBranch: 'main', repositoryUrl: 'https://github.com/inKibra/pantry' });
    if (created.status === 'error') throw created.error;
    expect(await defaultsOf(created.value.project.id)).toEqual(DEFAULT_NAMES);
  });

  it('refuses conditions the trigger does not offer and a start without a mode outside a label trigger', async () => {
    const { projectId, automations } = await installed([]);
    const refused = (change: Partial<AutomationDraft>) => automations.create({ projectId, draft: { ...reviewPullRequests, ...change } });
    expect(await refused({ conditions: [{ kind: 'conclusion', values: ['failure'] }] })).toMatchObject({ status: 'error', failure: { field: 'conditions' } });
    expect(await refused({ action: { kind: 'startWorkspace', mode: null, instruction: 'Review it.' } })).toMatchObject({ status: 'error', failure: { field: 'action.mode' } });
    expect(await refused({ trigger: { kind: 'github', events: [{ event: 'pull_request', actions: ['opened'] }, { event: 'issues', actions: ['opened'] }] } })).toMatchObject({ status: 'error', failure: { field: 'conditions' } });
    expect(await refused({ trigger: { kind: 'manual' }, conditions: [] })).toMatchObject({ status: 'error', failure: { field: 'action.kind' } });
  });
});
