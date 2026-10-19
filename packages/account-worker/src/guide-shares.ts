import { z } from 'zod';
import { githubRepositoryOf } from '@gitspace/protocol/github';
import { sharedGuideSchema, type SharedGuideDenied } from '@gitspace/protocol/inspector-contract';
import type { GuideShareView } from '@gitspace/protocol/rpc-contract';
import { readInspectorContext, type InspectorCloudContext } from './account-inspector-data.js';
import { cloudMergeBase, cloudRepositoryDiff, withPinnedCloudCheckout } from './cloud-repository.js';
import { base64url, GitHubApiError, githubRequest } from './github-api.js';
import type { ProjectAuthorityDO } from './project-authority.js';

/** A stored share holds its guide; SQLite rows stay well under their 2 MB limit. */
export const GUIDE_SHARE_MAX_BYTES = 1_500_000;
const READER_COOKIE = '__Host-gitspace-guide-reader';
const SIGN_IN_COOKIE = '__Host-gitspace-guide-sign-in';
const SIGN_IN_SECONDS = 600;
const SHARE_ROUTE = /^\/v1\/shared-guides\/([^/]+)\/([A-Za-z0-9_-]{43})(\/diff|\/sign-in)?$/u;
const SHARE_PAGE = /^\/shared-guides\/[^/]+\/[A-Za-z0-9_-]{43}$/u;
const NO_STORE = { 'cache-control': 'private, no-store', 'referrer-policy': 'no-referrer', 'x-robots-tag': 'noindex, nofollow, noarchive', 'x-content-type-options': 'nosniff' };

/** One revision of a workspace's Change Guide, shared read-only. `github`: readers sign in and must be able to read the repository. */
export const guideShareRecordSchema = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  workspaceId: z.string().min(1),
  access: z.enum(['public', 'github']),
  guideRevision: z.number().int().min(0),
  guide: sharedGuideSchema,
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime().nullable(),
}).strict();
export type GuideShareRecord = z.infer<typeof guideShareRecordSchema>;

export function guideShareView(projectId: string, record: GuideShareRecord): GuideShareView {
  return {
    id: record.token, url: `/shared-guides/${encodeURIComponent(projectId)}/${record.token}`, access: record.access,
    repository: record.guide.repository, guideRevision: record.guideRevision, headCommit: record.guide.headCommit,
    createdAt: record.createdAt, expiresAt: record.expiresAt,
  };
}

/** Pins the workspace's current Change Guide, with the merge base its diffs compare against, behind a new link. Anyone
 * with the link reads a public repository's guide; a private one's readers sign in with GitHub. */
export async function createGuideShare(env: Env, source: InspectorCloudContext, expiresAt: string | null): Promise<GuideShareView> {
  if (expiresAt !== null && !(Date.parse(expiresAt) > Date.now())) throw new Error('Choose an expiry in the future');
  const guide = await source.context.getChangeGuide(source.identity);
  if (!guide) throw new Error('This workspace has no Change Guide to share');
  const repository = source.project.repositoryReference === null ? null : githubRepositoryOf(source.project.repositoryReference);
  if (!repository) throw new Error('Only a Change Guide for a GitHub repository can be shared');
  const [isPublic, baseCommit] = await Promise.all([
    env.GITHUB_APP.getByName(env.ACCOUNT_ID).repositoryIsPublic(repository),
    cloudMergeBase(env, source, guide.headCommit, guide.baseRef),
  ]);
  const record = await source.authority.createGuideShare({
    token: base64url(crypto.getRandomValues(new Uint8Array(32))), workspaceId: source.workspace.id,
    access: isPublic ? 'public' : 'github', guideRevision: guide.revision,
    guide: {
      repository, title: guide.title, baseRef: guide.baseRef, baseCommit, headCommit: guide.headCommit,
      sections: guide.sections, sharedAt: new Date().toISOString(),
    },
    createdAt: new Date().toISOString(), expiresAt: expiresAt === null ? null : new Date(expiresAt).toISOString(),
  });
  return guideShareView(source.project.id, record);
}

function cookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const separator = part.indexOf('=');
    if (separator > 0 && part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return null;
}

/** Null when the signed-in reader can read `repository` on GitHub. */
async function readerDenied(request: Request, env: Env, repository: string, sharePath: string): Promise<SharedGuideDenied | null> {
  const sealed = cookie(request, READER_COOKIE);
  const reader = sealed ? await env.CREDENTIALS.getByName(env.ACCOUNT_ID).openGitHubReader(sealed) : null;
  const signIn = `/v1${sharePath}/sign-in`;
  if (!reader) return { denied: 'sign-in', repository, signIn, login: null };
  try {
    await githubRequest(`/repos/${repository}`, { token: reader.token, schema: z.object({ id: z.number() }) });
    return null;
  } catch (error) {
    if (!(error instanceof GitHubApiError)) throw error;
    // GitHub hides a repository the reader cannot see; a revoked or expired token must sign in again.
    if (error.status === 401) return { denied: 'sign-in', repository, signIn, login: null };
    if (error.status === 403 || error.status === 404) return { denied: 'no-access', repository, signIn, login: reader.login };
    throw error;
  }
}

