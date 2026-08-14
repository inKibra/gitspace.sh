/**
 * Scanner: what counts as a workspace.
 *
 * A removed workspace used to come back as a ghost row in the board's code
 * lane. Two halves produced it — `ensureArtifactsMount` re-creating the
 * directory from nothing (guarded in artifacts.ts), and this scanner treating
 * any directory under `workspaces/` as a workspace. This pins the second half.
 */
import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { getProjectWorkspaces } from '../workspace-scanner.js';

let root: string;
let previousRoot: string | undefined;

beforeEach(() => {
  previousRoot = process.env.GITSPACE_WORKSPACE_ROOT;
  root = mkdtempSync(join(tmpdir(), 'gs-scanner-'));
  process.env.GITSPACE_WORKSPACE_ROOT = root;
});

afterEach(() => {
  if (previousRoot === undefined) delete process.env.GITSPACE_WORKSPACE_ROOT;
  else process.env.GITSPACE_WORKSPACE_ROOT = previousRoot;
  rmSync(root, { recursive: true, force: true });
});

describe('scanProjectWorkspaces', () => {
  it('lists a real workspace and ignores an artifacts-only remnant', async () => {
    const workspaces = join(root, 'proj', 'workspaces');

    // A real workspace: a code checkout, so it has `.git`.
    const real = join(workspaces, 'feat-real');
    mkdirSync(real, { recursive: true });
    execFileSync('git', ['-C', real, 'init', '-q', '--initial-branch=main']);
    writeFileSync(join(real, 'README.md'), '# real\n');

    // The ghost, exactly as found on disk: the directory survives holding
    // nothing but the artifacts mount, whose branch outlives the workspace by
    // design. `ls` shows it as empty because the remnant is a dotfile.
    const ghost = join(workspaces, 'feat-removed');
    mkdirSync(join(ghost, '.gitspace', 'artifacts'), { recursive: true });

    const found = await getProjectWorkspaces('proj');
    const names = found.map((w) => w.name);
    expect(names).toContain('feat-real');
    expect(names).not.toContain('feat-removed');
  });

  it('ignores a wholly empty directory too', async () => {
    const workspaces = join(root, 'proj', 'workspaces');
    mkdirSync(join(workspaces, 'leftover'), { recursive: true });
    expect((await getProjectWorkspaces('proj')).map((w) => w.name)).not.toContain('leftover');
  });
});
