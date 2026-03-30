import { describe, expect, it, mock } from 'bun:test';
import { signalProcessTree, signalSubprocessTree } from './process-tree.js';

describe('process tree signaling', () => {
  it('targets the actual process group before the direct pid', () => {
    const originalKill = process.kill;
    const killMock = mock((pid: number, _signal: NodeJS.Signals) => {
      if (pid !== -4321) {
        throw new Error(`unexpected pid ${pid}`);
      }
      return true;
    });
    process.kill = killMock as typeof process.kill;

    try {
      expect(signalProcessTree(1234, 'SIGKILL', () => 4321)).toBe(true);
      expect(killMock).toHaveBeenCalledTimes(1);
      expect(killMock).toHaveBeenCalledWith(-4321, 'SIGKILL');
    } finally {
      process.kill = originalKill;
    }
  });

  it('falls back to the subprocess pid when process-group signaling fails', () => {
    const originalKill = process.kill;
    const killMock = mock((pid: number, _signal: NodeJS.Signals) => {
      if (pid === -4321) {
        throw new Error('group missing');
      }
      if (pid === -1234) {
        throw new Error('legacy group missing');
      }
      if (pid !== 1234) {
        throw new Error(`unexpected pid ${pid}`);
      }
      return true;
    });
    process.kill = killMock as typeof process.kill;

    try {
      expect(signalProcessTree(1234, 'SIGTERM', () => 4321)).toBe(true);
      expect(killMock).toHaveBeenCalledTimes(3);
      expect(killMock).toHaveBeenNthCalledWith(1, -4321, 'SIGTERM');
      expect(killMock).toHaveBeenNthCalledWith(2, -1234, 'SIGTERM');
      expect(killMock).toHaveBeenNthCalledWith(3, 1234, 'SIGTERM');
    } finally {
      process.kill = originalKill;
    }
  });

  it('falls back to subprocess.kill when process.kill cannot signal either pid', () => {
    const originalKill = process.kill;
    const killMock = mock((_pid: number, _signal: NodeJS.Signals) => {
      throw new Error('no such process');
    });
    process.kill = killMock as typeof process.kill;
    const procKill = mock(() => undefined);

    try {
      expect(signalSubprocessTree({ pid: 1234, kill: procKill }, 'SIGKILL', () => 4321)).toBe(true);
      expect(killMock).toHaveBeenCalledTimes(3);
      expect(procKill).toHaveBeenCalledTimes(1);
      expect(procKill).toHaveBeenCalledWith('SIGKILL');
    } finally {
      process.kill = originalKill;
    }
  });
});
