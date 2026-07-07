/**
 * Managed artifacts tier handlers (Tier 2, docs/ARTIFACTS-FS.md).
 *
 * The worker is a provisioning/token layer in front of the CF Artifacts git
 * hosting upstream plus an R2 bucket for the LFS-style blob split (CF git
 * hosting has no native LFS). Long-lived upstream credentials never leave
 * the worker — clients only receive short-lived repo-scoped tokens (<= 1h).
 *
 * Authorization reuses the existing subdomain ownership model: a project is
 * `handle/slug` where `handle` is a root subdomain. The subdomain owner and
 * any collaborator granted in `subdomain_access` (keyed by machine identity
 * public key, i.e. the token's device fingerprint) may provision, mint
 * tokens, and read/write blobs.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from '../types';
import type { AuthContext } from '../middleware/auth';
import { createUpstreamArtifactsHost } from '../services/artifacts-upstream';

const app = new Hono<{ Bindings: Env; Variables: AuthContext }>();

const SLUG_REGEX = /^[a-z0-9][a-z0-9-]{0,62}$/;
const HANDLE_REGEX = /^[a-z0-9][a-z0-9-]{1,18}[a-z0-9]$/;
const OID_REGEX = /^[a-f0-9]{64}$/;
const MAX_BLOB_BYTES = 512 * 1024 * 1024; // 512 MB per blob
const TOKEN_TTL_SECONDS = 3600; // hard cap: scoped tokens live at most 1h

interface ArtifactProjectRecord {
  id: string;
  handle: string;
  slug: string;
  owner_user_id: string;
  upstream_repo_id: string;
  upstream_git_url: string;
}

let artifactsSchemaReady: Promise<void> | null = null;

async function ensureArtifactsSchema(env: Env): Promise<void> {
  if (!artifactsSchemaReady) {
    artifactsSchemaReady = (async () => {
      await env.DB.prepare(
        `
        CREATE TABLE IF NOT EXISTS artifact_projects (
          id TEXT PRIMARY KEY,
          handle TEXT NOT NULL,
          slug TEXT NOT NULL,
          owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          upstream_repo_id TEXT NOT NULL,
          upstream_git_url TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(handle, slug)
        )
      `,
      ).run();
      await env.DB.prepare(
        'CREATE INDEX IF NOT EXISTS idx_artifact_projects_owner ON artifact_projects(owner_user_id)',
      ).run();
    })();
  }

  await artifactsSchemaReady;
}

app.use('*', async (c, next) => {
  await ensureArtifactsSchema(c.env);
  await next();
});

function parseProjectRef(value: string | undefined): { handle: string; slug: string } | null {
  if (!value) {
    return null;
  }
  const parts = value.split('/');
  if (parts.length !== 2) {
    return null;
  }
  const [handle, slug] = parts as [string, string];
  if (!HANDLE_REGEX.test(handle) || !SLUG_REGEX.test(slug)) {
    return null;
  }
  return { handle, slug };
}

function getArtifactsGitBase(env: Env): string {
  return (env.ARTIFACTS_GIT_BASE ?? 'https://artifacts.gitspace.sh').replace(/\/$/, '');
}

function buildGitUrl(env: Env, handle: string, slug: string): string {
  return `${getArtifactsGitBase(env)}/${handle}/${slug}.git`;
}

type AccessCheck =
  | { ok: true; ownerUserId: string }
  | { ok: false; status: 403 | 404; error: string };

/**
 * Authorize the caller for a handle: subdomain owner, or collaborator with
 * a subdomain_access grant matching the caller's machine identity pubkey.
 */
async function checkHandleAccess(
  c: Context<{ Bindings: Env; Variables: AuthContext }>,
  handle: string,
): Promise<AccessCheck> {
  const subdomain = await c.env.DB.prepare(
    `
    SELECT id, user_id
    FROM subdomains
    WHERE subdomain = ? AND status = 'active' AND subdomain NOT LIKE '%.serve'
  `,
  )
    .bind(handle)
    .first<{ id: string; user_id: string }>();

  if (!subdomain) {
    return { ok: false, status: 404, error: 'Unknown handle' };
  }

  const user = c.get('user');
  if (subdomain.user_id === user.id) {
    return { ok: true, ownerUserId: subdomain.user_id };
  }

  const identityId = c.get('token').device_fingerprint;
  if (identityId) {
    const grant = await c.env.DB.prepare(
      'SELECT 1 FROM subdomain_access WHERE subdomain_id = ? AND identity_id = ?',
    )
      .bind(subdomain.id, identityId)
      .first();
    if (grant) {
      return { ok: true, ownerUserId: subdomain.user_id };
    }
  }

  return { ok: false, status: 403, error: 'Not authorized for this project' };
}

