import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { Command } from 'commander';

const mockSpawn = mock(() => new EventEmitter() as EventEmitter & { once: EventEmitter['once'] });
const mockEnsureOmpInstalled = mock(async () => '/tmp/gitspace/.pi/node_modules/.bin/omp');
const mockUseSessionContext = mock(() => ({ project: 'acme', workspace: 'feature-1' }));

mock.module('node:child_process', () => ({
  spawn: mockSpawn,
}));

mock.module('../../error.js', () => ({
  withErrorHandler: <T extends unknown[]>(handler: (...args: T) => Promise<void>) => handler,
}));

mock.module('../../workspace-context.js', () => ({
  useSessionContext: mockUseSessionContext,
  getWorkspacePath: (project: string, workspace: string) => `/tmp/${project}/${workspace}`,
}));

mock.module('../../../lib/tmux-lite/agents/pi-runtime.js', () => ({
  ensureOmpInstalled: mockEnsureOmpInstalled,
}));

mock.module('../../../utils/logger.js', () => ({
  logger: {
    error: () => undefined,
    log: () => undefined,
  },
}));

const { registerSpaceCommands } = await import('../space.js');

function makeProgram(): Command {
  const program = new Command();
  program.name('gssh');
  registerSpaceCommands(program);
  return program;
}

describe('registerSpaceCommands commit', () => {
  const originalSessionMode = process.env.GSSH_SESSION_MODE;
  const originalExit = process.exit;

  beforeEach(() => {
    process.env.GSSH_SESSION_MODE = 'workspace';
    mockSpawn.mockReset();
    mockEnsureOmpInstalled.mockReset();
    mockUseSessionContext.mockReset();
    mockEnsureOmpInstalled.mockResolvedValue('/tmp/gitspace/.pi/node_modules/.bin/omp');
    mockUseSessionContext.mockReturnValue({ project: 'acme', workspace: 'feature-1' });
    process.exit = originalExit;
  });

  afterEach(() => {
    process.exit = originalExit;
    if (originalSessionMode === undefined) {
      delete process.env.GSSH_SESSION_MODE;
    } else {
      process.env.GSSH_SESSION_MODE = originalSessionMode;
    }
  });

  test('launches omp commit in the current workspace', async () => {
    mockSpawn.mockImplementation(() => {
      const child = new EventEmitter() as EventEmitter & { once: EventEmitter['once'] };
      queueMicrotask(() => child.emit('close', 0, null));
      return child;
    });

    const program = makeProgram();
    await program.parseAsync(['space', 'commit'], { from: 'user' });

    expect(mockEnsureOmpInstalled).toHaveBeenCalledTimes(1);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const firstCall = mockSpawn.mock.calls[0];
    expect(firstCall).toBeDefined();
    const [command, args, options] = firstCall as unknown as [string, string[], { cwd: string; stdio: string; env: NodeJS.ProcessEnv }];
    expect(command).toBe('/tmp/gitspace/.pi/node_modules/.bin/omp');
    expect(args).toEqual(['commit']);
    expect(options).toEqual(expect.objectContaining({
      cwd: '/tmp/acme/feature-1',
      stdio: 'inherit',
      env: process.env,
    }));
  });

  test('surfaces install/runtime failures when managed omp is unavailable', async () => {
    mockEnsureOmpInstalled.mockRejectedValue(new Error('missing omp'));
    const program = makeProgram();

    await expect(program.parseAsync(['space', 'commit'], { from: 'user' })).rejects.toThrow(/missing omp/i);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  test('propagates omp commit exit codes', async () => {
    mockSpawn.mockImplementation(() => {
      const child = new EventEmitter() as EventEmitter & { once: EventEmitter['once'] };
      queueMicrotask(() => child.emit('close', 7, null));
      return child;
    });

    process.exit = ((code?: number) => {
      throw new Error(`EXIT:${code}`);
    }) as typeof process.exit;

    const program = makeProgram();
    await expect(program.parseAsync(['space', 'commit'], { from: 'user' })).rejects.toThrow('EXIT:7');
  });
});
