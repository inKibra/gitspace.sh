/**
 * `.gitattributes` add/add on roll-up.
 *
 * Reproduces the state that blocked real roll-ups: main and a workspace branch
 * each grew their own `.gitattributes` after diverging, so the merge base has no
 * such file and git reports `CONFLICT (add/add)` — on content whose two sides
 * hold different SUBSETS of one order-independent line set and never disagree
 * about a line.
 */
import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { captureArtifacts, ensureArtifactsMount, ensureArtifactsRepo, rollupArtifacts } from '../artifacts.js';

let root: string;
let previousRoot: string | undefined;
const MB = 1024 * 1024;

function g(dir: string, args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
}

/** A pointer capture, which is what writes a `.gitattributes` line. */
async function captureBigFile(projectDir: string, mount: string, relPath: string): Promise<void> {
  const abs = join(mount, relPath);
  mkdirSync(join(abs, '..'), { recursive: true });
  await Bun.write(abs, Buffer.alloc(3 * MB, 9));
  await captureArtifacts(projectDir, mount, [{ path: relPath, sourceFile: abs }], { message: `capture ${relPath}` });
}

beforeEach(() => {
  previousRoot = process.env.GITSPACE_WORKSPACE_ROOT;
  root = mkdtempSync(join(tmpdir(), 'gs-attrs-union-'));
  process.env.GITSPACE_WORKSPACE_ROOT = root;
});

afterEach(() => {
  if (previousRoot === undefined) delete process.env.GITSPACE_WORKSPACE_ROOT;
  else process.env.GITSPACE_WORKSPACE_ROOT = previousRoot;
  rmSync(root, { recursive: true, force: true });
});

describe('.gitattributes roll-up', () => {
  it('resolves an add/add by union instead of demanding manual curation', async () => {
    const projectDir = join(root, 'proj');
    const repoDir = join(projectDir, '.artifacts.git');
    const aDir = join(projectDir, 'workspaces', 'feat-a');
    const bDir = join(projectDir, 'workspaces', 'feat-b');
    mkdirSync(aDir, { recursive: true });
    mkdirSync(bDir, { recursive: true });

    const aMount = await ensureArtifactsMount(projectDir, aDir, 'feat-a');
    const bMount = await ensureArtifactsMount(projectDir, bDir, 'feat-b');

    // Both branches independently create `.gitattributes` after diverging.
    await captureBigFile(projectDir, aMount, 'evidence/a.bin');
    await captureBigFile(projectDir, bMount, 'evidence/b.bin');

    // The merge base predates both — the precondition for add/add.
    const mergeBase = g(repoDir, ['merge-base', 'main', 'feat-b']);
    expect(() => g(repoDir, ['cat-file', '-e', `${mergeBase}:.gitattributes`])).toThrow();

    // First roll-up puts the file on main as a new file.
    await rollupArtifacts(projectDir, 'feat-a');
    expect(g(repoDir, ['show', 'main:.gitattributes'])).toContain('evidence/a.bin');

    // Second roll-up is the one that used to fail with
    // "has conflicts — curate manually (… CONFLICT (add/add) …)".
    await rollupArtifacts(projectDir, 'feat-b');

    const merged = g(repoDir, ['show', 'main:.gitattributes']).split('\n').filter(Boolean);
    // Union: both sides' lines survive.
    expect(merged.some((l) => l.startsWith('evidence/a.bin'))).toBe(true);
    expect(merged.some((l) => l.startsWith('evidence/b.bin'))).toBe(true);
    // No conflict markers, and every line is a real attribute line.
    expect(merged.some((l) => l.startsWith('<<<<<<<') || l.startsWith('=======') || l.startsWith('>>>>>>>'))).toBe(false);
    for (const line of merged) expect(line).toContain('filter=lfs diff=lfs merge=lfs -text');
  });

  it('still refuses a genuine same-path conflict outside .gitattributes', async () => {
    const projectDir = join(root, 'proj');
    const aDir = join(projectDir, 'workspaces', 'feat-a');
    const bDir = join(projectDir, 'workspaces', 'feat-b');
    mkdirSync(aDir, { recursive: true });
    mkdirSync(bDir, { recursive: true });
    const aMount = await ensureArtifactsMount(projectDir, aDir, 'feat-a');
    const bMount = await ensureArtifactsMount(projectDir, bDir, 'feat-b');

    // Same project-level path, different content, no common ancestor for it:
    // the union driver must NOT apply here.
    await Bun.write(join(aMount, 'reports', 'shared.md'), '# from a\n');
    await captureArtifacts(projectDir, aMount, [{ path: 'reports/shared.md', sourceFile: join(aMount, 'reports/shared.md') }], { message: 'a' });
    await Bun.write(join(bMount, 'reports', 'shared.md'), '# from b\n');
    await captureArtifacts(projectDir, bMount, [{ path: 'reports/shared.md', sourceFile: join(bMount, 'reports/shared.md') }], { message: 'b' });

    await rollupArtifacts(projectDir, 'feat-a');
    await expect(rollupArtifacts(projectDir, 'feat-b')).rejects.toThrow(/conflicts/);
  });

  it('installs the driver on an existing repo, not just a fresh one', async () => {
    const projectDir = join(root, 'proj');
    const repoDir = await ensureArtifactsRepo(projectDir);
    rmSync(join(repoDir, 'info', 'attributes'), { force: true });

    await ensureArtifactsRepo(projectDir);
    expect(await Bun.file(join(repoDir, 'info', 'attributes')).text()).toContain('.gitattributes merge=union');
  });
});
