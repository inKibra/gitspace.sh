/**
 * Renamed files must diff as renames, not as whole new files.
 *
 * Rename detection needs BOTH paths in the pathspec. A caller that opens a file
 * from the repo tree has no `prevFilePath` — only the changed-file list carries
 * it — and `git diff -- <newPath>` then reports `new file mode` with every line
 * an addition. Measured on a 200-line file with 1 changed line: 43 lines of
 * patch with the old path, 206 without it.
 */
import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { getWorkspaceFileDiff, getWorkspaceFileVersions } from '../git.js';

let repo: string;

const OLD_PATH = 'src/old-name.ts';
const NEW_PATH = 'src/new-name.ts';

function g(...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'gs-rename-diff-'));
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 'test@gitspace.sh');
  g('config', 'user.name', 'test');
  mkdirSync(join(repo, 'src'), { recursive: true });
  // Large enough that a whole-file diff is unmistakable next to a 1-line change.
  writeFileSync(join(repo, OLD_PATH), Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join('\n') + '\n');
  g('add', '-A');
  g('commit', '-qm', 'base');

  g('checkout', '-q', '-b', 'feature');
  g('mv', OLD_PATH, NEW_PATH);
  const lines = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`);
  lines[9] = 'line 10 CHANGED';
  writeFileSync(join(repo, NEW_PATH), lines.join('\n') + '\n');
  g('add', '-A');
  g('commit', '-qm', 'rename and edit one line');
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('getWorkspaceFileDiff on a rename', () => {
  it('produces a rename patch when the caller knows the old path', async () => {
    const { diff } = await getWorkspaceFileDiff(repo, 'main', NEW_PATH, OLD_PATH);
    expect(diff).toContain(`rename from ${OLD_PATH}`);
    expect(diff).toContain(`rename to ${NEW_PATH}`);
    expect(diff).not.toContain('new file mode');
  });

  it('produces a rename patch even when the caller does NOT know the old path', async () => {
    // The tree-opened case: this is what showed the whole file.
    const { diff } = await getWorkspaceFileDiff(repo, 'main', NEW_PATH);
    expect(diff).toContain(`rename from ${OLD_PATH}`);
    expect(diff).toContain(`rename to ${NEW_PATH}`);
    expect(diff).not.toContain('new file mode');
  });

  it('shows the changed line, not 200 additions', async () => {
    const { diff } = await getWorkspaceFileDiff(repo, 'main', NEW_PATH);
    const added = diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++'));
    expect(added).toEqual(['+line 10 CHANGED']);
    // Whole-file output was 206 lines; a rename patch is a fraction of that.
    expect(diff.split('\n').length).toBeLessThan(60);
  });

  it('still diffs a plain modification with no rename in the branch', async () => {
    g('checkout', '-q', 'main');
    g('checkout', '-q', '-b', 'plain');
    writeFileSync(join(repo, OLD_PATH), 'only line\n');
    g('add', '-A');
    g('commit', '-qm', 'modify');

    const { diff } = await getWorkspaceFileDiff(repo, 'main', OLD_PATH);
    expect(diff).toContain('+only line');
    expect(diff).not.toContain('rename from');
  });
});

describe('getWorkspaceFileVersions on a rename', () => {
  it('reads the old side from the pre-rename path without being told it', async () => {
    const { oldContents, newContents } = await getWorkspaceFileVersions(repo, 'main', NEW_PATH);
    // Without resolution the old side is null (the new path does not exist at the
    // merge base), which renders the file as entirely added.
    expect(oldContents).not.toBeNull();
    expect(oldContents).toContain('line 10\n');
    expect(newContents).toContain('line 10 CHANGED');
  });
});