async function getArtifactProject(
  env: Env,
  handle: string,
  slug: string,
): Promise<ArtifactProjectRecord | null> {
  return env.DB.prepare(
    `
    SELECT id, handle, slug, owner_user_id, upstream_repo_id, upstream_git_url
    FROM artifact_projects
    WHERE handle = ? AND slug = ?
  `,
  )
    .bind(handle, slug)
    .first<ArtifactProjectRecord>();
}

async function mintProjectToken(
  env: Env,
  project: ArtifactProjectRecord,
): Promise<{ token: string; expiresAt: number }> {
  const upstream = createUpstreamArtifactsHost(env);
  const minted = await upstream.mintScopedToken(project.upstream_repo_id, 'write', TOKEN_TTL_SECONDS);
  // Enforce the <= 1h ceiling even if the upstream returns a longer expiry.
  const expiresAt = Math.min(minted.expiresAt, Date.now() + TOKEN_TTL_SECONDS * 1000);
  return { token: minted.token, expiresAt };
}

/**
 * Provision (or ensure) the managed artifacts repo for a project.
 * POST /artifacts/provision   { project: "handle/slug" }
 */
app.post('/provision', async (c) => {
  const body = await c.req.json<{ project?: string }>().catch(() => ({} as { project?: string }));
  const ref = parseProjectRef(body.project);
  if (!ref) {
    return c.json({ error: 'Invalid project. Expected "handle/slug".' }, 400);
  }

  const access = await checkHandleAccess(c, ref.handle);
  if (!access.ok) {
    return c.json({ error: access.error }, access.status);
  }

  let project = await getArtifactProject(c.env, ref.handle, ref.slug);
  if (!project) {
    const upstream = createUpstreamArtifactsHost(c.env);
    let repo;
    try {
      repo = await upstream.createRepo(`${ref.handle}--${ref.slug}`);
    } catch (error) {
      console.error('Artifacts repo provisioning failed:', error);
      return c.json({ error: 'Failed to provision artifacts repo' }, 502);
    }

    const now = Date.now();
    const id = crypto.randomUUID();
    await c.env.DB.prepare(
      `
      INSERT INTO artifact_projects (
        id, handle, slug, owner_user_id, upstream_repo_id, upstream_git_url, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(handle, slug) DO NOTHING
    `,
    )
      .bind(id, ref.handle, ref.slug, access.ownerUserId, repo.repoId, repo.gitUrl, now, now)
      .run();

    project = await getArtifactProject(c.env, ref.handle, ref.slug);
    if (!project) {
      return c.json({ error: 'Failed to provision artifacts repo' }, 500);
    }
  }

  const minted = await mintProjectToken(c.env, project);
  return c.json({
    project: `${ref.handle}/${ref.slug}`,
    gitUrl: buildGitUrl(c.env, ref.handle, ref.slug),
    token: minted.token,
    expiresAt: minted.expiresAt,
  });
});

/**
 * Re-mint a short-lived scoped token for a provisioned project.
 * GET /artifacts/token?project=handle/slug
 */
app.get('/token', async (c) => {
  const ref = parseProjectRef(c.req.query('project'));
  if (!ref) {
    return c.json({ error: 'Invalid project. Expected "handle/slug".' }, 400);
  }

  const access = await checkHandleAccess(c, ref.handle);
  if (!access.ok) {
    return c.json({ error: access.error }, access.status);
  }

  const project = await getArtifactProject(c.env, ref.handle, ref.slug);
  if (!project) {
    return c.json({ error: 'Project is not provisioned' }, 404);
  }

  const minted = await mintProjectToken(c.env, project);
  return c.json({
    project: `${ref.handle}/${ref.slug}`,
    gitUrl: buildGitUrl(c.env, ref.handle, ref.slug),
    token: minted.token,
    expiresAt: minted.expiresAt,
  });
});

