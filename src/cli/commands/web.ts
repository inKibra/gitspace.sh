import type { Command } from 'commander';
import { withErrorHandler } from '../error.js';
import { SpacesError } from '../../types/errors.js';

function parseWebPort(rawPort: string): number {
  if (!/^\d+$/.test(rawPort)) {
    throw new SpacesError('Port must be an integer between 1 and 65535.', 'USER_ERROR', 1);
  }

  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new SpacesError('Port must be an integer between 1 and 65535.', 'USER_ERROR', 1);
  }

  return port;
}

export function registerWebCommand(parent: Command): void {
  parent
    .command('web')
    .description('Start the local relay + serve web stack on this machine')
    .option('--port <port>', 'Local relay/web port', '4480')
    .option('--relay', 'Start a hosted relay with cloudflared tunnel to your gitspace.sh subdomain')
    .option('-y, --yes', 'Auto-confirm prompts')
    .option('--takeover', 'Reclaim the local relay and serve daemons for the current identity: clear persisted owner/control state and forget any stale relay trust pin before starting. Use when recovering from mismatched ownership or trust pins.')
    .option('--password-stdin', 'Read the local device identity password from stdin and pass it through to machine serve')
    .action(withErrorHandler(async (options) => {
      const { startLocalWeb } = await import('../../commands/web.js');
      await startLocalWeb({
        port: parseWebPort(options.port),
        relay: options.relay,
        yes: options.yes,
        takeover: options.takeover,
        passwordStdin: options.passwordStdin,
      });
    }, { skipSetupCheck: true }));
}
