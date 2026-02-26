import type { Command } from 'commander';
import { withErrorHandler } from '../error.js';

export function registerInviteCommands(parent: Command): void {
  const invite = parent
    .command('invite')
    .description('Create and manage machine enrollment invites');

  const relayMachine = invite
    .command('relay-machine')
    .description('Invite a machine to register on relay');

  relayMachine
    .command('create')
    .description('Create relay-machine invite')
    .requiredOption('--relay <url>', 'Relay URL')
    .requiredOption('--machine-signing-key <base64>', 'Machine Ed25519 signing public key (base64)')
    .requiredOption('--machine-key-exchange-key <base64>', 'Machine X25519 key exchange public key (base64)')
    .option('--expires <duration>', 'Invite duration (e.g. 1h, 24h, 7d)', '24h')
    .option('--max-uses <n>', 'Maximum uses (or "unlimited")', '1')
    .option('--label <label>', 'Optional invite label')
    .action(withErrorHandler(async (options) => {
      const { createRelayMachineInvite } = await import('../../commands/invite.js');
      await createRelayMachineInvite({
        relay: options.relay,
        machineSigningKey: options.machineSigningKey,
        machineKeyExchangeKey: options.machineKeyExchangeKey,
        expires: options.expires,
        maxUses: options.maxUses,
        label: options.label,
      });
    }));

  invite
    .command('list')
    .description('List relay-machine invites you own')
    .requiredOption('--relay <url>', 'Relay URL')
    .option('--json', 'Output JSON')
    .action(withErrorHandler(async (options) => {
      const { listInvites } = await import('../../commands/invite.js');
      await listInvites({
        relay: options.relay,
        type: 'relay-machine',
        json: options.json,
      });
    }));

  invite
    .command('revoke')
    .description('Revoke a machine enrollment invite')
    .argument('<invite-id>', 'Invite ID')
    .requiredOption('--relay <url>', 'Relay URL')
    .action(withErrorHandler(async (inviteId, options) => {
      const { revokeInvite } = await import('../../commands/invite.js');
      await revokeInvite(inviteId, { relay: options.relay });
    }));
}
