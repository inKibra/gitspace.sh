import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createThread, readReviewSession } from '../review.js';

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

describe('review legacy fallback', () => {
  let tempRoot: string;
  let workspacePath: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'review-legacy-'));
    workspacePath = join(tempRoot, 'workspace');
    mkdirSync(workspacePath, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('reads legacy review notes when the new review.json path is absent', () => {
    const legacyDir = join(workspacePath, '.gitspace', 'review', 'feature-legacy');
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(
      join(legacyDir, 'notes.json'),
      JSON.stringify({
        version: '1.0',
        workspaceName: 'feature-legacy',
        baseBranch: 'main',
        prNumber: null,
        threads: [
          {
            id: 'thread-1',
            target: { kind: 'file', file: 'src/app.ts' },
            resolved: false,
            comments: [
              {
                id: 'comment-1',
                threadId: 'thread-1',
                body: 'legacy note',
                author: 'local',
                createdAt: '2026-01-01T00:00:00.000Z',
              },
            ],
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }),
      'utf-8',
    );

    const session = readReviewSession(workspacePath, 'feature-legacy', 'main');
    expect(session.threads).toHaveLength(1);
    expect(session.threads[0]?.comments[0]?.body).toBe('legacy note');
    expect(existsSync(join(workspacePath, '.gitspace', 'workspace', 'feature-legacy', 'review.json'))).toBe(false);
  });
});
