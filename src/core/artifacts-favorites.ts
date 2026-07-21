/**
 * Artifact favorites — durable, syncable curation (docs/ARTIFACTS-FS.md).
 *
 * A favorite is the user's "this is worth keeping" mark, made in the workspace
 * while the context is live. It used to live in browser localStorage, which did
 * not survive a machine move, was invisible to the rollup CLI, and was siloed
 * per-browser. It now lives in a MANIFEST FILE committed to the workspace's
 * artifacts branch, so it travels with the goal folder through roll-up and any
 * clone (or the rollup CLI) can read it.
 *
 * ── Location ────────────────────────────────────────────────────────────────
 * `<goal-scope-root>/.favorites.json`, i.e. `goals/<goal-id>/.favorites.json`
 * for a workspace session, or `.favorites.json` at the mount root for the
 * project base (which owns no goal). It lives INSIDE the goal folder on purpose:
 * goal folders are disjoint, so the manifest merges into `main` at roll-up
 * without ever conflicting, and it moves with the goal it curates.
 *
 * ── Format (schema/version) ─────────────────────────────────────────────────
 *   { "schema": "gssh.artifact-favorites/v1", "favorites": ["reports/x.json"] }
 * `favorites` are SCOPE-RELATIVE posix paths (relative to the goal folder),
 * sorted + deduped so diffs stay minimal. Scope-relative — not mount-relative —
 * because that is the basis the rollup FILTER (follow-up #48) needs: rolling up
 * `goals/<id>/` means "keep these relpaths under it", a straight membership test
 * against this list.
 *
 * ── Commit strategy: commit-on-toggle ──────────────────────────────────────
 * Each toggle/merge writes and COMMITS the manifest on the artifacts branch.
 * An uncommitted working-tree file never syncs (sync pushes commits), which is
 * the whole failure localStorage had. The manifest is a single tiny file and
 * favoriting is human-scale (a handful per goal), so the commit trail is cheap
 * and is itself useful provenance. Commits reuse `captureArtifacts`, which sets
 * GSSH_ARTIFACTS_CAPTURE=1 (skips the LFS/provenance-note hooks — the file is
 * tiny and needs no note per toggle). No-op toggles/merges never commit.
 */

import { existsSync, readFileSync, statSync } from 'fs';
import { basename, dirname, join, posix } from 'path';
import { SpacesError } from '../types/errors.js';
import { resolveAttachmentRef } from '../components/artifact-kinds.js';
import { captureArtifacts, isGoalScopedPath, readArtifactResolving, type ArtifactsScope, type CaptureFile } from './artifacts.js';

export const FAVORITES_SCHEMA_V1 = 'gssh.artifact-favorites/v1';
const FAVORITES_FILE = '.favorites.json';

export interface FavoritesManifest {
  schema: string;
  /** Scope-relative (goal-folder-relative) posix paths, sorted + deduped. */
  favorites: string[];
}

/** Mount-relative path of the manifest for this scope (what git commits). */
export function favoritesManifestMountRel(scope: ArtifactsScope): string {
  return scope.rel(FAVORITES_FILE);
}

function normalize(paths: string[]): string[] {
  const clean = paths
    .map((p) => p.replace(/^\/+/, '').replace(/\/+$/, ''))
    .filter(Boolean);
  return [...new Set(clean)].sort();
}

/** Read SCOPE-relative favorites (sorted, deduped). Missing/corrupt → []. */
export function readFavoritesScopeRel(scope: ArtifactsScope): string[] {
  const p = scope.abs(FAVORITES_FILE);
  if (!existsSync(p)) return [];
  try {
    const doc = JSON.parse(readFileSync(p, 'utf8')) as Partial<FavoritesManifest>;
    if (!doc || !Array.isArray(doc.favorites)) return [];
    return normalize(doc.favorites.filter((x): x is string => typeof x === 'string'));
  } catch {
    return [];
  }
}

/** Favorites as MOUNT-relative paths — the basis the UI compares against the
 *  artifact list entries. */
export function readFavoritesMountRel(scope: ArtifactsScope): string[] {
  return readFavoritesScopeRel(scope).map((r) => scope.rel(r));
}

/**
 * Translate an incoming favorite path to a SCOPE-relative path, or null if it
 * cannot belong to this scope. This is what lets a single manifest dedup two
 * different path bases without thrashing:
 *   - mount-relative under the goal root (`goals/<id>/x` → `x`)   [live toggle]
 *   - old-flat / already scope-relative  (`x` → `x`)             [reconcile v1]
 * Both bases collapse to the same scope-relative key before any set op.
 * Paths that target a DIFFERENT goal folder, or (in a workspace) a project-
 * level artifact outside the goal, return null — they have no roll-up meaning
 * and must not be stored goal-relative (they would read back as a dead path).
 */
