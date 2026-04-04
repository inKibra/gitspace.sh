import { afterEach, describe, expect, it, mock } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeSpaceCommand, getSpaceCommandArgumentCompletions } from '../extensions/space-command.js';

let tempHomeDir: string | null = null;
const originalHome = process.env.HOME;

afterEach(() => {
  if (tempHomeDir) {
    rmSync(tempHomeDir, { recursive: true, force: true });
    tempHomeDir = null;
  }
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
});

describe('getSpaceCommandArgumentCompletions', () => {
  it('suggests renamed review list subcommand', () => {
    expect(getSpaceCommandArgumentCompletions('review l')?.map((item) => item.label)).toEqual(['list']);
  });
});

describe('executeSpaceCommand', () => {
  it('runs workspace-scoped space commands through env with the current workspace context', async () => {
    tempHomeDir = mkdtempSync(join(tmpdir(), 'gitspace-space-command-'));
    process.env.HOME = tempHomeDir;

    const workspacePath = join(tempHomeDir, 'gitspace', 'demo', 'workspaces', 'ws-1');
    mkdirSync(workspacePath, { recursive: true });

    const exec = mock(async () => ({ stdout: '{"threads":[]}', stderr: '', code: 0, killed: false }));
    const output = await executeSpaceCommand(
      { exec },
      { cwd: workspacePath },
      ['review', 'list', '--format', 'json'],
      ['bun', '/tmp/dev repo/src/index.ts'],
    );

    expect(exec).toHaveBeenCalledTimes(1);
    expect((exec as any).mock.calls[0]).toEqual([
      'env',
      [
        'GSSH_SESSION_MODE=workspace',
        'GSSH_SPACE_PROJECT=demo',
        'GSSH_SPACE_WORKSPACE=ws-1',
        'bun',
        '/tmp/dev repo/src/index.ts',
        'space',
        'review',
        'list',
        '--format',
        'json',
      ],
      { cwd: workspacePath },
    ]);
    expect(output).toContain('space review list --format json');
    expect(output).toContain('{"threads":[]}');
  });

  it('rejects explicit workspace overrides', async () => {
    const exec = mock(async () => ({ stdout: '', stderr: '', code: 0, killed: false }));

    await expect(
      executeSpaceCommand({ exec }, { cwd: '/tmp/anywhere' }, ['review', 'list', '--project', 'other'])
    ).rejects.toThrow('/space always targets the current workspace');
    expect(exec).not.toHaveBeenCalled();
  });
});
