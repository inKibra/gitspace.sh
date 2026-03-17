import { describe, expect, it, mock } from 'bun:test';
import { executeSafeRefresh } from './remote-refresh';

describe('executeSafeRefresh', () => {
  it('swallows refresh failures and reports a crash log path', async () => {
    const onError = mock((_message: string) => {});
    const logError = mock((_message: string) => {});

    await executeSafeRefresh({
      refresh: async () => {
        throw new Error('network dropped');
      },
      onError,
      writeLog: mock(() => '/tmp/gssh-crash.log'),
      logError,
      context: { machineId: 'machine-1' },
    });

    expect(onError).toHaveBeenCalledWith('network dropped\nCrash log: /tmp/gssh-crash.log');
    expect(logError).toHaveBeenCalled();
  });

  it('does nothing on successful refresh', async () => {
    const onError = mock((_message: string) => {});

    await executeSafeRefresh({
      refresh: async () => {},
      onError,
    });

    expect(onError).not.toHaveBeenCalled();
  });
});
