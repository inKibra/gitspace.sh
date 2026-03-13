import { describe, expect, it } from 'bun:test';
import { redactArgv } from './crash-log.js';

describe('redactArgv', () => {
  it('redacts sensitive flag values passed as separate argv entries', () => {
    expect(redactArgv([
      'bun',
      'src/index.ts',
      'machine',
      'enroll',
      '--invite',
      'secret-token',
      '--unlock-token',
      'unlock-me',
      '--workspace-id',
      'ws_123',
    ])).toEqual([
      'bun',
      'src/index.ts',
      'machine',
      'enroll',
      '--invite',
      '[REDACTED]',
      '--unlock-token',
      '[REDACTED]',
      '--workspace-id',
      'ws_123',
    ]);
  });

  it('redacts sensitive flag values passed inline', () => {
    expect(redactArgv([
      'bun',
      'src/index.ts',
      'invite',
      'relay-machine',
      'create',
      '--machine-signing-key=abc123',
      '--machine-key-exchange-key=xyz789',
      '--linear-key=lin-secret',
    ])).toEqual([
      'bun',
      'src/index.ts',
      'invite',
      'relay-machine',
      'create',
      '--machine-signing-key=[REDACTED]',
      '--machine-key-exchange-key=[REDACTED]',
      '--linear-key=[REDACTED]',
    ]);
  });
});
