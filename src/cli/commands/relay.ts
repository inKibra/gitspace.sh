/**
 * gssh relay start|machines
 */

import type { Command } from 'commander';
import { withErrorHandler } from '../error.js';
import { SpacesError } from '../../types/errors.js';

function parseRelayPort(rawPort: string): number {
  if (!/^\d+$/.test(rawPort)) {
    throw new SpacesError('Port must be an integer between 1 and 65535.', 'USER_ERROR', 1);
  }

  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new SpacesError('Port must be an integer between 1 and 65535.', 'USER_ERROR', 1);
  }

  return port;
}

export function registerRelayCommands(parent: Command): void {
  const cmd = parent
    .command('relay')
    .description('Manage relay server and registered machines');

  cmd
    .command('start')
    .description('Start the relay server')
    .option('--port <port>', 'Port to listen on', '4480')
    .option('--bind <address>', 'Address to bind to', '0.0.0.0')
    .option('--hostname <host>', 'Only serve requests for this domain (optional)')
    .option('--label <label>', 'Human-readable label for this relay')
    .action(withErrorHandler(async (options) => {
      const { startRelay } = await import('../../commands/relay.js');
      await startRelay({
        port: parseRelayPort(options.port),
        bind: options.bind,
        hostname: options.hostname,
        label: options.label,
      });
    }, { skipSetupCheck: true }));

  const machines = cmd
    .command('machines')
    .description('Manage machines registered to this relay');

  machines
    .command('list')
    .description('List registered machines')
    .option('--json', 'Output in JSON format')
    .action(withErrorHandler(async (options) => {
      const { listRelayMachines } = await import('../../commands/relay.js');
      await listRelayMachines(options);
    }, { skipSetupCheck: true }));

  machines
    .command('revoke')
    .description('Remove a machine from relay registry')
    .argument('<machine-id>', 'Machine ID')
    .action(withErrorHandler(async (machineId) => {
      const { revokeRelayMachine } = await import('../../commands/relay.js');
      await revokeRelayMachine(machineId);
    }, { skipSetupCheck: true }));
}
