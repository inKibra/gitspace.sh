/**
 * Artifact capability core (docs/ARTIFACT-PROTOCOL.md).
 *
 * One concept for "who may touch which artifacts": a signed capability record
 * scoping verbs to artifact:// URI globs. Trigger write-scopes (Phase 3) and
 * share links (Phase 5) are both instances of this record; the ambient
 * registry below covers in-process producers with compile-time declarations.
 *
 * Pure + dependency-injected: signing keys are supplied by callers (the
 * daemon owns key material), so this module stays unit-testable offline.
 */

import { createHash } from 'crypto';
import { sign as ed25519Sign, verify as ed25519Verify } from '../lib/tmux-lite/crypto/identity.js';
import { SpacesError } from '../types/errors.js';

// ── artifact:// URIs ────────────────────────────────────────────────────────

export interface ArtifactUri {
  project: string;
  /** Workspace name or '@base' (the project base clone's main mount). */
  workspace: string;
  /** Mount-relative posix path ('' addresses the mount root, e.g. for list prefixes). */
  relPath: string;
}

export function formatArtifactUri(project: string, workspace: string, relPath = ''): string {
  return `artifact://${encodeURIComponent(project)}/${encodeURIComponent(workspace)}${relPath ? `/${relPath}` : ''}`;
}

export function parseArtifactUri(uri: string): ArtifactUri {
  const m = uri.match(/^artifact:\/\/([^/]+)\/([^/]+)(?:\/(.*))?$/);
  if (!m) throw new SpacesError(`Not an artifact URI: ${uri}`, 'USER_ERROR', 1);
  const project = decodeURIComponent(m[1]!);
  const workspace = decodeURIComponent(m[2]!);
  const relPath = m[3] ?? '';
  if (relPath && relPath.split('/').some((s) => s === '' || s === '.' || s === '..')) {
    throw new SpacesError(`Unsafe artifact URI path: ${uri}`, 'USER_ERROR', 1);
  }
  return { project, workspace, relPath };
}

// ── glob matching (ONE canonical matcher — the hook's check is generated
//    from the same semantics; keep this dependency-free) ────────────────────

/** Convert a scope glob to a RegExp. Supports '**' (any depth), '*' (within a
 *  segment), '?' (one char); a trailing '/' means "that directory and below". */
export function scopeGlobToRegExp(glob: string): RegExp {
  let g = glob.trim();
  if (g.endsWith('/')) g = `${g}**`;
  let out = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!;
    if (c === '*') {
      if (g[i + 1] === '*') {
        out += '.*';
        i += 1;
        if (g[i + 1] === '/') i += 1; // '**/' — '.*' already covers the slash
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(c)) {
      out += `\\${c}`;
    } else {
      out += c;
    }
  }
  return new RegExp(`^${out}$`);
}

/** Does a mount-relative path fall inside any of the scope globs? */
export function pathInScope(relPath: string, scopeGlobs: string[]): boolean {
  return scopeGlobs.some((g) => scopeGlobToRegExp(g).test(relPath));
}

// ── ambient capabilities (in-process producers) ─────────────────────────────

/** Compile-time write scopes for gitspace's own producers — an auditable
 *  registry, not runtime checks. Every entry names paths a producer writes
 *  through captureArtifacts today. */
export const AMBIENT_WRITE_SCOPES: Record<string, string[]> = {
  triggers: ['triggers/**'],
  'phase-journal': ['journal/**'],
  'review-guide': ['review/**'],
  'goal-chain': ['goal.md', 'rubric.json', 'goal/**'],
  'goal-validation': ['validation/**', 'evidence/**'],
  'edit-breadcrumbs': ['blame/**'],
  'lfs-backfill': ['.gitattributes'],
};

// ── capability records ──────────────────────────────────────────────────────

export type CapVerb = 'read' | 'write' | 'share';