export function toScopeRel(scope: ArtifactsScope, incoming: string): string | null {
  const clean = incoming.replace(/^\/+/, '').replace(/\/+$/, '');
  if (!clean) return null;
  if (scope.rootRel) {
    if (clean === scope.rootRel) return null; // the folder itself
    if (clean.startsWith(`${scope.rootRel}/`)) return clean.slice(scope.rootRel.length + 1);
    if (isGoalScopedPath(clean)) return null; // goals/<other>/… — not ours
    return clean; // old-flat basis == scope-relative
  }
  // project root: mount-relative IS scope-relative
  return clean;
}

async function writeManifest(projectDir: string, scope: ArtifactsScope, next: string[], message: string, extraFiles: CaptureFile[] = []): Promise<void> {
  const manifest: FavoritesManifest = { schema: FAVORITES_SCHEMA_V1, favorites: next };
  const json = `${JSON.stringify(manifest, null, 2)}\n`;
  await captureArtifacts(projectDir, scope.mountDir, [{ path: favoritesManifestMountRel(scope), content: json }, ...extraFiles], { message });
}

export interface ToggleFavoriteResult {
  /** Updated favorites as MOUNT-relative paths (client replaces its set). */
  favorites: string[];
  /** Attachment refs of a favorited report that could NOT be snapshotted
   *  (target unresolvable) — the favorite still succeeded. */
  snapshotSkipped: string[];
}

interface AttachmentSnapshotPlan {
  /** Snapshot copies + the rewritten report, committed WITH the manifest. */
  files: CaptureFile[];
  snapshotSkipped: string[];
}

/**
 * Snapshot a favorited report's attachments (docs/ARTIFACTS-FS.md: a favorited
 * report becomes durable corpus — only favorited reports roll up — so its
 * linked targets are frozen at favorite time, or the proof rots when a live
 * target later changes).
 *
 * - Copies land beside the report: `<reports-dir>/<name>.attachments/<file>`
 *   (report `reports/x.report.json` → `reports/x.attachments/…`), inside the
 *   goal folder so they travel through roll-up with the report automatically.
 * - The report JSON gains an ADDITIVE `snapshotRef` per attachment (same
 *   report-prefix-relative basis as `ref`); the live ref is never replaced.
 * - Sources resolve by the report-prefix rule (resolveAttachmentRef): anchored
 *   to the report's own goals/<id>/ prefix, fallback as-is. Unresolvable
 *   targets are SKIPPED and reported — never fail the favorite.
 * - Idempotent: an attachment whose snapshotRef already resolves is left
 *   untouched, so re-favoriting churns no commits beyond the manifest toggle.
 * - Pointer-aware: sources read through the blob store, so a video snapshot
 *   re-pointers to the SAME content hash (no blob duplication).
 */
async function planAttachmentSnapshots(projectDir: string, scope: ArtifactsScope, reportScopeRel: string): Promise<AttachmentSnapshotPlan> {
  const none: AttachmentSnapshotPlan = { files: [], snapshotSkipped: [] };
  // On a project-root scope a goal-scoped report belongs to a workspace's goal
  // folder — goals/** is roll-up-only, so main must not grow snapshot files
  // (or the next roll-up of that goal conflicts). Favorite still proceeds.
  if (scope.isProjectRoot && isGoalScopedPath(reportScopeRel)) return none;

  const reportMountRel = scope.rel(reportScopeRel);
  const reportAbs = scope.abs(reportScopeRel);
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(readFileSync(reportAbs, 'utf8')) as Record<string, unknown>;
  } catch {
    return none; // not JSON we can rewrite — favorite proceeds un-snapshotted
  }
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.attachments)) return none;

  const existsInMount = (p: string): boolean => {
    const abs = join(scope.mountDir, p);
    try { return existsSync(abs) && statSync(abs).isFile(); } catch { return false; }
  };

  const snapDirScopeRel = posix.join(dirname(reportScopeRel), `${basename(reportScopeRel).replace(/\.report\.json$/, '')}.attachments`);
  const files: CaptureFile[] = [];
  const snapshotSkipped: string[] = [];
  const usedNames = new Set<string>();
  let rewrote = false;

  for (const a of doc.attachments as Array<Record<string, unknown>>) {
    if (!a || typeof a !== 'object' || typeof a.ref !== 'string') continue;
    // Already snapshotted and the copy still exists → nothing to do.
    if (typeof a.snapshotRef === 'string' && resolveAttachmentRef(reportMountRel, a.snapshotRef, existsInMount) !== null) continue;
    const srcMountRel = resolveAttachmentRef(reportMountRel, a.ref, existsInMount);
    if (srcMountRel === null) {
      snapshotSkipped.push(a.ref);
      continue;
    }
    let bytes: Buffer;
    try {
      bytes = await readArtifactResolving(projectDir, scope.mountDir, srcMountRel);
    } catch {
      snapshotSkipped.push(a.ref); // pointer whose blob is unavailable, etc.
      continue;
    }
    let name = basename(srcMountRel);
    if (usedNames.has(name)) {
      const dot = name.lastIndexOf('.');
      for (let i = 2; usedNames.has(name); i++) name = dot > 0 ? `${name.slice(0, dot)}-${i}${name.slice(dot)}` : `${name}-${i}`;
    }
    usedNames.add(name);
    const snapScopeRel = posix.join(snapDirScopeRel, name);
    files.push({ path: scope.rel(snapScopeRel), content: bytes });
    a.snapshotRef = snapScopeRel; // same report-prefix-relative basis as `ref`
    rewrote = true;
  }

  if (rewrote) files.push({ path: reportMountRel, content: `${JSON.stringify(doc, null, 2)}\n` });
  return { files, snapshotSkipped };
}

