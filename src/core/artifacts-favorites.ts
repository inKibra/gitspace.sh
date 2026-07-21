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

import { existsSync, readFileSync } from 'fs';
import { SpacesError } from '../types/errors.js';
import { captureArtifacts, isGoalScopedPath, type ArtifactsScope } from './artifacts.js';

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

async function writeManifest(projectDir: string, scope: ArtifactsScope, next: string[], message: string): Promise<void> {
  const manifest: FavoritesManifest = { schema: FAVORITES_SCHEMA_V1, favorites: next };
  const json = `${JSON.stringify(manifest, null, 2)}\n`;
  await captureArtifacts(projectDir, scope.mountDir, [{ path: favoritesManifestMountRel(scope), content: json }], { message });
}

/**
 * Toggle one favorite (add if absent, remove if present). Commits the manifest
 * and returns the updated list as MOUNT-relative paths (so the client just
 * replaces its set). `incoming` is a mount-relative artifact path.
 */
export async function toggleFavorite(projectDir: string, scope: ArtifactsScope, incoming: string): Promise<string[]> {
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
  await writeManifest(projectDir, scope, next, `favorite: ${removing ? '-' : '+'}${rel}`);
  return next.map((r) => scope.rel(r));
}

/**
 * Union-merge a set of favorites into the manifest (reconciliation from browser
 * localStorage). Idempotent: paths already present are skipped and an all-known
 * merge never commits. `verifyExists` (default true) drops paths whose target
 * does not exist under the scope, so a dead old-basis path never enters the
 * manifest. Returns the updated list as MOUNT-relative paths.
 *
 * v1 limitation (stated honestly): a union cannot distinguish "never favorited
 * here" from "un-favorited on another machine before this reconciliation", so a
 * removal made elsewhere before a given browser first reconciles may reappear
 * once. After a browser reconciles, its localStorage key is cleared, so this is
 * a one-time per-browser effect, not an ongoing resurrection.
 */
export async function mergeFavorites(
  projectDir: string,
  scope: ArtifactsScope,
  incoming: string[],
  opts: { verifyExists?: boolean } = {},
): Promise<string[]> {
  const verifyExists = opts.verifyExists ?? true;
  const cur = new Set(readFavoritesScopeRel(scope));
  const added: string[] = [];
  for (const p of incoming) {
    const rel = toScopeRel(scope, p);
    if (!rel) continue;
    if (verifyExists && !existsSync(scope.abs(rel))) continue; // skip dead paths
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
