import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  clearSetupMarker,
  createEmptyWorkspaceLockState,
  hasSetupBeenRun,
  readWorkspaceLockState,
  writeWorkspaceLockState,
  getWorkspaceLockPath,
} from '../workspace-state';

function makeWorkspaceDir(): string {
  const dir = join(tmpdir(), `workspace-state-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('workspace-state lock parsing', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) {
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    dirs.length = 0;
  });

  it('treats invalid json lock as empty state', () => {
    const workspacePath = makeWorkspaceDir();
    dirs.push(workspacePath);

    writeFileSync(getWorkspaceLockPath(workspacePath), 'not-json', 'utf-8');

    expect(readWorkspaceLockState(workspacePath)).toBeNull();
    expect(hasSetupBeenRun(workspacePath)).toBe(false);
  });

  it('writes and reads structured lock state', () => {
    const workspacePath = makeWorkspaceDir();
    dirs.push(workspacePath);

    const state = createEmptyWorkspaceLockState();
    state.bundle = {
      bundleHash: 'abc123',
      stepFingerprints: {
        'input:REGION': 'f1',
      },
    };
    state.setup.status = 'success';
    state.setup.ranAt = new Date().toISOString();

    writeWorkspaceLockState(workspacePath, state);
    const parsed = readWorkspaceLockState(workspacePath);

    expect(parsed?.version).toBe(1);
    expect(parsed?.bundle?.bundleHash).toBe('abc123');
    expect(hasSetupBeenRun(workspacePath)).toBe(true);

    const raw = readFileSync(getWorkspaceLockPath(workspacePath), 'utf-8');
    expect(raw).toContain('"version": 1');
  });

  it('clears lock marker file', () => {
    const workspacePath = makeWorkspaceDir();
    dirs.push(workspacePath);

    const marker = getWorkspaceLockPath(workspacePath);
    writeFileSync(marker, '{}', 'utf-8');
    expect(existsSync(marker)).toBe(true);

    clearSetupMarker(workspacePath);
    expect(existsSync(marker)).toBe(false);
  });
});
