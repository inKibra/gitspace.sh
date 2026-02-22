/**
 * gssh machine serve|enroll|access|tmux
 *
 * Machine-side commands for daemon management, remote access, and terminal sessions.
 *
 * @module cli/commands/machine
 */

import type { Command } from 'commander';
import { withErrorHandler } from '../error.js';

export function registerMachineCommands(parent: Command): void {
  const cmd = parent
    .command('machine')
    .description('Manage this machine as a remote-accessible host');

  // --------------------------------------------------------------------------
  // gssh machine serve [start|stop|status]
  // --------------------------------------------------------------------------
  registerMachineServeCommands(cmd);

  // --------------------------------------------------------------------------
  // gssh machine enroll --invite <token> [--label <name>]
  // --------------------------------------------------------------------------
  cmd
    .command('enroll')
    .description('Enroll this machine with a relay-machine invite token')
    .requiredOption('--invite <token>', 'Root-signed relay-machine invite token (or relay URL with #token)')
    .option('--label <name>', 'Human-readable machine label')
    .action(withErrorHandler(async (options) => {
      const { enrollMachine } = await import('../../commands/machine-enroll.js');
      await enrollMachine(options);
    }));

  // --------------------------------------------------------------------------
  // gssh machine access [add|list|remove]
  // --------------------------------------------------------------------------
  registerMachineAccessCommands(cmd);

  // --------------------------------------------------------------------------
  // gssh machine tmux [start|stop|status|list|new|attach|kill]
  // --------------------------------------------------------------------------
  registerMachineTmuxCommands(cmd);
}

// ============================================================================
// Serve
// ============================================================================

function registerMachineServeCommands(machine: Command): void {
  const serve = machine
    .command('serve')
    .description('Manage remote access daemon');

  // gssh machine serve start
  serve
    .command('start')
    .description('Start the serve daemon')
    .option('--relay <url>', 'Override default relay URL')
    .option('--relay-pubkey <pubkey>', 'Relay public key for explicit trust (base64)')
    .option('--bootstrap-token <token>', 'One-time bootstrap token for cloud machine registration')
    .option('--enrollment-token <token>', 'One-time relay-machine invite token for machine registration')
    .option('--unlock-token <token>', 'One-time token to request unlock grant from relay')
    .option('--workspace-id <id>', 'Cloud workspace id for unlock-token flow')
    .option('--ignore-keychain-and-skip-secrets', 'Skip keychain preload and skip secret-dependent scripts')
    .option('--password-stdin', 'Read password from stdin')
    .option('--foreground', "Run in foreground (don't daemonize)")
    .action(withErrorHandler(async (options) => {
      const { serveStart } = await import('../../commands/serve.js');
      await serveStart(options);
    }));

  // gssh machine serve stop
  serve
    .command('stop')
    .description('Stop the serve daemon')
    .action(withErrorHandler(async () => {
      const { serveStop } = await import('../../commands/serve.js');
      await serveStop();
    }, { skipSetupCheck: true }));

  // gssh machine serve status
  serve
    .command('status')
    .description('Show serve daemon status')
    .action(withErrorHandler(async () => {
      const { serveStatus } = await import('../../commands/serve.js');
      await serveStatus();
    }, { skipSetupCheck: true }));

}

// ============================================================================
// Access
// ============================================================================

function registerMachineAccessCommands(machine: Command): void {
  const access = machine
    .command('access')
    .description('Manage access control for remote connections');

  // gssh machine access add <user>
  access
    .command('add')
    .description('Grant full machine access to a user root')
    .argument('<user>', 'User root key (gssh-user:BASE64_KEY) or user-root-id')
    .option('--label <name>', 'Human-readable label for this key')
    .option('--machine <id>', 'Machine ID (defaults to local machine)')
    .action(withErrorHandler(async (user, options) => {
      const { addAccessKey } = await import('../../commands/machine-access.js');
      await addAccessKey(user, options);
    }));

  // gssh machine access list
  access
    .command('list')
    .description('List machine access grants')
    .option('--json', 'Output in JSON format')
    .option('--machine <id>', 'Machine ID (defaults to local machine)')
    .action(withErrorHandler(async (options) => {
      const { listAccessKeys } = await import('../../commands/machine-access.js');
      await listAccessKeys(options);
    }));

  // gssh machine access remove <user|label>
  access
    .command('remove')
    .description('Remove a machine access grant')
    .argument('<user|label>', 'User root key, user-root-id prefix, or label')
    .option('--force', 'Skip confirmation prompt')
    .option('--machine <id>', 'Machine ID (defaults to local machine)')
    .action(withErrorHandler(async (userOrLabel, options) => {
      const { removeAccessKey } = await import('../../commands/machine-access.js');
      await removeAccessKey(userOrLabel, options);
    }));
}

// ============================================================================
// Tmux
// ============================================================================

function registerMachineTmuxCommands(machine: Command): void {
  const tmux = machine
    .command('tmux')
    .description('Manage tmux-lite terminal session daemon');

  tmux
    .command('start')
    .description('Start the tmux-lite server daemon')
    .action(withErrorHandler(async () => {
      const { startTmux } = await import('../../commands/tmux.js');
      await startTmux();
    }, { skipSetupCheck: true }));

  tmux
    .command('stop')
    .description('Stop the tmux-lite server daemon')
    .option('--force', 'Stop even if sessions are active')
    .action(withErrorHandler(async (options) => {
      const { stopTmux } = await import('../../commands/tmux.js');
      await stopTmux({ force: options.force });
    }, { skipSetupCheck: true }));

  tmux
    .command('status')
    .description('Show tmux-lite server status')
    .action(withErrorHandler(async () => {
      const { statusTmux } = await import('../../commands/tmux.js');
      await statusTmux();
    }, { skipSetupCheck: true }));

  tmux
    .command('list')
    .description('List active tmux-lite sessions')
    .action(withErrorHandler(async () => {
      const { listTmux } = await import('../../commands/tmux.js');
      await listTmux();
    }, { skipSetupCheck: true }));

  tmux
    .command('new')
    .description('Create and attach to a new session')
    .argument('[name]', 'Session name')
    .action(withErrorHandler(async (name) => {
      const { newTmux } = await import('../../commands/tmux.js');
      await newTmux(name);
    }, { skipSetupCheck: true }));

  tmux
    .command('attach')
    .description('Attach to a session (by id or name)')
    .argument('<id>', 'Session ID or name')
    .option('--force', 'Take over if attached elsewhere')
    .action(withErrorHandler(async (id, options) => {
      const { attachTmux } = await import('../../commands/tmux.js');
      await attachTmux(id, { force: options.force });
    }, { skipSetupCheck: true }));

  tmux
    .command('kill')
    .description('Kill a session (by id or name)')
    .argument('<id>', 'Session ID or name')
    .action(withErrorHandler(async (id) => {
      const { killTmux } = await import('../../commands/tmux.js');
      await killTmux(id);
    }, { skipSetupCheck: true }));
}
