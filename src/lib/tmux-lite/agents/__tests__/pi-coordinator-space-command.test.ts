import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const originalHome = process.env.HOME;
const tempHome = mkdtempSync(join(tmpdir(), 'pi-space-home-'));
const workspacePath = join(tempHome, 'gitspace', 'test-project', 'workspaces', 'test-workspace');
mkdirSync(workspacePath, { recursive: true });

const mockExecCommand = mock(async (_command: string, _args: string[], _cwd: string, _options?: unknown) => ({
  stdout: 'Project: test-project\nWorkspace: test-workspace',
  stderr: '',
  code: 0,
}));

mock.module('@oh-my-pi/pi-coding-agent/exec/exec', () => ({
  execCommand: mockExecCommand,
}));

const { PiCoordinator } = await import('../pi-coordinator.js');

beforeAll(() => {
  process.env.HOME = tempHome;
});

afterAll(() => {
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  rmSync(tempHome, { recursive: true, force: true });
  mock.restore();
});

describe('PiCoordinator runSpaceCommand', () => {
  it('executes workspace-scoped /space commands without sending them to the model', async () => {
    mockExecCommand.mockReset();
    mockExecCommand.mockImplementation(async (_command: string, _args: string[], _cwd: string, _options?: unknown) => ({
      stdout: 'Project: test-project\nWorkspace: test-workspace',
      stderr: '',
      code: 0,
    }));

    const coordinator = new PiCoordinator();
    const output = await coordinator.runSpaceCommand({
      workspaceId: 'test:ws',
      workspaceName: 'test-workspace',
      workspacePath,
      projectName: 'test-project',
    }, 'context');

    expect(mockExecCommand).toHaveBeenCalledTimes(1);
    const [command, args, cwd] = mockExecCommand.mock.calls[0];
    expect(command).toBe('env');
    expect(args).toEqual(expect.arrayContaining([
      'GSSH_SESSION_MODE=workspace',
      'GSSH_SPACE_PROJECT=test-project',
      'GSSH_SPACE_WORKSPACE=test-workspace',
      'space',
      'context',
    ]));
    expect(cwd).toBe(workspacePath);
    expect(output).toContain('Output from `space context`');
    expect(output).toContain('Workspace: test-workspace');
  });
});