/**
 * Toggle one favorite (add if absent, remove if present). Commits the manifest
 * and returns the updated list as MOUNT-relative paths (so the client just
 * replaces its set). `incoming` is a mount-relative artifact path.
 *
 * Favoriting a `*.report.json` also SNAPSHOTS its attachments (see
 * planAttachmentSnapshots) in the SAME capture commit as the manifest update.
 * Unfavoriting never deletes snapshots — they are committed history.
 */
export async function toggleFavorite(projectDir: string, scope: ArtifactsScope, incoming: string): Promise<ToggleFavoriteResult> {
  const rel = toScopeRel(scope, incoming);
  if (!rel) {
    throw new SpacesError(
      `Cannot favorite ${incoming}: favorites are goal-scoped (${scope.rootRel || 'project root'}). `
        + 'Only artifacts inside the goal folder can be favorited — that is what roll-up curates.',
      'USER_ERROR',
      1,
    );
  }
  const cur = new Set(readFavoritesScopeRel(scope));
  const removing = cur.has(rel);
  // Adds are gated by existence under the goal folder: a scope-relative string
  // alone cannot distinguish an in-goal artifact from a project-level one at the
  // mount root (`README.md`), and favoriting only means something for artifacts
  // the goal owns. Removes are always allowed (the target may have been deleted).
  if (!removing && !existsSync(scope.abs(rel))) {
    throw new SpacesError(
      `Cannot favorite ${incoming}: not an artifact inside this goal folder (${scope.rootRel || 'project root'}). `
        + 'Favorites are goal-scoped — that is what roll-up curates.',
      'USER_ERROR',
      1,
    );
  }
  if (removing) cur.delete(rel);
  else cur.add(rel);
  const next = normalize([...cur]);
  const snapshot: AttachmentSnapshotPlan = !removing && rel.endsWith('.report.json')
    ? await planAttachmentSnapshots(projectDir, scope, rel)
    : { files: [], snapshotSkipped: [] };
  const snapNote = snapshot.files.length > 0 ? ` (+${snapshot.files.length - 1} attachment snapshot${snapshot.files.length - 1 === 1 ? '' : 's'})` : '';
  await writeManifest(projectDir, scope, next, `favorite: ${removing ? '-' : '+'}${rel}${snapNote}`, snapshot.files);
  return { favorites: next.map((r) => scope.rel(r)), snapshotSkipped: snapshot.snapshotSkipped };
}

/**
 * Union-merge a set of favorites into the manifest (reconciliation from browser
 * localStorage). Idempotent: paths already present are skipped and an all-known
 * merge never commits. Returns the updated list as MOUNT-relative paths.
 *
 * LOSSLESS BY DESIGN — no existence gate. Reconciliation migrates a browser's
 * legacy localStorage favorites (OLD FLAT paths) into the goal-keyed manifest.
 * If it ran on a machine whose artifact data had not yet migrated (files still
 * flat at the mount root), an existence check against `goals/<id>/<path>` would
 * find NOTHING and drop EVERY favorite — and the caller then clears localStorage,
 * making the loss permanent. A dead favorite lingering in the manifest is
 * harmless (it just reads back as a path that resolves to nothing until its file
 * arrives via migration); a dropped one is data loss. So we keep them all. The
 * `verifyExists` option is retained for call-signature compatibility but is
 * intentionally NOT honored here — reconciliation must never drop.
 *
 * v1 limitation (stated honestly): a union cannot distinguish "never favorited
 * here" from "un-favorited on another machine before this reconciliation", so a
 * removal made elsewhere before a given browser first reconciles may reappear
 * once. The caller only clears its localStorage key once the manifest provably
 * contains the union, so a mistimed reconcile stays recoverable on the next load.
 */
export async function mergeFavorites(
  projectDir: string,
  scope: ArtifactsScope,
  incoming: string[],
  _opts: { verifyExists?: boolean } = {},
): Promise<string[]> {
  const cur = new Set(readFavoritesScopeRel(scope));
  const added: string[] = [];
  for (const p of incoming) {
    const rel = toScopeRel(scope, p);
    if (!rel) continue; // targets a different goal / outside this scope — never ours
    if (!cur.has(rel)) {
      cur.add(rel);
      added.push(rel);
    }
  }
  const next = normalize([...cur]);
  if (added.length > 0) {
    await writeManifest(projectDir, scope, next, `favorite: reconcile +${added.join(', ')}`.slice(0, 200));
  }
  return next.map((r) => scope.rel(r));
}
