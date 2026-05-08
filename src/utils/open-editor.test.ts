import { afterEach, describe, expect, it, mock } from 'bun:test';

const mockCheckCommandExists = mock(async (_command: string) => false);
const mockSpawn = mock(() => ({ unref: mock(() => undefined) }));
const actualChildProcess = await import('node:child_process');

mock.module('./deps.js', () => ({
  checkCommandExists: mockCheckCommandExists,
}));

mock.module('child_process', () => ({
  ...actualChildProcess,
  spawn: mockSpawn,
}));

const { listAvailableEditors, openWorkspaceInEditor } = await import('./open-editor.js');

afterEach(() => {
  mockCheckCommandExists.mockReset();
  mockSpawn.mockReset();
  mockSpawn.mockImplementation(() => ({ unref: mock(() => undefined) }));
});

describe('open-editor utility', () => {
  it('lists only detected editor CLIs in preferred order', async () => {
    mockCheckCommandExists.mockImplementation(async (command: string) => command === 'cursor' || command === 'zeditor');

    await expect(listAvailableEditors()).resolves.toEqual([
      {
        id: 'cursor',
        label: 'Cursor',
        command: 'cursor',
        description: 'Open workspace with Cursor',
      },
      {
        id: 'zed',
        label: 'Zed',
        command: 'zeditor',
        description: 'Open workspace with Zed',
      },
    ]);
  });

  it('returns a helpful error when the selected editor is unavailable', async () => {
    mockCheckCommandExists.mockResolvedValue(false);

    await expect(openWorkspaceInEditor('vscode', '/tmp/demo')).resolves.toEqual({
      ok: false,
      message: 'VS Code is not installed on this machine or its CLI is not available in PATH.',
    });
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('spawns the selected editor CLI against the workspace path', async () => {
    mockCheckCommandExists.mockImplementation(async (command: string) => command === 'code');

    await expect(openWorkspaceInEditor('vscode', '/tmp/demo')).resolves.toEqual({ ok: true });
    expect(mockSpawn).toHaveBeenCalledWith('code', ['/tmp/demo'], {
      cwd: '/tmp/demo',
      detached: true,
      stdio: 'ignore',
    });
  });
});
