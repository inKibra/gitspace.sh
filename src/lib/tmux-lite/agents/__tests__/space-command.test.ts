import { afterEach, describe, expect, it, mock } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import gitSpaceSpaceCommandExtension, { executeSpaceCommand, getSpaceCommandArgumentCompletions } from '../extensions/space-command.js';

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
  it('suggests review subcommands', () => {
    expect(getSpaceCommandArgumentCompletions('review l')?.map((item) => item.label)).toEqual(['list']);
  });

  it('suggests command-aware options for events tail', () => {
    expect(getSpaceCommandArgumentCompletions('events tail --e')?.map((item) => item.label)).toEqual(['--event', '--event-id']);
  });

  it('suggests bundle edit flags after the leaf command', () => {
    expect(getSpaceCommandArgumentCompletions('bundle edit ')?.map((item) => item.label)).toEqual([
      '--input',
      '--secret',
      '--secret-unset',
      '--confirm',
    ]);
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

describe('gitSpaceSpaceCommandExtension', () => {
  it('renders command output as a transcript message instead of editor text', async () => {
    tempHomeDir = mkdtempSync(join(tmpdir(), 'gitspace-space-command-extension-'));
    process.env.HOME = tempHomeDir;

    const workspacePath = join(tempHomeDir, 'gitspace', 'demo', 'workspaces', 'ws-1');
    mkdirSync(workspacePath, { recursive: true });

    const sendMessage = mock(() => {});
    const setEditorText = mock(() => {});
    const commandHandlers = new Map<string, (argsText: string, ctx: any) => Promise<void>>();
    const pi = {
      registerCommand: mock((name: string, options: { handler: (argsText: string, ctx: any) => Promise<void> }) => {
        commandHandlers.set(name, options.handler);
      }),
      exec: mock(async () => ({ stdout: 'review rows', stderr: '', code: 0, killed: false })),
      sendMessage,
    };

    gitSpaceSpaceCommandExtension(pi as any);
    await commandHandlers.get('space')?.('review list', {
      cwd: workspacePath,
      ui: { setEditorText },
    });

    expect(setEditorText).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0][0]).toEqual({
      customType: 'space-command',
      content: 'Output from `space review list` in the current workspace:\n\nreview rows',
      display: true,
      attribution: 'agent',
    });
  });
});
