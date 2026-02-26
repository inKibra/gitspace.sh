/**
 * gssh status — unified daemon status
 *
 * @module cli/commands/status
 */

import type { Command } from 'commander';
import { withErrorHandler } from '../error.js';

export function registerStatusCommand(parent: Command): void {
  parent
    .command('status')
    .description('Show status of all gitspace daemons')
    .action(withErrorHandler(async () => {
      const { showStatus } = await import('../../commands/status.js');
      await showStatus();
    }, { skipSetupCheck: true }));
}
