/**
 * Upstream artifacts host abstraction (managed Tier 2 artifacts repos).
 *
 * The managed artifacts tier stores each project's artifacts repo on
 * Cloudflare's git-repo hosting product ("CF Artifacts": repo-scoped Bearer
 * tokens via REST, ~10GB/repo, no native LFS — see docs/ARTIFACTS-FS.md).
 *
 * SECURITY INVARIANT: the long-lived CF API credential
 * (CF_ARTIFACTS_API_TOKEN) never leaves the worker. Callers only ever see
 * short-lived repo-scoped tokens minted through this interface.
 */

import type { Env } from '../types';

export interface UpstreamRepo {
  repoId: string;
  gitUrl: string;
}

export type UpstreamTokenAccess = 'read' | 'write';

export interface UpstreamScopedToken {
  token: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

export interface UpstreamArtifactsHost {
  /** Create (or return an existing) repo with the given name. */
  createRepo(name: string): Promise<UpstreamRepo>;
  /** Mint a short-lived repo-scoped token. ttlSeconds is capped by callers. */
  mintScopedToken(
    repoId: string,
    access: UpstreamTokenAccess,
    ttlSeconds: number,
  ): Promise<UpstreamScopedToken>;
}

/**
 * Real implementation against the CF Artifacts REST API — shapes VERIFIED
 * against the live docs (2026-07):
 *   base = https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/artifacts/namespaces/{NAMESPACE}
 *   POST {base}/repos   { name }                        -> { success, result: { id, name, remote, token } }
 *   POST {base}/tokens  { repo, scope: read|write, ttl } -> { success, result: { id, plaintext, scope, expires_at } }
 *   token format: art_v1_<40hex>?expires=<unix_seconds>; git auth =
 *   http.extraHeader "Authorization: Bearer <token>" (or basic x:<secret>).
 * Sources: developers.cloudflare.com/artifacts/api/rest-api/,
 * /artifacts/get-started/rest-api/, /artifacts/api/git-protocol/.
 * CF_ARTIFACTS_API_URL should be the full namespace base above.
 */
export class CfArtifactsHost implements UpstreamArtifactsHost {
  private readonly baseUrl: string;
  private readonly apiToken: string;

  constructor(baseUrl: string, apiToken: string) {
    let parsed: URL;
    try {
      parsed = new URL(baseUrl);
    } catch {
      throw new Error('CF_ARTIFACTS_API_URL must be a valid URL');
    }
    this.baseUrl = parsed.toString().replace(/\/$/, '');
    this.apiToken = apiToken;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiToken}`,
      'Content-Type': 'application/json',
    };
  }

  async createRepo(name: string): Promise<UpstreamRepo> {
    const response = await fetch(`${this.baseUrl}/repos`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ name }),
    });

    if (!response.ok) {
      throw new Error(`Upstream repo creation failed (${response.status})`);
    }

    const data = (await response.json()) as {
      success: boolean;
      result?: { id?: string; name?: string; remote?: string; token?: string };
    };

    if (!data.success || !data.result?.id) {
      throw new Error('Upstream repo creation returned an unexpected shape');
    }

    // `remote` is the standard smart-HTTP URL:
    // https://<ACCOUNT_ID>.artifacts.cloudflare.net/git/<namespace>/<repo>.git
    return {
      repoId: data.result.name ?? name,
      gitUrl: data.result.remote ?? '',
    };
  }

  async mintScopedToken(
    repoId: string,
    access: UpstreamTokenAccess,
    ttlSeconds: number,
  ): Promise<UpstreamScopedToken> {
    // Tokens are namespace-level, keyed by repo NAME; ttl in seconds
    // (min 60, max 31_536_000). scope: 'read' | 'write'.
    const response = await fetch(`${this.baseUrl}/tokens`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ repo: repoId, scope: access, ttl: ttlSeconds }),
    });

    if (!response.ok) {
      throw new Error(`Upstream token mint failed (${response.status})`);
    }

    const data = (await response.json()) as {
      success: boolean;
      result?: { plaintext?: string; expires_at?: number | string };
    };

    if (!data.success || !data.result?.plaintext) {
      throw new Error('Upstream token mint returned an unexpected shape');
    }

    // plaintext = art_v1_<40hex>?expires=<unix_seconds> — the ?expires suffix
    // is authoritative; fall back to expires_at, then ttl.
    const token = data.result.plaintext;
    const suffix = token.match(/\?expires=(\d+)/);
    const raw = data.result.expires_at;
    const fromField = typeof raw === 'string' ? Date.parse(raw) : typeof raw === 'number' ? (raw < 1_000_000_000_000 ? raw * 1000 : raw) : NaN;
    const expiresAt = suffix ? Number(suffix[1]) * 1000 : Number.isFinite(fromField) ? fromField : Date.now() + ttlSeconds * 1000;

    return { token, expiresAt };
  }
}

/**
 * In-memory implementation for tests and local development (used when
 * CF_ARTIFACTS_API_URL is not configured). Never suitable for production:
 * repos and tokens are per-isolate and evaporate on restart.
 */
export class MemoryArtifactsHost implements UpstreamArtifactsHost {
  private readonly repos = new Map<string, UpstreamRepo>();

  async createRepo(name: string): Promise<UpstreamRepo> {
    const existing = this.repos.get(name);
    if (existing) {
      return existing;
    }

    const repo: UpstreamRepo = {
      repoId: `memrepo_${crypto.randomUUID()}`,
      gitUrl: `memory://artifacts/${name}.git`,
    };
    this.repos.set(name, repo);
    return repo;
  }

  async mintScopedToken(
    repoId: string,
    access: UpstreamTokenAccess,
    ttlSeconds: number,
  ): Promise<UpstreamScopedToken> {
    return {
      token: `cfa_mem_${access}_${repoId}_${crypto.randomUUID().replace(/-/g, '')}`,
      expiresAt: Date.now() + ttlSeconds * 1000,
    };
  }
}

const memoryHost = new MemoryArtifactsHost();

/**
 * Select the upstream host implementation from the environment.
 */
export function createUpstreamArtifactsHost(env: Env): UpstreamArtifactsHost {
  if (env.CF_ARTIFACTS_API_URL) {
    if (!env.CF_ARTIFACTS_API_TOKEN) {
      throw new Error('CF_ARTIFACTS_API_TOKEN is required when CF_ARTIFACTS_API_URL is set');
    }
    return new CfArtifactsHost(env.CF_ARTIFACTS_API_URL, env.CF_ARTIFACTS_API_TOKEN);
  }

  console.warn('CF_ARTIFACTS_API_URL not configured; using in-memory artifacts upstream (dev/test only)');
  return memoryHost;
}
