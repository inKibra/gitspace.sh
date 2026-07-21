/**
 * Artifact favorites — durable, syncable curation manifest.
 *
 * Tested against real git in temp dirs: manifest lands goal-relative inside the
 * goal folder, commit-on-toggle so it would sync, reload persists via re-read
 * (not localStorage), and localStorage reconciliation unions + path-translates
 * across the old flat basis and the new mount-relative basis, idempotently.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execSync } from 'child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { artifactsScope, ensureArtifactsMount, type ArtifactsScope } from '../artifacts.js';
import {
  FAVORITES_SCHEMA_V1,
  favoritesManifestMountRel,
  mergeFavorites,
  readFavoritesMountRel,
  readFavoritesScopeRel,
  toggleFavorite,
} from '../artifacts-favorites.js';

let projectDir: string;
const goalId = 'goal-metronome-7f3';
const wsName = 'feat-metronome';
const wsDir = (): string => join(projectDir, 'workspaces', wsName);
const g = (cwd: string, args: string): string =>
  execSync(`git -C ${JSON.stringify(cwd)} ${args}`, { encoding: 'utf8' }).trim();

/** Mount a workspace whose goal.json names `goalId`, seed real goal artifacts. */
async function setup(seed: string[]): Promise<{ scope: ArtifactsScope; mountDir: string }> {
  mkdirSync(join(wsDir(), '.gitspace', 'workspace', wsName), { recursive: true });
  writeFileSync(join(wsDir(), '.gitspace', 'workspace', wsName, 'goal.json'), JSON.stringify({ id: goalId }));
  const mountDir = await ensureArtifactsMount(projectDir, wsDir(), wsName);
  const scope = artifactsScope(wsDir());
  for (const rel of seed) {
    const abs = scope.abs(rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, `content:${rel}`);
  }
  if (seed.length) {
    g(mountDir, 'add -A');
    g(mountDir, '-c user.name=t -c user.email=t@t commit -q -m seed');
  }
  return { scope, mountDir };
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'gs-favs-'));
});
afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

describe('toggleFavorite', () => {
  it('writes a goal-relative, versioned manifest committed inside the goal folder', async () => {
    const { scope, mountDir } = await setup(['apps/metronome.gssh.html']);
    const after = await toggleFavorite(projectDir, scope, `goals/${goalId}/apps/metronome.gssh.html`);

    // Manifest location + basis.
    expect(favoritesManifestMountRel(scope)).toBe(`goals/${goalId}/.favorites.json`);
    const doc = JSON.parse(readFileSync(scope.abs('.favorites.json'), 'utf8'));
    expect(doc.schema).toBe(FAVORITES_SCHEMA_V1);
    expect(doc.favorites).toEqual(['apps/metronome.gssh.html']); // GOAL-relative, not mount-relative
    // Returns mount-relative for the UI.
    expect(after).toEqual([`goals/${goalId}/apps/metronome.gssh.html`]);

    // Committed on the branch (would sync); reload persists via re-read.
    expect(g(mountDir, `ls-tree -r --name-only ${wsName}`)).toContain(`goals/${goalId}/.favorites.json`);
    expect(readFavoritesMountRel(scope)).toEqual([`goals/${goalId}/apps/metronome.gssh.html`]);
  });

  it('un-toggles (removes) and commits again', async () => {
    const { scope } = await setup(['reports/x.report.json']);
    await toggleFavorite(projectDir, scope, `goals/${goalId}/reports/x.report.json`);
    const after = await toggleFavorite(projectDir, scope, `goals/${goalId}/reports/x.report.json`);
    expect(after).toEqual([]);
    expect(readFavoritesScopeRel(scope)).toEqual([]);
  });

  it('rejects favoriting an artifact outside the goal folder', async () => {
    const { scope } = await setup(['reports/x.report.json']);
    await expect(toggleFavorite(projectDir, scope, 'README.md')).rejects.toThrow(/goal/i);
  });
});

describe('mergeFavorites (localStorage reconciliation)', () => {
  it('unions old-flat + mount-relative bases into one goal-relative set, deduped', async () => {
    const { scope } = await setup(['apps/a.gssh.html', 'reports/r.report.json', 'demos/d.webm']);
    // Manifest already has one favorite (from another machine).
    await toggleFavorite(projectDir, scope, `goals/${goalId}/demos/d.webm`);

    // localStorage from two browsers: old flat basis AND new mount-relative basis
    // that overlaps demos/d.webm — the union must translate + dedup.
    const merged = await mergeFavorites(projectDir, scope, [
      'apps/a.gssh.html', // old flat basis
      'reports/r.report.json', // old flat basis
      `goals/${goalId}/demos/d.webm`, // new mount-relative, already present
    ]);
    const doc = JSON.parse(readFileSync(scope.abs('.favorites.json'), 'utf8'));
    expect(doc.favorites).toEqual(['apps/a.gssh.html', 'demos/d.webm', 'reports/r.report.json']);
    expect(merged).toEqual([
      `goals/${goalId}/apps/a.gssh.html`,
      `goals/${goalId}/demos/d.webm`,
      `goals/${goalId}/reports/r.report.json`,
    ]);
  });

  it('is idempotent — a second merge of the same set makes no new commit', async () => {
    const { scope, mountDir } = await setup(['apps/a.gssh.html']);
    await mergeFavorites(projectDir, scope, ['apps/a.gssh.html']);
    const head1 = g(mountDir, 'rev-parse HEAD');
    await mergeFavorites(projectDir, scope, ['apps/a.gssh.html']);
    const head2 = g(mountDir, 'rev-parse HEAD');
    expect(head2).toBe(head1);
  });

  it('skips dead paths (verifyExists) so the manifest never stores a missing target', async () => {
    const { scope } = await setup(['apps/a.gssh.html']);
    const merged = await mergeFavorites(projectDir, scope, ['apps/a.gssh.html', 'reports/ghost.report.json']);
    expect(merged).toEqual([`goals/${goalId}/apps/a.gssh.html`]);
  });
});
