/**
 * gssh client connect <machine-id>
 *
 * Client-side connection to a remote machine.
 *
 * @module cli/commands/client
 */

import type { Command } from 'commander';
import { withErrorHandler } from '../error.js';

export function registerClientCommands(parent: Command): void {
  const cmd = parent
    .command('client')
    .description('Connect to remote machines as a client');

  const machines = cmd
    .command('machines')
    .description('Browse machines available on a relay');

  machines
    .command('list')
    .description('List machines you can access')
    .requiredOption('--relay <url>', 'Relay URL')
    .option('--relay-pubkey <pubkey>', 'Relay public key for explicit trust (base64)')
    .option('-y, --yes', 'Auto-confirm prompts')
    .option('--password-stdin', 'Read password from stdin')
    .option('--json', 'Output in JSON format')
    .action(withErrorHandler(async (options) => {
      const { listRemoteMachines } = await import('../../commands/connect.js');
      await listRemoteMachines(options);
    }));

  // gssh client connect <machine-id>
  cmd
    .command('connect')
    .description('Connect to a machine as the owner identity')
    .argument('[target]', 'Machine ID')
    .option('--relay <url>', 'Override relay URL')
    .option('--relay-pubkey <pubkey>', 'Relay public key for explicit trust (base64)')
    .option('--machine <id>', 'Machine ID for direct mode')
    .option('-y, --yes', 'Auto-confirm prompts')
    .option('--password-stdin', 'Read password from stdin')
    .action(withErrorHandler(async (target, options) => {
      const { connectToRemote } = await import('../../commands/connect.js');
      await connectToRemote(target, options);
    }));
}
