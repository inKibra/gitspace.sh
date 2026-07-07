/**
 * Signed share links (docs/ARTIFACT-PROTOCOL.md Q3, hosted in the unified
 * daemon per docs/DAEMON-UNIFICATION.md P4).
 *
 * A share link IS a link-subject read capability (artifact-cap.ts) signed
 * with the REGISTERED machine key — the relay verifies it against the pubkey
 * it pinned at machine registration, then asks THIS daemon for the bytes
 * over the machine WebSocket. The relay never reads disk; the daemon
 * re-verifies with its own key, enforces the fail-closed revocation ledger,
 * and serves RESOLVED bytes (LFS pointers become content).
 *
 * Minting requires an ACTIVE serve runtime: no public surface, no links.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import {
  capAllows,
  formatArtifactUri,
  mintArtifactCap,
  parseArtifactUri,
  verifyArtifactCap,
} from '../../core/artifact-cap.js';
import { getActiveServeContext } from './serve-runtime.js';
import { getWorkspaceRoot } from '../../core/paths.js';
import { SpacesError } from '../../types/errors.js';

// ── ledger (fail closed: ledger loss revokes every outstanding link) ────────

export interface ShareLedgerEntry {
  tokenId: string;
  uri: string;
  createdAt: number;
  expiresAt: number;
  maxUses?: number;
  useCount: number;
  revokedAt?: number;
}

interface ShareLedger {
  v: 1;
  shares: Record<string, ShareLedgerEntry>;
}

function ledgerPath(): string {
  return join(getWorkspaceRoot(), '.serve', 'artifact-shares.json');
}

function readLedger(): ShareLedger {
  try {
    const parsed = JSON.parse(readFileSync(ledgerPath(), 'utf8')) as ShareLedger;
    if (parsed?.v === 1 && parsed.shares) return parsed;
  } catch { /* missing/corrupt → empty (fail closed: unknown tokenId = revoked) */ }
  return { v: 1, shares: {} };
}

function writeLedger(ledger: ShareLedger): void {
  const path = ledgerPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(ledger, null, 2), { mode: 0o600 });
}

// ── minting ─────────────────────────────────────────────────────────────────

const DEFAULT_TTL_MS = 7 * 24 * 3_600_000;

export interface MintShareResult {
  url: string;
  token: string;
  tokenId: string;
  expiresAt: number;
}

/** Public base for share URLs: the hosted subdomain when configured, else the
 *  relay's HTTP origin (ws:// → http://, wss:// → https://). */
export function shareUrlBase(relayUrl: string, hostedDomain?: string | null): string {
  if (hostedDomain) return `https://${hostedDomain}`;
  const u = new URL(relayUrl);
  const proto = u.protocol === 'wss:' ? 'https:' : 'http:';
  return `${proto}//${u.host}`;
}

export function mintShareLink(opts: {
  uri: string;
  ttlMs?: number;
  maxUses?: number;
  hostedDomain?: string | null;
}): MintShareResult {
  const ctx = getActiveServeContext();
  if (!ctx) {
    throw new SpacesError('Share links need serve active (gssh machine serve start) — the link is served through your relay.', 'USER_ERROR', 1);
  }
  const parsed = parseArtifactUri(opts.uri); // validates
  if (!parsed.relPath) throw new SpacesError('Share links point at a single artifact file, not a directory.', 'USER_ERROR', 1);
  const expiresAt = Date.now() + (opts.ttlMs ?? DEFAULT_TTL_MS);
  const token = mintArtifactCap({
    sub: { kind: 'link' },
    verbs: ['read'],
    scope: [opts.uri],
    machineId: ctx.machineId,
    expiresAt,
    ...(opts.maxUses ? { maxUses: opts.maxUses } : {}),
  }, ctx.identity.signing.secretKey);
  const parsedBack = verifyArtifactCap(token, { publicKey: ctx.identity.signing.publicKey });

  const ledger = readLedger();
  ledger.shares[parsedBack.tokenId] = {
    tokenId: parsedBack.tokenId,
    uri: opts.uri,
    createdAt: Date.now(),
    expiresAt,
    maxUses: opts.maxUses,
    useCount: 0,
  };
  writeLedger(ledger);

  return {
    url: `${shareUrlBase(ctx.relayUrl, opts.hostedDomain)}/artifact-share/${encodeURIComponent(token)}`,
    token,
    tokenId: parsedBack.tokenId,
    expiresAt,
  };
}