export interface ArtifactCap {
  v: 1;
  tokenId: string;
  sub: { kind: 'session' | 'trigger' | 'user' | 'link'; id?: string };
  verbs: CapVerb[];
  /** artifact:// URIs whose relPath segment may contain scope globs. */
  scope: string[];
  machineId: string;
  /** Epoch ms. */
  expiresAt: number;
  maxUses?: number;
}

export interface SignedArtifactCap extends ArtifactCap {
  sig: string;
}

const CAP_PREFIX = 'gssh-cap:';
const CAP_DOMAIN = 'gitspace-artifact-cap-v1';

/** Deterministic bytes for signing: domain separator + sorted-key JSON. */
function canonicalCapBytes(cap: ArtifactCap): Uint8Array {
  const sorted = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sorted);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sorted(v)]));
    }
    return value;
  };
  return new TextEncoder().encode(`${CAP_DOMAIN}\n${JSON.stringify(sorted(cap))}`);
}

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

export function mintArtifactCap(cap: Omit<ArtifactCap, 'v' | 'tokenId'>, signingKey: Uint8Array): string {
  const record: ArtifactCap = { v: 1, tokenId: createHash('sha256').update(`${Date.now()}:${Math.random()}`).digest('hex').slice(0, 32), ...cap };
  const sig = b64url(ed25519Sign(canonicalCapBytes(record), signingKey));
  const signed: SignedArtifactCap = { ...record, sig };
  return `${CAP_PREFIX}${Buffer.from(JSON.stringify(signed)).toString('base64url')}`;
}

export interface CapVerifyOptions {
  publicKey: Uint8Array;
  now?: number;
}

/** Parse + verify a serialized cap. Throws USER_ERROR on any failure —
 *  callers treat an invalid cap as no cap, never as a broader one. */
export function verifyArtifactCap(token: string, opts: CapVerifyOptions): SignedArtifactCap {
  if (!token.startsWith(CAP_PREFIX)) throw new SpacesError('Not an artifact capability token', 'USER_ERROR', 1);
  let parsed: SignedArtifactCap;
  try {
    parsed = JSON.parse(Buffer.from(token.slice(CAP_PREFIX.length), 'base64url').toString('utf8')) as SignedArtifactCap;
  } catch {
    throw new SpacesError('Malformed artifact capability token', 'USER_ERROR', 1);
  }
  const { sig, ...record } = parsed;
  if (record.v !== 1 || !sig) throw new SpacesError('Unsupported artifact capability version', 'USER_ERROR', 1);
  let ok = false;
  try {
    ok = ed25519Verify(canonicalCapBytes(record), Buffer.from(sig, 'base64url'), opts.publicKey);
  } catch {
    ok = false; // wrong-length sig/key throws in the primitive — treat as invalid
  }
  if (!ok) throw new SpacesError('Artifact capability signature invalid', 'USER_ERROR', 1);
  if ((opts.now ?? Date.now()) > record.expiresAt) throw new SpacesError('Artifact capability expired', 'USER_ERROR', 1);
  return parsed;
}

/** Parse WITHOUT verification — for provenance display only, never for
 *  authorization decisions. */
export function parseArtifactCapUnverified(token: string): SignedArtifactCap | null {
  if (!token.startsWith(CAP_PREFIX)) return null;
  try {
    return JSON.parse(Buffer.from(token.slice(CAP_PREFIX.length), 'base64url').toString('utf8')) as SignedArtifactCap;
  } catch {
    return null;
  }
}

/** Does the cap authorize `verb` on `uri`? (Signature/expiry checked by
 *  verifyArtifactCap — this is the scope test.) */
export function capAllows(cap: ArtifactCap, verb: CapVerb, uri: ArtifactUri): boolean {
  if (!cap.verbs.includes(verb)) return false;
  return cap.scope.some((scopeUri) => {
    let parsed: ArtifactUri;
    try {
      parsed = parseArtifactUri(scopeUri);
    } catch {
      return false;
    }
    if (parsed.project !== uri.project || parsed.workspace !== uri.workspace) return false;
    return pathInScope(uri.relPath, [parsed.relPath || '**']);
  });
}
