import { describe, expect, it, mock } from 'bun:test';

const mockResolvePortConflict = mock(() => Promise.resolve());

class MockPortConflictError extends Error {
  code = 'PORT_CONFLICT' as const;
  conflicts;
  constructor() {
    super('port conflict');
    this.name = 'PortConflictError';
    this.conflicts = [{ port: 3000, protocol: 'http' as const, pid: 1234, command: 'node' }];
  }
}

const realPorts = await import('../../lib/processes/ports.js');
mock.module('../../lib/processes/ports.js', () => ({
  ...realPorts,
  PortConflictError: MockPortConflictError,
  resolvePortConflict: mockResolvePortConflict,
}));

const { ProcessStartCancelledError, promptToResolveProcessStartConflict } = await import('./resolveProcessStartConflict.js');

describe('promptToResolveProcessStartConflict', () => {
  it('resolves the conflicting process when confirmed', async () => {
    mockResolvePortConflict.mockReset();
    const showConfirm = mock(({ onConfirm }: { onConfirm: () => void | Promise<void> }) => {
      void onConfirm();
    });

    const resolved = await promptToResolveProcessStartConflict({
      error: new MockPortConflictError(),
      showConfirm,
    });

    expect(resolved).toBe(true);
    expect(mockResolvePortConflict).toHaveBeenCalledTimes(1);
  });

  it('supports cancellation marker', () => {
    expect(new ProcessStartCancelledError()).toBeInstanceOf(Error);
  });
});
