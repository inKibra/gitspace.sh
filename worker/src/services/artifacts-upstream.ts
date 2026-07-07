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
 * Real implementation against the CF Artifacts REST API.
 *
 * UNVERIFIED-AT-DEPLOY: the REST shapes below (paths, request bodies, and
 * response envelopes) are best-effort reconstructions of the CF Artifacts
 * beta API and MUST be verified against the real Cloudflare docs before
 * this code path is enabled in production (the product went to public beta
 * ~May 2026; see docs/ARTIFACTS-FS.md "Cloudflare Artifacts facts").
 * Assumed shapes:
 *   POST {base}/repos                  { name }                     -> { success, result: { id, git_url } }
 *   POST {base}/repos/{id}/tokens      { access, ttl_seconds }      -> { success, result: { token, expires_at } }
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
      result?: { id?: string; git_url?: string };
    };

    if (!data.success || !data.result?.id) {
      throw new Error('Upstream repo creation returned an unexpected shape');
    }

    return {
      repoId: data.result.id,
      gitUrl: data.result.git_url ?? '',
    };
  }

  async mintScopedToken(
    repoId: string,
    access: UpstreamTokenAccess,
    ttlSeconds: number,
  ): Promise<UpstreamScopedToken> {
    const response = await fetch(
      `${this.baseUrl}/repos/${encodeURIComponent(repoId)}/tokens`,
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ access, ttl_seconds: ttlSeconds }),
      },
    );

    if (!response.ok) {
      throw new Error(`Upstream token mint failed (${response.status})`);
    }

    const data = (await response.json()) as {
      success: boolean;
      result?: { token?: string; expires_at?: number };
    };

    if (!data.success || !data.result?.token) {
      throw new Error('Upstream token mint returned an unexpected shape');
    }

    // UNVERIFIED-AT-DEPLOY: expires_at unit. Normalize seconds vs ms epochs.
    const rawExpiry = data.result.expires_at;
    const expiresAt = typeof rawExpiry === 'number'
      ? (rawExpiry < 1_000_000_000_000 ? rawExpiry * 1000 : rawExpiry)
      : Date.now() + ttlSeconds * 1000;

    return { token: data.result.token, expiresAt };
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
