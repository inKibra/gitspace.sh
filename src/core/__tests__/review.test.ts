import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createThread } from '../review.js';

describe('review storage prompting', () => {
  let tempRoot: string;
  let workspacePath: string;
  const originalStdinIsTTY = process.stdin.isTTY;
  const originalStdoutIsTTY = process.stdout.isTTY;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'review-storage-'));
    workspacePath = join(tempRoot, 'workspace');
    mkdirSync(workspacePath, { recursive: true });
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
  });

  afterEach(() => {
    mock.restore();
    Object.defineProperty(process.stdin, 'isTTY', { value: originalStdinIsTTY, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: originalStdoutIsTTY, configurable: true });
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('defaults to private storage even when stdin is a TTY', async () => {
    await createThread(
      workspacePath,
      'feature-one',
      'main',
      { kind: 'file', file: 'src/app.ts' },
      'Needs another look.'
    );

    expect(readFileSync(join(workspacePath, '.gitignore'), 'utf-8')).toContain('.gitspace/workspace/');
    expect(
      existsSync(join(workspacePath, '.gitspace', 'workspace', 'feature-one', 'review.json'))
    ).toBe(true);
  });

  it('stores review data in the workspace-local storage tree', async () => {
    const confirm = mock(async () => false);
    mock.module('@inquirer/prompts', () => ({ confirm }));

    await createThread(
      workspacePath,
      'feature-two',
      'main',
      { kind: 'file', file: 'src/app.ts' },
      'Ship this note with the branch.',
      undefined,
      'local',
      { allowPrompt: true }
    );

    expect(confirm).toHaveBeenCalledTimes(0);
    expect(readFileSync(join(workspacePath, '.gitignore'), 'utf-8')).toContain('.gitspace/workspace/');
    expect(existsSync(join(workspacePath, '.gitspace', 'workspace', 'feature-two', 'review.json'))).toBe(true);
  });
});