export function revokeShareLink(tokenId: string): boolean {
  const ledger = readLedger();
  const entry = ledger.shares[tokenId];
  if (!entry || entry.revokedAt) return false;
  entry.revokedAt = Date.now();
  writeLedger(ledger);
  return true;
}

export function listShareLinks(): ShareLedgerEntry[] {
  return Object.values(readLedger().shares).sort((a, b) => b.createdAt - a.createdAt);
}

// ── serving (the machine side of GET /artifact-share/<token>) ──────────────

/** Content-Type allowlist: only these render inline; everything else arrives
 *  as an attachment (kills stored-XSS via shared HTML on the share origin). */
const INLINE_TYPES: Record<string, string> = {
  '.md': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'text/plain; charset=utf-8', // svg inline = script vector; serve as text
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.pdf': 'application/pdf',
};

export interface ShareReadResult {
  bytes: Buffer;
  contentType: string;
  disposition: 'inline' | 'attachment';
  fileName: string;
}

/** Verify + ledger-enforce + resolve. Every failure is the same USER_ERROR
 *  shape upstream (the relay serves 404 — no oracle for attackers). */
export async function consumeShareRead(token: string): Promise<ShareReadResult> {
  const ctx = getActiveServeContext();
  if (!ctx) throw new SpacesError('serve inactive', 'USER_ERROR', 1);

  // Defense in depth: the daemon trusts its OWN key, not the relay's check.
  const cap = verifyArtifactCap(token, { publicKey: ctx.identity.signing.publicKey });
  if (cap.sub.kind !== 'link' || !cap.verbs.includes('read')) throw new SpacesError('not a share link', 'USER_ERROR', 1);

  const ledger = readLedger();
  const entry = ledger.shares[cap.tokenId];
  if (!entry) throw new SpacesError('unknown share (ledger fail-closed)', 'USER_ERROR', 1);
  if (entry.revokedAt) throw new SpacesError('share revoked', 'USER_ERROR', 1);
  if (Date.now() > entry.expiresAt) throw new SpacesError('share expired', 'USER_ERROR', 1);
  if (entry.maxUses !== undefined && entry.useCount >= entry.maxUses) throw new SpacesError('share exhausted', 'USER_ERROR', 1);
  // Single daemon process owns the ledger — the increment is serialized.
  entry.useCount += 1;
  writeLedger(ledger);

  const uri = entry.uri;
  const parsed = parseArtifactUri(uri);
  if (!capAllows(cap, 'read', parsed)) throw new SpacesError('scope mismatch', 'USER_ERROR', 1);

  const { readArtifactResolving, artifactsMountDir } = await import('../../core/artifacts.js');
  const { getProjectBaseDir, getProjectDir } = await import('../../core/config.js');
  const projectDir = getProjectDir(parsed.project);
  const workspaceDir = parsed.workspace === '@base' ? getProjectBaseDir(parsed.project) : join(projectDir, 'workspaces', parsed.workspace);
  const bytes = await readArtifactResolving(projectDir, artifactsMountDir(workspaceDir), parsed.relPath);

  const fileName = parsed.relPath.split('/').pop() ?? 'artifact';
  const ext = fileName.includes('.') ? `.${fileName.split('.').pop()!.toLowerCase()}` : '';
  const inlineType = INLINE_TYPES[ext];
  return {
    bytes,
    contentType: inlineType ?? 'application/octet-stream',
    disposition: inlineType ? 'inline' : 'attachment',
    fileName,
  };
}

/** Convenience for CLI/RPC mints: relPath within a workspace. */
export function mintWorkspaceShare(project: string, workspace: string, relPath: string, opts: { ttlMs?: number; maxUses?: number; hostedDomain?: string | null } = {}): MintShareResult {
  return mintShareLink({ uri: formatArtifactUri(project, workspace, relPath), ...opts });
}
