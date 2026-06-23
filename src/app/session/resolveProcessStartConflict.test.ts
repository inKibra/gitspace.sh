import { describe, expect, it, mock } from 'bun:test';
import { PortConflictError } from '../../lib/processes/port-conflicts.js';
import { ProcessStartCancelledError, promptToResolveProcessStartConflict } from './resolveProcessStartConflict.js';

describe('promptToResolveProcessStartConflict', () => {
  it('resolves the conflicting process when confirmed', async () => {
    const resolveConflict = mock(() => Promise.resolve());
    const showConfirm = mock(({ onConfirm }: { onConfirm: () => void | Promise<void> }) => {
      void onConfirm();
    });
    const error = new PortConflictError('web', [{ port: 3000, protocol: 'http', pid: 1234, command: 'node' }]);

    const resolved = await promptToResolveProcessStartConflict({
      error,
      showConfirm,
      resolveConflict,
    });

    expect(resolved).toBe(true);
    expect(resolveConflict).toHaveBeenCalledTimes(1);
  });

  it('supports cancellation marker', () => {
    expect(new ProcessStartCancelledError()).toBeInstanceOf(Error);
  });
});
