/**
 * CLI program assembly
 *
 * Creates the Commander program with the new command tree:
 *
 *   gssh project list|add|remove
 *   gssh workspace list|add|remove|context|review|session|process|events|bundle
 *   gssh machine serve|enroll|tmux
 *   gssh invite relay-machine|list|revoke
 *   gssh client machines|connect
 *   gssh user identity|auth|host|config|notifications|migrate
 *   gssh cloud setup|status|list|launch|stop|resume|destroy
 *   gssh relay start|machines
 *   gssh status
 *   gssh space [context|review|process|events|bundle]  (hidden)
 *
 * @module cli
 */

import { Command } from 'commander';
import { registerProjectCommands } from './commands/project.js';
import { registerWorkspaceCommands } from './commands/workspace.js';
import { registerMachineCommands } from './commands/machine.js';
import { registerClientCommands } from './commands/client.js';
import { registerUserCommands } from './commands/user.js';
import { registerSpaceCommands } from './commands/space.js';
import { registerCloudCommands } from './commands/cloud.js';
import { registerRelayCommands } from './commands/relay.js';
import { registerStatusCommand } from './commands/status.js';
import { registerInviteCommands } from './commands/invite.js';

/**
 * Create the CLI program with all commands registered.
 *
 * @param version - Version string for --version flag
 * @returns Configured Commander program (call .parse() to execute)
 */
export function createProgram(version: string): Command {
  const program = new Command();

  program
    .name('gssh')
    .description('GitSpace CLI - Manage workspaces with secure remote terminal access')
    .version(version);

  // Register command groups
  registerProjectCommands(program);
  registerWorkspaceCommands(program);
  registerMachineCommands(program);
  registerInviteCommands(program);
  registerClientCommands(program);
  registerUserCommands(program);
  registerCloudCommands(program);
  registerRelayCommands(program);
  registerStatusCommand(program);

  // Hidden session-only commands
  registerSpaceCommands(program);

  return program;
}
