import { env, runDurableObjectAlarm, runInDurableObject, SELF } from 'cloudflare:test';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { createBrowserClient } from 'result-rpc/client';
import { createDeviceBinding, createSignedRpcFetch, credentialProtocolBase64, signDeviceInvite } from '@gitspace/protocol';
import { gitspaceContract } from '@gitspace/protocol/rpc-contract';
import { createRoutedTransport } from '@gitspace/protocol/routed-transport';
import { automationEventCount, parseAutomationMessage, type AutomationDraft } from '@gitspace/protocol/automations-contract';
import { z } from 'zod';
import { ArtifactsCodeStore } from '@gitspace/runtime-workspace-do';
import { archiveCloudWorkspace, completedOperation } from '../src/cloud-workspace-lifecycle.js';
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
 * agent: what a run submits, updates or notes is recorded instead.
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
  const updated = vi.spyOn(SpaceAuthorityDO.prototype, 'runtimeAutomationUpdate').mockResolvedValue(true);
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
  /** Runs the queue with every waiting batch due, as 90 s without another event makes it; the alarm may also have fired
   * on its own. */
  const work = async () => {
    await runInDurableObject(automations, (_instance, state) => { state.storage.sql.exec("UPDATE automation_runs SET deliver_at=0 WHERE state='queued' AND deliver_at IS NOT NULL"); });
    await runDurableObjectAlarm(automations);
  };
  const runs = async () => automationValue(await automations.runs({ projectId }));
  return { projectId, searchId, authority, automations, send, work, runs, submitted, updated, noticed };
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
/** A review comment on a line of `src/search.ts` in PR #14, part of review `review`. */
const lineComment = (id: number, body: string, login: string, review: number) => ({
  action: 'created', sender: { login }, pull_request: pull(14, { author: 'jules', head: 'feature/search' }),
  comment: { html_url: `https://github.com/inKibra/pantry/pull/14#discussion_r${id}`, body, user: { login }, path: 'src/search.ts', line: id, pull_request_review_id: review },
});
const submittedReview = (id: number, body: string, login: string, state: string) => ({
  action: 'submitted', sender: { login }, pull_request: pull(14, { author: 'jules', head: 'feature/search' }),
  review: { id, html_url: `https://github.com/inKibra/pantry/pull/14#pullrequestreview-${id}`, body, state, user: { login } },
});
/** What a run submitted: its message's text. */
const submittedText = (call: readonly unknown[] | undefined) => z.object({ text: z.string() }).parse(call?.[0]).text;

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
    // Installing the App added the default automations.
    await vi.waitFor(async () => expect((await automations.list(projectId)).automations.filter(automation => automation.isDefault).map(automation => automation.name)).toEqual(DEFAULT_NAMES));
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
    expect((await runs())[1]?.timeline.map(entry => entry.label)).toEqual(expect.arrayContaining(['Started workspace plan-issue-7 in Plan with model role Default', 'Linked to Issue #7']));
    expect((await automations.list(projectId)).links).toMatchObject([{ subject: { kind: 'issue', number: 7, title: 'Pantry search is slow' }, workspaceId: run?.workspaceId, source: 'started', detail: 'Start work from labels · gitspace:plan' }]);
  });

  it('starts a workspace whose first run uses the automation\'s model role, refuses a role the profile does not offer, and fails a run whose role the profile dropped since', async () => {
    const { projectId, authority, automations, send, work, runs, submitted } = await installed(['bradleat']);
    const vault = env.CREDENTIALS.getByName(env.ACCOUNT_ID);
    const { profiles, assignments } = await vault.ensureInference();
    const profileId = assignments.find(assignment => assignment.projectId === projectId)?.profileId ?? '';
    const original = profiles.find(profile => profile.id === profileId);
    if (!original) throw new Error('The project has no inference profile');
    const withReviewer = await vault.updateInferenceProfile({ profileId, name: original.name, settings: { ...original.settings, 'modelRoles.reviewer': 'openai/gpt-5' }, expectedRevision: original.revision });
    if (withReviewer.status !== 'ok') throw new Error('The profile did not take the reviewer role');
    const review = (role: string): AutomationDraft => ({ ...reviewPullRequests, action: { kind: 'startWorkspace', mode: 'review', role, instruction: 'Review {{pull_request.html_url}}.' } });

    expect(await automations.create({ projectId, draft: review('critic') })).toMatchObject({ status: 'error', failure: { kind: 'invalid', field: 'action.role', message: 'critic is not a model role of this project\'s inference profile; it offers default, deep, fast, taste, reviewer' } });
    automationValue(await automations.create({ projectId, draft: review('reviewer') }));
    expect((await automations.list(projectId)).modelRoles).toEqual(['default', 'deep', 'fast', 'taste', 'reviewer']);

    await send('pull_request', { action: 'opened', sender: { login: 'bradleat' }, pull_request: pull(12, { author: 'bradleat', head: 'fix-pantry' }) });
    await work();
    const [started] = await runs();
    await vi.waitFor(() => expect(submitted).toHaveBeenCalledWith({ projectId, workspaceId: started?.workspaceId, requestId: `automation:${started?.id}`, text: expect.stringContaining('Review https://github.com/inKibra/pantry/pull/12.'), role: 'reviewer' }));
    expect((await runs())[0]?.timeline.map(entry => entry.label)).toContain('Started workspace review-pr-12 in Review with model role reviewer');

    const { 'modelRoles.reviewer': _reviewer, ...withoutReviewer } = withReviewer.value.profiles.find(profile => profile.id === profileId)?.settings ?? {};
    const revision = withReviewer.value.profiles.find(profile => profile.id === profileId)?.revision ?? 0;
    expect(await vault.updateInferenceProfile({ profileId, name: original.name, settings: withoutReviewer, expectedRevision: revision })).toMatchObject({ status: 'ok' });
    await send('pull_request', { action: 'opened', sender: { login: 'bradleat' }, pull_request: pull(13, { author: 'bradleat', head: 'fix-shelves' }) });
    await work();
    const [dropped] = await runs();
    expect(dropped).toMatchObject({ subject: { number: 13 }, state: 'failed', outcome: 'Failed: model role reviewer is no longer in the project\'s inference profile; it offers default, deep, fast, taste' });
    expect(await authority.getWorkspace(dropped?.workspaceId ?? '')).toBeNull();
    expect(submitted).toHaveBeenCalledTimes(1);
  });

  it('runs an outsider\'s events once they are on the trust list, sends a mention without a linked workspace to the project agent, and closes with a notice that wakes no agent', async () => {
    const { projectId, searchId, automations, send, work, runs, submitted, noticed } = await installed(['bradleat']);
    await vi.waitFor(async () => expect((await automations.list(projectId)).automations).toHaveLength(DEFAULT_NAMES.length));
    const comment = (body: string, login: string) => ({ action: 'created', sender: { login }, issue: { number: 30, title: 'Question', html_url: 'https://github.com/inKibra/pantry/issues/30', user: { login }, labels: [] }, comment: { html_url: 'https://github.com/inKibra/pantry/issues/30#issuecomment-1', body, user: { login } } });
    const mentions = async () => (await runs()).filter(run => run.automationName === 'Mentions of @gitspace-test');

    await send('issue_comment', comment('@gitspace-test can you look?', 'mira'));
    expect((await mentions())[0]).toMatchObject({ outcome: 'Skipped: author not trusted (@mira)' });
    await automations.updateSettings({ projectId, settings: { concurrency: 2, dailyRunCap: 50, trusted: ['@mira'] } });
    await send('issue_comment', comment('@gitspace-test can you look?', 'mira'));
    const [mention] = await mentions();
    expect(mention).toMatchObject({ outcome: null, workspaceId: projectId, checks: [{ label: '@mira is on the trust list', passed: true }, { label: 'it mentions @gitspace-test', passed: true }] });
    await work();
    await vi.waitFor(() => expect(submitted).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: projectId, text: expect.stringContaining('@gitspace-test can you look?') })));
    // A comment that does not mention the bot is skipped by its condition.
    await send('issue_comment', comment('Thanks!', 'mira'));
    expect((await mentions())[0]).toMatchObject({ state: 'skipped', outcome: 'Skipped: it does not mention @gitspace-test' });

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
    await vi.waitFor(async () => expect((await automations.list(projectId)).automations).toHaveLength(DEFAULT_NAMES.length));
    await send('pull_request', { action: 'opened', sender: { login: 'bradleat' }, pull_request: pull(14, { author: 'bradleat', head: 'feature/search' }) });
    await send('pull_request_review_comment', { action: 'created', sender: { login: 'dana' }, pull_request: pull(14, { author: 'bradleat', head: 'feature/search' }), comment: { html_url: 'https://github.com/inKibra/pantry/pull/14#discussion_r2', body: '@gitspace-test this breaks paging.', user: { login: 'dana' } } });
    const [later, first] = await runs();
    expect(first).toMatchObject({ automationName: 'Mentions of @gitspace-test', outcome: null, workspaceId: searchId });
    expect(later).toMatchObject({ automationName: 'Review feedback to its workspace', state: 'skipped', outcome: 'Skipped: already sent to search-work by Mentions of @gitspace-test' });
  });

  it('never delivers what the person\'s own GitHub login posted, whichever automation would send it to a workspace', async () => {
    const { projectId, searchId, automations, send, runs } = await installed(['jules', 'dana']);
    await vi.waitFor(async () => expect((await automations.list(projectId)).automations).toHaveLength(DEFAULT_NAMES.length));
    expect((await env.GITHUB_APP.getByName(env.ACCOUNT_ID).setPerson('@jules')).person).toEqual({ login: 'jules', source: 'settings' });
    automationValue(await automations.create({ projectId, draft: { name: 'Comments to search', enabled: true, trigger: { kind: 'github', events: [{ event: 'issue_comment', actions: ['created'] }] }, conditions: [], action: { kind: 'messageWorkspace', workspaceId: searchId, instruction: 'Read it.' } } }));
    await send('pull_request', { action: 'opened', sender: { login: 'jules' }, pull_request: pull(14, { author: 'jules', head: 'feature/search' }) });

    // An agent's thread reply posted with gh as the person: its empty review and its comment.
    await send('pull_request_review', submittedReview(501, '', 'jules', 'commented'));
    await send('pull_request_review_comment', lineComment(601, 'Done: empty queries return no results.', 'jules', 501));
    await send('issue_comment', { action: 'created', sender: { login: 'jules' }, issue: { number: 14, title: 'Change 14', html_url: 'https://github.com/inKibra/pantry/pull/14', user: { login: 'jules' }, labels: [], pull_request: {} }, comment: { html_url: 'https://github.com/inKibra/pantry/pull/14#issuecomment-9', body: 'Pushed the fix.', user: { login: 'jules' } } });
    const recorded = await runs();
    expect(recorded.filter(run => run.state !== 'skipped')).toEqual([]);
    expect(recorded.map(run => [run.automationName, run.event, run.outcome])).toEqual(expect.arrayContaining([
      ['Review feedback to its workspace', 'pull_request_review.submitted', 'Skipped: posted from your account while agents post as you'],
      ['Review feedback to its workspace', 'pull_request_review_comment.created', 'Skipped: posted from your account while agents post as you'],
      ['Comments to search', 'issue_comment.created', 'Skipped: posted from your account while agents post as you'],
    ]));
    expect(recorded.find(run => run.automationName === 'Comments to search')?.checks[0]).toEqual({ label: '@jules is your GitHub account, and agents post as you', passed: false });

    // Another person's comment still reaches the workspace.
    await send('pull_request_review_comment', lineComment(602, 'Please also cover null.', 'dana', 502));
    expect((await runs())[0]).toMatchObject({ automationName: 'Review feedback to its workspace', state: 'queued', workspaceId: searchId, outcome: null });
  });

  it('collects a review\'s comments into one run and one message once the pull request goes quiet, folding the empty review that wraps them', async () => {
    const { projectId, searchId, automations, send, work, runs, submitted } = await installed(['jules', 'dana']);
    await vi.waitFor(async () => expect((await automations.list(projectId)).automations).toHaveLength(DEFAULT_NAMES.length));
    await send('pull_request', { action: 'opened', sender: { login: 'jules' }, pull_request: pull(14, { author: 'jules', head: 'feature/search' }) });
    await send('pull_request_review_comment', lineComment(701, 'Handle empty queries.', 'dana', 700));
    await send('pull_request_review_comment', lineComment(702, 'Name this searchTerm.', 'dana', 700));
    await send('pull_request_review_comment', lineComment(703, 'Add a test for paging.', 'dana', 700));
    await send('pull_request_review', submittedReview(700, '', 'dana', 'commented'));
    await send('pull_request_review', submittedReview(705, 'Close; three things to fix.', 'dana', 'changes_requested'));
    const [batch, ...others] = (await runs()).filter(run => run.automationName === 'Review feedback to its workspace');
    expect(others).toEqual([]);
    expect(batch).toMatchObject({ state: 'queued', workspaceId: searchId });
    expect(batch?.events.map(event => [event.event, event.folded])).toEqual([
      ['pull_request_review_comment.created', false], ['pull_request_review_comment.created', false], ['pull_request_review_comment.created', false],
      ['pull_request_review.submitted', true], ['pull_request_review.submitted', false],
    ]);
    // Until 90 s pass without another event, nothing is delivered.
    await runDurableObjectAlarm(automations);
    expect(submitted).not.toHaveBeenCalled();

    await work();
    await vi.waitFor(() => expect(submitted).toHaveBeenCalledTimes(1));
    expect(submitted).toHaveBeenCalledWith(expect.objectContaining({ projectId, workspaceId: searchId, requestId: `automation:${batch?.id}` }));
    const message = parseAutomationMessage(submittedText(submitted.mock.calls[0]));
    expect(message).toMatchObject({ run: batch?.id, name: 'Review feedback to its workspace', source: 'github', subject: 'PR #14' });
    expect(message?.events.map(event => [event.kind, event.author, event.path, event.line, event.text])).toEqual([
      ['comment', 'dana', 'src/search.ts', 701, 'Handle empty queries.'], ['comment', 'dana', 'src/search.ts', 702, 'Name this searchTerm.'], ['comment', 'dana', 'src/search.ts', 703, 'Add a test for paging.'],
      ['review', 'dana', null, null, 'Close; three things to fix.'],
    ]);
    expect(automationEventCount(message?.events ?? [])).toBe('3 comments, 1 review');

    // Run again delivers the whole batch at once, as one message.
    await automations.runTurnChanged({ projectId, workspaceId: searchId, requestId: `automation:${batch?.id}`, state: 'ended', outcome: 'finished', text: 'Fixed all three.' });
    const again = automationValue(await automations.retryRun({ projectId, runId: batch?.id ?? '', requestedBy: 'Robin' }));
    expect(again).toMatchObject({ outcome: null, events: batch?.events });
    await runDurableObjectAlarm(automations);
    await vi.waitFor(() => expect(submitted).toHaveBeenCalledTimes(2));
    expect(parseAutomationMessage(submittedText(submitted.mock.calls[1]))?.events).toEqual(message?.events);
  });

  it('adds events that arrive while the workspace\'s turn runs to its waiting message, and opens a new batch once that message was placed', async () => {
    const { projectId, searchId, automations, send, work, runs, submitted, updated } = await installed(['jules', 'dana']);
    await vi.waitFor(async () => expect((await automations.list(projectId)).automations).toHaveLength(DEFAULT_NAMES.length));
    await send('pull_request', { action: 'opened', sender: { login: 'jules' }, pull_request: pull(14, { author: 'jules', head: 'feature/search' }) });
    const feedback = async () => (await runs()).filter(run => run.automationName === 'Review feedback to its workspace');
    await send('pull_request_review_comment', lineComment(801, 'Handle empty queries.', 'dana', 800));
    await work();
    await vi.waitFor(() => expect(submitted).toHaveBeenCalledTimes(1));
    const [waiting] = await feedback();

    // The agent is mid-turn, so the message waits in the workspace: the next comment joins it there.
    await send('pull_request_review_comment', lineComment(802, 'And null queries.', 'dana', 810));
    expect(updated).toHaveBeenCalledTimes(1);
    expect(updated).toHaveBeenCalledWith({ projectId, workspaceId: searchId, requestId: `automation:${waiting?.id}`, text: expect.any(String) });
    expect(parseAutomationMessage(submittedText(updated.mock.calls[0]))?.events.map(event => event.text)).toEqual(['Handle empty queries.', 'And null queries.']);
    expect(await feedback()).toMatchObject([{ id: waiting?.id, state: 'running', events: [{ event: 'pull_request_review_comment.created' }, { event: 'pull_request_review_comment.created' }] }]);
    expect(submitted).toHaveBeenCalledTimes(1);

    // The workspace placed the message meanwhile: it no longer changes, so the event opens a new batch.
    updated.mockResolvedValueOnce(false);
    await send('pull_request_review_comment', lineComment(803, 'One more thing.', 'dana', 820));
    const [opened, earlier] = await feedback();
    expect(earlier).toMatchObject({ id: waiting?.id, events: [{}, {}] });
    expect(opened).toMatchObject({ state: 'queued', events: [{ label: expect.stringContaining('Review comment from @dana') }] });

    // Once its turn started, the workspace is not asked to change it.
    await automations.runTurnChanged({ projectId, workspaceId: searchId, requestId: `automation:${waiting?.id}`, state: 'running' });
    await send('pull_request_review_comment', lineComment(804, 'Last one.', 'dana', 830));
    expect(updated).toHaveBeenCalledTimes(2);
    expect((await feedback())[0]).toMatchObject({ id: opened?.id, events: [{}, {}] });
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
    expect(automationValue(await test(ready))).toMatchObject({ results: [{ result: 'Would start workspace review-pr-15 in Review with model role Default, linked to PR #15', runs: true }], instruction: 'Review https://github.com/inKibra/pantry/pull/15 against main.' });
    expect(await runs()).toEqual([]);

    const saved = automationValue(await automations.create({ projectId, draft: reviewPullRequests }));
    const run = automationValue(await automations.runOnEvent({ projectId, automationId: saved.id, deliveryId: ready, requestedBy: 'Brad' }));
    expect(run).toMatchObject({ outcome: null, subject: { number: 15 } });
    expect(run.timeline.slice(0, 4).map(entry => entry.label)).toEqual([expect.stringMatching(/^Run it by Brad on a delivery received /u), '@bradleat has write access', 'Conditions passed', 'Queued']);
    expect(await automations.runOnEvent({ projectId, automationId: saved.id, deliveryId: crypto.randomUUID(), requestedBy: 'Brad' })).toMatchObject({ status: 'error', failure: { kind: 'invalid', field: 'deliveryId' } });
  });

  it('reopens a closed linked workspace before sending to it, and keeps a person\'s link over one found by branch', async () => {
    const { projectId, searchId, authority, automations, send, work, runs, submitted } = await installed(['bradleat', 'dana']);
    await vi.waitFor(async () => expect((await automations.list(projectId)).automations).toHaveLength(DEFAULT_NAMES.length));
    automationValue(await automations.create({ projectId, draft: reviewPullRequests }));
    await send('pull_request', { action: 'opened', sender: { login: 'bradleat' }, pull_request: pull(12, { author: 'bradleat', head: 'fix-pantry' }) });
    await work();
    const [review] = await runs();
    const reviewId = review?.workspaceId ?? '';
    await vi.waitFor(() => expect(submitted).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: reviewId })));
    // Each turn ends as its workspace reports, freeing its slot.
    await automations.runTurnChanged({ projectId, workspaceId: reviewId, requestId: `automation:${review?.id}`, state: 'ended', outcome: 'finished', text: 'Reviewed.' });
    const placement = await env.SPACE_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${reviewId}`).get();
    await completedOperation(env, await archiveCloudWorkspace(env, env.ACCOUNT_ID, { projectId, spaceId: reviewId, expectedGeneration: placement?.generation ?? null }));
    expect(await env.PROJECT_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${projectId}`).getWorkspace(reviewId)).toMatchObject({ lifecycle: 'archived' });

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

  it('keeps a linked pull request\'s state and checks current: read when it is linked, again on its check suites\' and its own deliveries', async () => {
    const { projectId, searchId, automations, send } = await installed(['bradleat']);
    const head = commit('7');
    const onGitHub: { state: 'open' | 'closed'; merged: boolean; runs: Array<{ status: string; conclusion: string | null }>; statuses: Array<{ state: string }> } = {
      state: 'open', merged: false, runs: [{ status: 'completed', conclusion: 'failure' }, { status: 'in_progress', conclusion: null }], statuses: [{ state: 'success' }],
    };
    network.use(
      http.get(`${API}/repos/inKibra/pantry/pulls/14`, () => HttpResponse.json({ state: onGitHub.state, draft: false, merged: onGitHub.merged, title: 'Search ranking', html_url: 'https://github.com/inKibra/pantry/pull/14', head: { sha: head } })),
      http.get(`${API}/repos/inKibra/pantry/commits/${head}/check-runs`, () => HttpResponse.json({ check_runs: onGitHub.runs })),
      http.get(`${API}/repos/inKibra/pantry/commits/${head}/status`, () => HttpResponse.json({ statuses: onGitHub.statuses })),
    );
    const linked = async () => (await automations.list(projectId)).links.find(link => link.subject.number === 14);
    automationValue(await automations.link({ projectId, subject: { kind: 'pullRequest', number: 14 }, workspaceId: searchId, source: 'person', detail: 'Brad' }));
    expect(await linked()).toMatchObject({ subject: { title: 'Search ranking' }, pullRequest: { state: 'open', checks: 'failing' } });
    // A rerun is under way, then passes: each check suite's delivery reads the checks again.
    onGitHub.runs = [{ status: 'completed', conclusion: 'success' }, { status: 'in_progress', conclusion: null }];
    const suite = { action: 'completed', sender: { login: 'github' }, check_suite: { conclusion: 'success', head_branch: 'feature/search', head_sha: head, pull_requests: [{ number: 14, head: { ref: 'feature/search' }, base: { ref: 'main' } }] } };
    await send('check_suite', suite);
    await vi.waitFor(async () => expect((await linked())?.pullRequest).toMatchObject({ state: 'open', checks: 'pending' }));
    onGitHub.runs = [{ status: 'completed', conclusion: 'success' }, { status: 'completed', conclusion: 'skipped' }];
    await send('check_suite', suite);
    await vi.waitFor(async () => expect((await linked())?.pullRequest).toMatchObject({ state: 'open', checks: 'passing' }));
    // It merges: its own delivery reads it merged, and the board says so.
    onGitHub.state = 'closed';
    onGitHub.merged = true;
    await send('pull_request', { action: 'closed', sender: { login: 'bradleat' }, pull_request: { ...pull(14, { author: 'bradleat', head: 'feature/search' }), state: 'closed', merged: true } });
    await vi.waitFor(async () => expect((await linked())?.pullRequest).toMatchObject({ state: 'merged' }));
    expect(await automations.pullRequestLinks(projectId)).toEqual([{ workspaceId: searchId, number: 14, state: expect.objectContaining({ state: 'merged', checks: 'passing' }) }]);
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

  it('brings each default no person changed to its current definition and deletes a retired one, leaving a changed default as the person left it', async () => {
    const { projectId, automations } = await installed([]);
    await vi.waitFor(async () => expect(await defaultsOf(projectId)).toEqual(DEFAULT_NAMES));
    const named = async (name: string) => (await automations.list(projectId)).automations.find(entry => entry.name === name);
    const closed = await named('Merged or closed');
    automationValue(await automations.update({ projectId, automationId: closed?.id ?? '', draft: { name: 'Merged or closed', enabled: true, trigger: closed?.trigger ?? { kind: 'manual' }, conditions: closed?.conditions ?? [], action: { kind: 'sendToLinked', wake: false, orProjectAgent: false, instruction: 'Close the workspace too.' } } }));
    // As the defaults were at revision 2: review feedback left out bots and comments, and bots had their own default.
    automationValue(await automations.create({ projectId, draft: { name: 'Bot review feedback to its workspace', enabled: true, trigger: { kind: 'github', events: [{ event: 'pull_request_review', actions: ['submitted'] }] }, conditions: [{ kind: 'people', mode: 'none', values: [] }], action: { kind: 'sendToLinked', wake: true, orProjectAgent: false, instruction: 'Read the bots.' } } }));
    await runInDurableObject(automations, (_instance, state) => {
      state.storage.sql.exec("UPDATE automations SET default_key='bot-review-feedback' WHERE name='Bot review feedback to its workspace'");
      state.storage.sql.exec("UPDATE automations SET trigger_json=?, conditions_json=? WHERE default_key='review-feedback'",
        JSON.stringify({ kind: 'github', events: [{ event: 'pull_request_review', actions: ['submitted'] }, { event: 'pull_request_review_comment', actions: ['created'] }] }),
        JSON.stringify([{ kind: 'linked', linked: true }, { kind: 'bots', mode: 'none', values: [] }]));
    });
    await runInDurableObject(env.GITHUB_APP.getByName(env.ACCOUNT_ID), (_instance, state) => { state.storage.sql.exec('UPDATE automation_defaults SET revision=2'); });
    const added = vi.spyOn(ProjectAutomationsDO.prototype, 'addDefaults');
    const client = await signedClient();
    expect(await client.automations.overview({})).toMatchObject({ status: 'ok' });
    expect(await defaultsOf(projectId)).toEqual(DEFAULT_NAMES);
    expect(await named('Review feedback to its workspace')).toMatchObject({
      revision: 1, conditions: [{ kind: 'linked', linked: true }, { kind: 'pullRequest', pullRequest: true }],
      trigger: { kind: 'github', events: [{ event: 'pull_request_review' }, { event: 'pull_request_review_comment' }, { event: 'issue_comment', actions: ['created'] }] },
    });
    expect((await named('Merged or closed'))?.action).toMatchObject({ instruction: 'Close the workspace too.' });
    expect(await client.automations.overview({})).toMatchObject({ status: 'ok' });
    expect(added.mock.calls.filter(([input]) => input.projectId === projectId)).toHaveLength(1);
  });

  it('sends review bots\' and people\'s feedback on a linked pull request to its workspace, never the account App\'s own, nor a comment on a linked issue', async () => {
    const { projectId, searchId, send, work, runs, submitted } = await installed(['jules', 'dana']);
    await send('pull_request', { action: 'opened', sender: { login: 'jules' }, pull_request: pull(14, { author: 'jules', head: 'feature/search', body: 'Fixes #7' }) });
    /** A comment on the conversation of PR #14, or of issue #7, which the pull request closes. */
    const comment = (number: number, body: string, login: string) => ({
      action: 'created', sender: { login },
      issue: { number, title: `Item ${number}`, html_url: `${REPOSITORY.html_url}/issues/${number}`, user: { login: 'jules' }, labels: [], ...(number === 14 ? { pull_request: {} } : {}) },
      comment: { html_url: `${REPOSITORY.html_url}/issues/${number}#issuecomment-${body.length}`, body, user: { login } },
    });
    await send('pull_request_review_comment', lineComment(1, 'Empty queries throw.', 'coderabbitai[bot]', 100));
    await send('issue_comment', comment(14, 'Codex: the cache never expires.', 'chatgpt-codex-connector[bot]'));
    await send('issue_comment', comment(14, 'Fixed in 9bd59bf.', 'gitspace-test[bot]'));
    await send('issue_comment', comment(7, 'Still seeing this on 2.1.', 'dana'));
    const runsNow = (await runs()).filter(run => run.automationName === 'Review feedback to its workspace');
    expect(runsNow.filter(run => run.subject?.number === 14 && run.state === 'queued')).toEqual([expect.objectContaining({ workspaceId: searchId })]);
    expect(runsNow).toEqual(expect.arrayContaining([
      expect.objectContaining({ subject: expect.objectContaining({ number: 14 }), state: 'skipped', outcome: 'Skipped: posted by this account\'s GitHub App, which agents post as' }),
      expect.objectContaining({ subject: expect.objectContaining({ number: 7 }), state: 'skipped', outcome: expect.stringContaining('on an issue') }),
    ]));
    await work();
    await vi.waitFor(() => expect(submitted).toHaveBeenCalledWith(expect.objectContaining({ projectId, workspaceId: searchId, text: expect.stringContaining('Empty queries throw.') })));
    const text = submitted.mock.calls.map(([input]) => input.text).join('\n');
    expect(text).toContain('Codex: the cache never expires.');
    expect(text).not.toContain('Fixed in 9bd59bf.');
    expect(text).not.toContain('Still seeing this on 2.1.');
  });

  it('checks people and bots apart: a bot left out is skipped while people pass, and naming one bot passes it and every person', async () => {
    const { projectId, automations, send, runs } = await installed(['dana']);
    const comment = (number: number, login: string) => ({
      action: 'created', sender: { login },
      issue: { number, title: `Item ${number}`, html_url: `${REPOSITORY.html_url}/issues/${number}`, user: { login: 'dana' }, labels: [] },
      comment: { html_url: `${REPOSITORY.html_url}/issues/${number}#issuecomment-${number}`, body: `From ${login}.`, user: { login } },
    });
    const trigger: AutomationDraft['trigger'] = { kind: 'github', events: [{ event: 'issue_comment', actions: ['created'] }] };
    const action: AutomationDraft['action'] = { kind: 'messageProjectAgent', instruction: 'Read {{comment.html_url}}.' };
    automationValue(await automations.create({ projectId, draft: { name: 'Not GitHub Actions', enabled: true, trigger, conditions: [{ kind: 'bots', mode: 'noneOf', values: ['github-actions[bot]'] }], action } }));
    automationValue(await automations.create({ projectId, draft: { name: 'Only CodeRabbit', enabled: true, trigger, conditions: [{ kind: 'bots', mode: 'oneOf', values: ['coderabbitai[bot]'] }], action } }));
    await send('issue_comment', comment(1, 'github-actions[bot]'));
    await send('issue_comment', comment(2, 'coderabbitai[bot]'));
    await send('issue_comment', comment(3, 'dana'));
    const recorded = await runs();
    expect(['Not GitHub Actions', 'Only CodeRabbit'].map(name => recorded.filter(run => run.automationName === name).map(run => [run.subject?.number, run.state === 'skipped' ? run.outcome : 'runs']).sort())).toEqual([
      [[1, 'Skipped: the author is github-actions[bot]'], [2, 'runs'], [3, 'runs']],
      [[1, 'Skipped: the author is github-actions[bot]'], [2, 'runs'], [3, 'runs']],
    ]);
    expect(recorded.find(run => run.automationName === 'Not GitHub Actions' && run.subject?.number === 1)?.checks.at(-1)).toEqual({ label: 'bots: not github-actions[bot]', passed: false });
  });

  it('suggests the people and bots who wrote the recorded events of the chosen kinds, newest first, with how many each wrote', async () => {
    const { projectId, send } = await installed(['dana', 'jules']);
    const comment = (login: string) => ({
      action: 'created', sender: { login },
      issue: { number: 7, title: 'Item 7', html_url: `${REPOSITORY.html_url}/issues/7`, user: { login: 'dana' }, labels: [] },
      comment: { html_url: `${REPOSITORY.html_url}/issues/7#issuecomment-${login.length}`, body: 'Noted.', user: { login } },
    });
    await send('issue_comment', comment('coderabbitai[bot]'));
    await send('issue_comment', comment('dana'));
    await send('pull_request', { action: 'opened', sender: { login: 'jules' }, pull_request: pull(12, { author: 'jules', head: 'fix-pantry' }) });
    await send('issue_comment', comment('coderabbitai[bot]'));
    await send('pull_request_review', submittedReview(5, 'Looks fine.', 'chatgpt-codex-connector[bot]', 'commented'));
    const authors = await (await signedClient()).automations.authors({ projectId, events: ['issue_comment', 'pull_request_review'] });
    expect(authors).toEqual({ status: 'ok', value: {
      people: [{ login: 'dana', count: 1, lastSeenAt: expect.any(Date) }],
      bots: [{ login: 'chatgpt-codex-connector[bot]', count: 1, lastSeenAt: expect.any(Date) }, { login: 'coderabbitai[bot]', count: 2, lastSeenAt: expect.any(Date) }],
    } });
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

describe('watch automations', () => {
  const release = (repository: string, tag: string, prerelease = false) => ({
    tag_name: tag, name: tag, html_url: `https://github.com/${repository}/releases/tag/${tag}`, body: `Notes for ${tag}`,
    published_at: '2026-10-29T00:00:00Z', prerelease, draft: false, author: { login: 'bradleat' },
  });
  /** Makes every watch of `automations` due and wakes it; the check itself runs in the alarm. */
  const checkNow = (automations: DurableObjectStub<ProjectAutomationsDO>) => runInDurableObject(automations, async (_instance, state) => {
    state.storage.sql.exec('UPDATE automation_watches SET next_check_at=0');
    await state.storage.setAlarm(Date.now());
  });

  it('runs once on each release published after it was set up, whether a check or the webhook sees it first, and never on what came before', async () => {
    const { projectId, searchId, automations, send, work, runs, submitted } = await installed(['bradleat']);
    let published = [release('inKibra/pantry', 'v1.0.0')];
    let checks = 0;
    network.use(http.get(`${API}/repos/inKibra/pantry/releases`, () => { checks += 1; return HttpResponse.json(published); }));
    automationValue(await automations.create({ projectId, draft: {
      name: 'Releases', enabled: true, trigger: { kind: 'watch', repository: 'inKibra/pantry', on: 'release', every: 'hourly' },
      conditions: [{ kind: 'prerelease', prerelease: false }], action: { kind: 'messageWorkspace', workspaceId: searchId, instruction: 'Upgrade to {{release.tag}}.' },
    } }));
    const watched = async () => (await runs()).filter(run => run.automationName === 'Releases');
    // The first check records what was already published.
    await vi.waitFor(async () => { await work(); expect(checks).toBe(1); });
    expect(await watched()).toEqual([]);

    // The webhook sees v1.1.0 first; the check after it finds nothing new.
    published = [release('inKibra/pantry', 'v1.1.0'), ...published];
    await send('release', { action: 'published', sender: { login: 'bradleat' }, release: release('inKibra/pantry', 'v1.1.0') });
    await checkNow(automations);
    await vi.waitFor(async () => { await work(); expect(checks).toBe(2); });
    expect((await watched()).map(run => run.event)).toEqual(['release.published']);

    // A check sees a prerelease and v1.2.0 first, oldest first; the webhook after it changes nothing.
    published = [release('inKibra/pantry', 'v1.2.0'), release('inKibra/pantry', 'v1.2.0-rc.1', true), ...published];
    await checkNow(automations);
    await vi.waitFor(async () => { await work(); expect(checks).toBe(3); });
    await send('release', { action: 'published', sender: { login: 'bradleat' }, release: release('inKibra/pantry', 'v1.2.0') });
    const [stable, candidate, first] = await watched();
    expect(await watched()).toHaveLength(3);
    expect(candidate).toMatchObject({ state: 'skipped' });
    expect(first).toMatchObject({ state: expect.not.stringMatching(/^skipped$/u) });
    await work();
    await vi.waitFor(() => expect(submitted).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: searchId, requestId: `automation:${stable?.id}`, text: expect.stringContaining('Upgrade to v1.2.0.') })));
    expect(submitted).not.toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('Upgrade to v1.0.0.') }));
  });

  it('lets a release of another repository reach only the watch naming it, never the project\'s GitHub automations', async () => {
    const { projectId, automations, work, runs } = await installed(['bradleat']);
    let checks = 0;
    network.use(http.get(`${API}/repos/earendil-works/pi/releases`, () => { checks += 1; return HttpResponse.json([]); }));
    automationValue(await automations.create({ projectId, draft: reviewPullRequests }));
    automationValue(await automations.create({ projectId, draft: { name: 'Every push', enabled: true, trigger: { kind: 'github', events: [{ event: 'push', actions: [] }] }, conditions: [], action: { kind: 'messageProjectAgent', instruction: 'Pushed {{ref}}.' } } }));
    automationValue(await automations.create({ projectId, draft: {
      name: 'Pi releases', enabled: true, trigger: { kind: 'watch', repository: 'earendil-works/pi', on: 'release', every: 'daily' },
      conditions: [], action: { kind: 'messageProjectAgent', instruction: 'Pi {{release.tag}} is out.' },
    } }));
    await vi.waitFor(async () => { await work(); expect(checks).toBe(1); });
    const deliver = async (event: string, payload: Record<string, unknown>) => {
      const body = JSON.stringify({ ...payload, repository: { full_name: 'earendil-works/pi', html_url: 'https://github.com/earendil-works/pi' }, installation: { id: 91 } });
      const response = await SELF.fetch(`${env.ACCOUNT_URL}/github/webhook`, { method: 'POST', body, headers: { 'content-type': 'application/json', 'x-github-event': event, 'x-github-delivery': crypto.randomUUID(), 'x-hub-signature-256': await signature(body) } });
      expect(response.status).toBe(202);
    };
    await deliver('pull_request', { action: 'opened', sender: { login: 'bradleat' }, pull_request: pull(3, { author: 'bradleat', head: 'fix' }) });
    // A tag push reaches every project, as watches of tags read it; the project's own push automation is not for it.
    await deliver('push', { ref: 'refs/tags/v1.4.0', after: commit('f'), before: commit('0'), deleted: false, created: true, compare: '', sender: { login: 'bradleat' }, head_commit: null, commits: [] });
    await deliver('release', { action: 'published', sender: { login: 'bradleat' }, release: release('earendil-works/pi', 'v1.4.0') });
    expect((await runs()).map(run => [run.automationName, run.event])).toEqual([['Pi releases', 'release.published']]);
  });

  it('follows the upstream parent\'s releases when the project\'s repository is a fork', async () => {
    const { projectId, automations, work, runs } = await installed(['bradleat']);
    let upstreamChecks = 0;
    network.use(
      http.get(`${API}/repos/inKibra/pantry`, () => HttpResponse.json({ fork: true, parent: { full_name: 'upstream-org/pantry' } })),
      http.get(`${API}/repos/upstream-org/pantry/releases`, () => { upstreamChecks += 1; return HttpResponse.json([]); }),
    );
    automationValue(await automations.create({ projectId, draft: {
      name: 'Upstream releases', enabled: true, trigger: { kind: 'watch', repository: null, on: 'release', every: 'daily' },
      conditions: [{ kind: 'tag', mode: 'oneOf', values: ['v*'] }], action: { kind: 'messageProjectAgent', instruction: 'Merge {{release.tag}} of {{repository.full_name}}.' },
    } }));
    await vi.waitFor(async () => { await work(); expect(upstreamChecks).toBe(1); });
    const body = JSON.stringify({ action: 'published', sender: { login: 'maintainer' }, release: release('upstream-org/pantry', 'v2.0.0'), repository: { full_name: 'upstream-org/pantry', html_url: 'https://github.com/upstream-org/pantry' }, installation: { id: 91 } });
    expect((await SELF.fetch(`${env.ACCOUNT_URL}/github/webhook`, { method: 'POST', body, headers: { 'content-type': 'application/json', 'x-github-event': 'release', 'x-github-delivery': crypto.randomUUID(), 'x-hub-signature-256': await signature(body) } })).status).toBe(202);
    expect((await runs()).map(run => [run.automationName, run.event])).toEqual([['Upstream releases', 'release.published']]);
  });
});