/**
 * The public reader API behind `/shared-guides/<project>/<token>`: the pinned guide, one exhibit's diff, and the start of
 * GitHub sign-in for a private repository's guide. Every answer rechecks the link, so revoking or expiry takes effect at once.
 */
export async function serveGuideShare(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== 'GET') return new Response('Method not allowed', { status: 405, headers: { ...NO_STORE, allow: 'GET' } });
  const match = SHARE_ROUTE.exec(url.pathname);
  if (!match) return new Response('Not found', { status: 404, headers: NO_STORE });
  const projectId = decodeURIComponent(match[1]!);
  const token = match[2]!;
  const authority = (env.PROJECT_AUTHORITY as DurableObjectNamespace<ProjectAuthorityDO>).getByName(`${env.ACCOUNT_ID}:${projectId}`);
  const record = await authority.getGuideShare(token);
  if (!record) return Response.json({ error: 'This link expired or was revoked' }, { status: 404, headers: NO_STORE });
  const sharePath = `/shared-guides/${match[1]}/${token}`;
  if (match[3] === '/sign-in') {
    const state = base64url(crypto.getRandomValues(new Uint8Array(32)));
    const authorize = new URL('https://github.com/login/oauth/authorize');
    authorize.searchParams.set('client_id', await env.GITHUB_APP.getByName(env.ACCOUNT_ID).readerClientId());
    authorize.searchParams.set('redirect_uri', new URL('/github/callback', env.ACCOUNT_URL).href);
    authorize.searchParams.set('state', state);
    const headers = new Headers({ ...NO_STORE, location: authorize.href });
    headers.append('set-cookie', `${SIGN_IN_COOKIE}=${state}.${encodeURIComponent(sharePath)}; Max-Age=${SIGN_IN_SECONDS}; Path=/; HttpOnly; Secure; SameSite=Lax`);
    return new Response(null, { status: 303, headers });
  }
  if (record.access === 'github') {
    const denied = await readerDenied(request, env, record.guide.repository, sharePath);
    if (denied) return Response.json(denied, { status: denied.denied === 'sign-in' ? 401 : 403, headers: NO_STORE });
  }
  if (match[3] === undefined) return Response.json(record.guide, { headers: NO_STORE });
  const path = url.searchParams.get('path');
  if (!path || !record.guide.sections.some(section => section.exhibits.some(exhibit => exhibit.path === path))) {
    return Response.json({ error: 'This file is not part of the shared guide' }, { status: 404, headers: NO_STORE });
  }
  try {
    const source = await readInspectorContext(env, env.ACCOUNT_ID, record.workspaceId, projectId);
    const diff = await withPinnedCloudCheckout(env, source, record.guide.baseCommit, record.guide.headCommit,
      checkout => cloudRepositoryDiff(env, env.ACCOUNT_ID, checkout, 'base', path));
    if (!await authority.getGuideShare(token)) return Response.json({ error: 'This link expired or was revoked' }, { status: 404, headers: NO_STORE });
    return Response.json(diff, { headers: NO_STORE });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 502, headers: NO_STORE });
  }
}

/** GitHub's return from a reader's sign-in: the code becomes a sealed reader cookie, and the reader goes back to the guide. */
export async function completeGuideReaderSignIn(request: Request, env: Env, url: URL): Promise<Response> {
  const saved = cookie(request, SIGN_IN_COOKIE) ?? '';
  const separator = saved.indexOf('.');
  const state = url.searchParams.get('state');
  const code = url.searchParams.get('code');
  const sharePath = separator > 0 ? decodeURIComponent(saved.slice(separator + 1)) : '';
  if (!state || !code || saved.slice(0, separator) !== state || !SHARE_PAGE.test(sharePath)) {
    return new Response('This sign-in expired. Open the shared link again.', { status: 400, headers: NO_STORE });
  }
  let reader: { sealed: string; expiresAt: number };
  try {
    reader = await env.CREDENTIALS.getByName(env.ACCOUNT_ID).sealGitHubReader(
      await env.GITHUB_APP.getByName(env.ACCOUNT_ID).readerClientId(), code, new URL('/github/callback', env.ACCOUNT_URL).href,
    );
  } catch (error) {
    return new Response(error instanceof Error ? error.message : String(error), { status: 400, headers: NO_STORE });
  }
  const headers = new Headers({ ...NO_STORE, location: new URL(sharePath, env.ACCOUNT_URL).href });
  headers.append('set-cookie', `${SIGN_IN_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`);
  headers.append('set-cookie', `${READER_COOKIE}=${reader.sealed}; Max-Age=${Math.floor((reader.expiresAt - Date.now()) / 1000)}; Path=/; HttpOnly; Secure; SameSite=Lax`);
  return new Response(null, { status: 303, headers });
}
