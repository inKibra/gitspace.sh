import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { Command } from 'commander';

const mockListRemoteMachines = mock(
  async (_options: { relay?: string; relayPubkey?: string; yes?: boolean; json?: boolean; passwordStdin?: boolean }) => {
    return;
  },
);

const mockConnectToRemote = mock(
  async (
    _target?: string,
    _options?: { relay?: string; machine?: string; relayPubkey?: string; yes?: boolean; passwordStdin?: boolean },
  ) => {
    return;
  },
);

mock.module('../../../commands/connect.js', () => ({
  listRemoteMachines: mockListRemoteMachines,
  connectToRemote: mockConnectToRemote,
}));

mock.module('../../error.js', () => ({
  withErrorHandler: <T extends unknown[]>(handler: (...args: T) => Promise<void>) => handler,
}));

const { registerClientCommands } = await import('../client.js');

function makeProgram(): Command {
  const program = new Command();
  program.name('gssh');
  registerClientCommands(program);
  return program;
}

function enableExitOverrideRecursively(command: Command): void {
  command.exitOverride();
  command.configureOutput({
    writeErr: () => undefined,
  });

  for (const subcommand of command.commands) {
    enableExitOverrideRecursively(subcommand);
  }
}

describe('registerClientCommands', () => {
  beforeEach(() => {
    mockListRemoteMachines.mockReset();
    mockConnectToRemote.mockReset();
  });

  test('wires client machines list options to listRemoteMachines', async () => {
    const program = makeProgram();

    await program.parseAsync(
      [
        'client',
        'machines',
        'list',
        '--relay',
        'wss://relay.test/ws',
        '--relay-pubkey',
        'relay-pubkey-b64',
        '--yes',
        '--password-stdin',
        '--json',
      ],
      { from: 'user' },
    );

    expect(mockListRemoteMachines).toHaveBeenCalledTimes(1);
    expect(mockListRemoteMachines).toHaveBeenCalledWith({
      relay: 'wss://relay.test/ws',
      relayPubkey: 'relay-pubkey-b64',
      yes: true,
      passwordStdin: true,
      json: true,
    });
  });

  test('wires client connect target and trust flags to connectToRemote', async () => {
    const program = makeProgram();

    await program.parseAsync(
      [
        'client',
        'connect',
        'machine-123',
        '--relay',
        'wss://relay.test/ws',
        '--relay-pubkey',
        'relay-pubkey-b64',
        '--yes',
        '--password-stdin',
      ],
      { from: 'user' },
    );

    expect(mockConnectToRemote).toHaveBeenCalledTimes(1);
    expect(mockConnectToRemote).toHaveBeenCalledWith('machine-123', {
      relay: 'wss://relay.test/ws',
      relayPubkey: 'relay-pubkey-b64',
      yes: true,
      passwordStdin: true,
    });
  });

  test('wires client connect --machine direct mode without target', async () => {
    const program = makeProgram();

    await program.parseAsync(
      [
        'client',
        'connect',
        '--machine',
        'machine-abc',
        '--relay',
        'ws://127.0.0.1:4480/ws',
        '--relay-pubkey',
        'local-pubkey-b64',
        '--yes',
        '--password-stdin',
      ],
      { from: 'user' },
    );

    expect(mockConnectToRemote).toHaveBeenCalledTimes(1);
    expect(mockConnectToRemote).toHaveBeenCalledWith(undefined, {
      machine: 'machine-abc',
      relay: 'ws://127.0.0.1:4480/ws',
      relayPubkey: 'local-pubkey-b64',
      yes: true,
      passwordStdin: true,
    });
  });

  test('requires --relay for client machines list', async () => {
    const program = makeProgram();
    enableExitOverrideRecursively(program);

    await expect(
      program.parseAsync(
        [
          'client',
          'machines',
          'list',
        ],
        { from: 'user' },
      ),
    ).rejects.toThrow(/required option '--relay <url>' not specified/i);

    expect(mockListRemoteMachines).not.toHaveBeenCalled();
  });
});
