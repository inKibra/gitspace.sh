/**
 * gssh relay start|access|machines
 */

import type { Command } from 'commander';
import { withErrorHandler } from '../error.js';

export function registerRelayCommands(parent: Command): void {
  const cmd = parent
    .command('relay')
    .description('Manage relay server and relay-level access');

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
        port: parseInt(options.port, 10),
        bind: options.bind,
        hostname: options.hostname,
        label: options.label,
      });
    }, { skipSetupCheck: true }));

  const access = cmd
    .command('access')
    .description('Manage relay-level user access');

  access
    .command('add')
    .description('Grant relay access to a user root')
    .argument('<user>', 'User root key (gssh-user:BASE64_KEY) or user-root-id')
    .option('--label <label>', 'Optional label for this grant')
    .action(withErrorHandler(async (user, options) => {
      const { addRelayAccess } = await import('../../commands/relay.js');
      await addRelayAccess(user, options);
    }, { skipSetupCheck: true }));

  access
    .command('list')
    .description('List relay-level user grants')
    .option('--json', 'Output in JSON format')
    .action(withErrorHandler(async (options) => {
      const { listRelayAccess } = await import('../../commands/relay.js');
      await listRelayAccess(options);
    }, { skipSetupCheck: true }));

  access
    .command('remove')
    .description('Revoke relay-level user access')
    .argument('<user|label>', 'User root key, user-root-id prefix, or label')
    .option('--force', 'Skip confirmation prompt')
    .action(withErrorHandler(async (userOrLabel, options) => {
      const { removeRelayAccess } = await import('../../commands/relay.js');
      await removeRelayAccess(userOrLabel, options);
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