interface BlobRouteContext {
  handle: string;
  slug: string;
  oid: string;
  key: string;
}

type BlobCheck =
  | { ok: true; blob: BlobRouteContext }
  | { ok: false; response: Response };

async function checkBlobRequest(
  c: Context<{ Bindings: Env; Variables: AuthContext }>,
): Promise<BlobCheck> {
  const handle = c.req.param('handle');
  const slug = c.req.param('slug');
  const oid = c.req.param('oid');

  if (!HANDLE_REGEX.test(handle) || !SLUG_REGEX.test(slug)) {
    return { ok: false, response: c.json({ error: 'Invalid project. Expected "handle/slug".' }, 400) };
  }
  if (!OID_REGEX.test(oid)) {
    return { ok: false, response: c.json({ error: 'Invalid oid. Expected lowercase sha256 hex.' }, 400) };
  }

  const access = await checkHandleAccess(c, handle);
  if (!access.ok) {
    return { ok: false, response: c.json({ error: access.error }, access.status) };
  }

  const project = await getArtifactProject(c.env, handle, slug);
  if (!project) {
    return { ok: false, response: c.json({ error: 'Project is not provisioned' }, 404) };
  }

  return { ok: true, blob: { handle, slug, oid, key: `${handle}/${slug}/${oid}` } };
}

/**
 * Upload a content-addressed blob (LFS-style split; oid = sha256 hex).
 * PUT /artifacts/blobs/:handle/:slug/:oid
 */
app.put('/blobs/:handle/:slug/:oid', async (c) => {
  const checked = await checkBlobRequest(c);
  if (!checked.ok) {
    return checked.response;
  }
  const { oid, key } = checked.blob;

  const contentLengthHeader = c.req.header('Content-Length');
  if (!contentLengthHeader) {
    return c.json({ error: 'Content-Length is required' }, 411);
  }
  const contentLength = Number.parseInt(contentLengthHeader, 10);
  if (!Number.isFinite(contentLength) || contentLength < 0) {
    return c.json({ error: 'Invalid Content-Length' }, 400);
  }
  if (contentLength > MAX_BLOB_BYTES) {
    return c.json({ error: `Blob exceeds maximum size of ${MAX_BLOB_BYTES} bytes` }, 413);
  }

  const existing = await c.env.ARTIFACT_BLOBS.head(key);
  if (existing) {
    return c.json({ oid, size: existing.size, existed: true });
  }

  const body = c.req.raw.body ?? new Uint8Array(0);
  let object: R2Object;
  try {
    // R2 verifies the sha256 checksum of the received bytes against the oid,
    // so a content/oid mismatch fails the put — integrity enforced upstream
    // of any reader.
    object = await c.env.ARTIFACT_BLOBS.put(key, body, {
      sha256: oid,
      httpMetadata: { contentType: 'application/octet-stream' },
    });
  } catch (error) {
    console.error('Blob upload failed:', error);
    return c.json({ error: 'Blob upload failed (oid must be the sha256 of the content)' }, 400);
  }

  return c.json({ oid, size: object.size, existed: false });
});

/**
 * Download a blob.
 * GET /artifacts/blobs/:handle/:slug/:oid
 */
app.get('/blobs/:handle/:slug/:oid', async (c) => {
  const checked = await checkBlobRequest(c);
  if (!checked.ok) {
    return checked.response;
  }

  const object = await c.env.ARTIFACT_BLOBS.get(checked.blob.key);
  if (!object) {
    return c.json({ error: 'Blob not found' }, 404);
  }

  return new Response(object.body, {
    status: 200,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(object.size),
      ETag: object.httpEtag,
    },
  });
});

/**
 * Blob existence check.
 * HEAD /artifacts/blobs/:handle/:slug/:oid
 */
app.on('HEAD', '/blobs/:handle/:slug/:oid', async (c) => {
  const checked = await checkBlobRequest(c);
  if (!checked.ok) {
    return new Response(null, { status: checked.response.status });
  }

  const object = await c.env.ARTIFACT_BLOBS.head(checked.blob.key);
  if (!object) {
    return new Response(null, { status: 404 });
  }

  return new Response(null, {
    status: 200,
    headers: {
      'Content-Length': String(object.size),
      ETag: object.httpEtag,
    },
  });
});

export default app;
