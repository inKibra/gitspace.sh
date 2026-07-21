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
    expect(after.favorites).toEqual([`goals/${goalId}/apps/metronome.gssh.html`]);
    expect(after.snapshotSkipped).toEqual([]);

    // Committed on the branch (would sync); reload persists via re-read.
    expect(g(mountDir, `ls-tree -r --name-only ${wsName}`)).toContain(`goals/${goalId}/.favorites.json`);
    expect(readFavoritesMountRel(scope)).toEqual([`goals/${goalId}/apps/metronome.gssh.html`]);
  });

  it('un-toggles (removes) and commits again', async () => {
    const { scope } = await setup(['reports/x.report.json']);
    await toggleFavorite(projectDir, scope, `goals/${goalId}/reports/x.report.json`);
    const after = await toggleFavorite(projectDir, scope, `goals/${goalId}/reports/x.report.json`);
    expect(after.favorites).toEqual([]);
    expect(readFavoritesScopeRel(scope)).toEqual([]);
  });

  it('rejects favoriting an artifact outside the goal folder', async () => {
    const { scope } = await setup(['reports/x.report.json']);
    await expect(toggleFavorite(projectDir, scope, 'README.md')).rejects.toThrow(/goal/i);
  });
});

describe('toggleFavorite — attachment snapshots (favorited reports freeze their targets)', () => {
  const reportRel = 'reports/quirk.report.json';
  const reportDoc = (attachments: unknown[]): string => `${JSON.stringify({
    kind: 'workflow-quirk', surface: 'test', note: 'n', attachments,
  }, null, 2)}\n`;

  it('snapshots resolvable attachments beside the report, rewrites snapshotRef, one commit with the manifest; dangling refs are skipped, favorite still succeeds', async () => {
    const { scope, mountDir } = await setup(['reports/target.md', 'demos/clip.webm']);
    // A mount-root (project-level) file the goal-relative candidate misses but
    // the as-is fallback finds.
    writeFileSync(join(mountDir, 'root-doc.md'), 'root doc');
    g(mountDir, 'add root-doc.md');
    g(mountDir, '-c user.name=t -c user.email=t@t commit -q -m root-doc');
    // The report: goal-relative ref, old-flat ref, mount-relative fallback ref,
    // and a dangling ref.
    const abs = scope.abs(reportRel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, reportDoc([
      { type: 'tool', ref: 'reports/target.md', label: 'goal-relative' },
      { type: 'tool', ref: 'demos/clip.webm', label: 'old-flat (same rule)' },
      { type: 'tool', ref: 'root-doc.md', label: 'mount-root fallback' },
      { type: 'conversation', ref: 'reports/ghost.md', label: 'dangling' },
    ]));
    g(mountDir, 'add -A');
    g(mountDir, '-c user.name=t -c user.email=t@t commit -q -m report');
    const headBefore = g(mountDir, 'rev-parse HEAD');

    const res = await toggleFavorite(projectDir, scope, `goals/${goalId}/${reportRel}`);
    expect(res.favorites).toEqual([`goals/${goalId}/${reportRel}`]);
    expect(res.snapshotSkipped).toEqual(['reports/ghost.md']);

    // Snapshots live beside the report, inside the goal folder.
    expect(readFileSync(scope.abs('reports/quirk.attachments/target.md'), 'utf8')).toBe('content:reports/target.md');
    expect(readFileSync(scope.abs('reports/quirk.attachments/clip.webm'), 'utf8')).toBe('content:demos/clip.webm');
    expect(readFileSync(scope.abs('reports/quirk.attachments/root-doc.md'), 'utf8')).toBe('root doc');

    // Report JSON gained ADDITIVE snapshotRefs (live refs untouched), on the
    // same report-prefix-relative basis as refs; the dangling one gained none.
    const doc = JSON.parse(readFileSync(abs, 'utf8'));
    expect(doc.attachments[0]).toEqual({ type: 'tool', ref: 'reports/target.md', label: 'goal-relative', snapshotRef: 'reports/quirk.attachments/target.md' });
    expect(doc.attachments[1].snapshotRef).toBe('reports/quirk.attachments/clip.webm');
    expect(doc.attachments[2].snapshotRef).toBe('reports/quirk.attachments/root-doc.md');
    expect(doc.attachments[3].snapshotRef).toBeUndefined();

    // Exactly ONE capture commit: manifest + report rewrite + snapshots together.
    expect(g(mountDir, `rev-list --count ${headBefore}..HEAD`)).toBe('1');
    const committed = g(mountDir, 'show --name-only --format= HEAD').split('\n').filter(Boolean).sort();
    expect(committed).toEqual([
      `goals/${goalId}/.favorites.json`,
      `goals/${goalId}/reports/quirk.attachments/clip.webm`,
      `goals/${goalId}/reports/quirk.attachments/root-doc.md`,
      `goals/${goalId}/reports/quirk.attachments/target.md`,
      `goals/${goalId}/reports/quirk.report.json`,
    ].sort());
  });

  it('is idempotent: unfavorite keeps snapshots; re-favorite makes a manifest-only commit', async () => {
    const { scope, mountDir } = await setup(['reports/target.md']);
    const abs = scope.abs(reportRel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, reportDoc([{ type: 'tool', ref: 'reports/target.md' }]));
    g(mountDir, 'add -A');
    g(mountDir, '-c user.name=t -c user.email=t@t commit -q -m report');

    await toggleFavorite(projectDir, scope, `goals/${goalId}/${reportRel}`);
    const reportAfterFirst = readFileSync(abs, 'utf8');

    // Unfavorite: snapshots are committed history — they stay.
    const un = await toggleFavorite(projectDir, scope, `goals/${goalId}/${reportRel}`);
    expect(un.favorites).toEqual([]);
    expect(existsSync(scope.abs('reports/quirk.attachments/target.md'))).toBe(true);

    // Re-favorite: snapshotRef already present + file exists → no new snapshot
    // churn; the commit touches ONLY the manifest.
    const re = await toggleFavorite(projectDir, scope, `goals/${goalId}/${reportRel}`);
    expect(re.snapshotSkipped).toEqual([]);
    expect(readFileSync(abs, 'utf8')).toBe(reportAfterFirst);
    const committed = g(mountDir, 'show --name-only --format= HEAD').split('\n').filter(Boolean);
    expect(committed).toEqual([`goals/${goalId}/.favorites.json`]);
  });

  it('favoriting a non-report never snapshots; favoriting a malformed report succeeds un-snapshotted', async () => {
    const { scope, mountDir } = await setup(['demos/clip.webm', 'reports/broken.report.json']);
    const r1 = await toggleFavorite(projectDir, scope, `goals/${goalId}/demos/clip.webm`);
    expect(r1.snapshotSkipped).toEqual([]);
    // broken.report.json holds 'content:…' seed text — not JSON.
    const r2 = await toggleFavorite(projectDir, scope, `goals/${goalId}/reports/broken.report.json`);
    expect(r2.favorites).toContain(`goals/${goalId}/reports/broken.report.json`);
    expect(r2.snapshotSkipped).toEqual([]);
    expect(existsSync(scope.abs('reports/broken.attachments'))).toBe(false);
    expect(g(mountDir, 'show --name-only --format= HEAD').split('\n').filter(Boolean)).toEqual([`goals/${goalId}/.favorites.json`]);
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

  it('is LOSSLESS — a legacy favorite whose file is momentarily absent is kept, not dropped', async () => {
    const { scope } = await setup(['apps/a.gssh.html']);
    // reports/ghost.report.json has no file on disk. This models the data-loss
    // bug: reconciliation running BEFORE a machine's artifact migration (files
    // still flat, goal-keyed paths not yet present) must NOT drop the favorite —
    // dropping it, then clearing localStorage, lost it permanently. A dead entry
    // in the manifest is harmless and self-heals when migration lands its file.
    const merged = await mergeFavorites(projectDir, scope, ['apps/a.gssh.html', 'reports/ghost.report.json']);
    expect(merged).toEqual([
      `goals/${goalId}/apps/a.gssh.html`,
      `goals/${goalId}/reports/ghost.report.json`,
    ]);
    // And it is genuinely persisted goal-relative in the manifest.
    expect(readFavoritesScopeRel(scope)).toEqual(['apps/a.gssh.html', 'reports/ghost.report.json']);
  });
});
