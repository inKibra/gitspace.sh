/**
 * gssh relay start|machines
 */

import type { Command } from 'commander';
import type { RelayStartMode } from '../../commands/relay.js';
import { withErrorHandler } from '../error.js';
import { SpacesError } from '../../types/errors.js';
import { logger } from '../../utils/logger.js';

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

function parseRelayStartMode(rawMode: string): RelayStartMode {
  const normalized = rawMode.trim().toLowerCase();
  if (normalized === 'auto' || normalized === 'hosted' || normalized === 'local') {
    return normalized;
  }

  logger.error(`Invalid relay start mode: ${rawMode}`);
  throw new SpacesError(
    'Invalid relay mode. Expected one of: auto, hosted, local.',
    'USER_ERROR',
    1,
  );
}

export function registerRelayCommands(parent: Command): void {
  const cmd = parent
    .command('relay')
    .description('Manage relay server and registered machines');

  cmd
    .command('start')
    .description('Start relay server in background (always reachable locally; auto/hosted also attach gitspace.sh when available)')
    .option('--port <port>', 'Port to listen on', '4480')
    .option('--bind <address>', 'Address to bind to', '0.0.0.0')
    .option('--hostname <host>', 'Only serve requests for this domain (optional)')
    .option('--mode <mode>', 'Startup mode: auto (local + hosted if available), hosted (require tunnel, keep local), local (local only)', 'auto')
    .option('--label <label>', 'Human-readable label for this relay')
    .option('-y, --yes', 'Auto-confirm prompts')
    .option('--foreground', "Run in foreground (don't daemonize)")
    .option('--takeover', 'Reclaim this relay: clear persisted owner/control state and forget any stale trust pin so the current identity can rebind. Use when recovering from mismatched ownership or trust pins.')
    .action(withErrorHandler(async (options) => {
      const { startRelay } = await import('../../commands/relay.js');
      await startRelay({
        port: parseRelayPort(options.port),
        bind: options.bind,
        hostname: options.hostname,
        mode: parseRelayStartMode(options.mode),
        label: options.label,
        yes: options.yes,
        foreground: options.foreground,
        takeover: options.takeover,
      });
    }, { skipSetupCheck: true }));

  cmd
    .command('stop')
    .description('Stop the relay server')
    .action(withErrorHandler(async () => {
      const { stopRelay } = await import('../../commands/relay.js');
      await stopRelay();
    }, { skipSetupCheck: true }));

  cmd
    .command('status')
    .description('Show relay server status')
    .option('--json', 'Output in JSON format')
    .action(withErrorHandler(async (options) => {
      const { relayStatus } = await import('../../commands/relay.js');
      await relayStatus(options);
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
