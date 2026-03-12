/**
 * gssh cloud setup|status|list|launch|stop|resume|destroy
 *
 * @module cli/commands/cloud
 */

import type { Command } from 'commander';
import { withErrorHandler } from '../error.js';

export function registerCloudCommands(parent: Command): void {
  const cmd = parent
    .command('cloud')
    .description('Cloud workspace management');

  // gssh cloud setup
  cmd
    .command('setup')
    .description('Configure cloud provider credentials (Sprites token)')
    .option('--clear', 'Remove stored provider credentials')
    .action(withErrorHandler(async (options: { clear?: boolean }) => {
      if (options.clear) {
        const { cloudSetupClear } = await import('../../commands/cloud.js');
        await cloudSetupClear();
      } else {
        const { cloudSetup } = await import('../../commands/cloud.js');
        await cloudSetup();
      }
    }));

  // gssh cloud status
  cmd
    .command('status')
    .description('Show cloud control status for the running serve daemon')
    .action(withErrorHandler(async () => {
      const { cloudStatus } = await import('../../commands/cloud.js');
      await cloudStatus();
    }));

  // gssh cloud list
  cmd
    .command('list')
    .description('List cloud workspaces from the control relay store')
    .action(withErrorHandler(async () => {
      const { cloudList } = await import('../../commands/cloud.js');
      await cloudList();
    }));

  // gssh cloud launch
  cmd
    .command('launch')
    .description('Launch a new cloud agent workspace')
    .option('--repo <owner/repo>', 'GitHub repository metadata (optional)')
    .option('--branch <branch>', 'Branch metadata (optional; requires --repo)')
    .option('--image <image>', 'Docker image override for the agent VM')
    .action(withErrorHandler(async (options: { repo?: string; branch?: string; image?: string }) => {
      const { cloudLaunch } = await import('../../commands/cloud.js');
      await cloudLaunch({
        repo: options.repo,
        branch: options.branch,
        image: options.image,
      });
    }));

  // gssh cloud stop <workspaceId>
  cmd
    .command('stop')
    .description('Hibernate a running cloud workspace')
    .argument('<workspaceId>', 'Cloud workspace ID')
    .action(withErrorHandler(async (workspaceId: string) => {
      const { cloudStop } = await import('../../commands/cloud.js');
      await cloudStop(workspaceId);
    }));

  // gssh cloud resume <workspaceId>
  cmd
    .command('resume')
    .description('Wake a hibernated cloud workspace')
    .argument('<workspaceId>', 'Cloud workspace ID')
    .action(withErrorHandler(async (workspaceId: string) => {
      const { cloudResume } = await import('../../commands/cloud.js');
      await cloudResume(workspaceId);
    }));

  // gssh cloud destroy <workspaceId>
  cmd
    .command('destroy')
    .description('Permanently destroy a cloud workspace (irreversible)')
    .argument('<workspaceId>', 'Cloud workspace ID')
    .action(withErrorHandler(async (workspaceId: string) => {
      const { cloudDestroy } = await import('../../commands/cloud.js');
      await cloudDestroy(workspaceId);
    }));

  // gssh cloud connect <workspaceId>
  cmd
    .command('connect')
    .description('Connect to a cloud workspace by workspace ID')
    .argument('<workspaceId>', 'Cloud workspace ID')
    .option('--relay <url>', 'Override relay URL')
    .option('--relay-pubkey <pubkey>', 'Relay public key for explicit trust (base64)')
    .option('-y, --yes', 'Auto-confirm prompts')
    .option('--password-stdin', 'Read password from stdin')
    .action(withErrorHandler(async (workspaceId: string, options: { relay?: string; relayPubkey?: string; yes?: boolean; passwordStdin?: boolean }) => {
      const { cloudConnect } = await import('../../commands/cloud.js');
      await cloudConnect(workspaceId, options);
    }));
}
