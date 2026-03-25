/**
 * Unified Status Command
 *
 * Shows status of all spaces daemons:
 * - tmux-lite server
 * - serve daemon (relay connection)
 */

import chalk from 'chalk';
import {
  isServerRunning as isTmuxRunning,
  getStatus as getTmuxStatus,
} from '../lib/tmux-lite/cli.js';
import {
  isServeRunning,
  queryServeStatus,
} from '../serve/daemon.js';

/** Package version for display */
const PACKAGE_VERSION = '1.0.0';

/**
 * Format uptime in human-readable format
 */
function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (hours < 24) return `${hours}h ${mins}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

/**
 * Show unified status of all daemons
 */
export async function showStatus(): Promise<void> {
  const boxWidth = 50;
  const topBorder = '┌' + '─'.repeat(boxWidth - 2) + '┐';
  const bottomBorder = '└' + '─'.repeat(boxWidth - 2) + '┘';
  const emptyLine = '│' + ' '.repeat(boxWidth - 2) + '│';

  const padLine = (text: string): string => {
    const visible = text.replace(/\x1b\[[0-9;]*m/g, ''); // Strip ANSI for length calc
    const padding = boxWidth - 2 - visible.length;
    return '│ ' + text + ' '.repeat(Math.max(0, padding - 1)) + '│';
  };

  console.log();
  console.log(chalk.cyan(topBorder));
  console.log(padLine(chalk.bold.white('gssh status')));
  console.log(chalk.cyan(emptyLine));

  // Check tmux-lite status
  let tmuxLine = '';
  let tmuxDetailLine = '';
  if (await isTmuxRunning()) {
    try {
      const status = await getTmuxStatus();
      const sessionText = status.sessions === 1 ? 'session' : 'sessions';
      const attachedText = status.attached ? ` (${status.attached} attached)` : '';
      tmuxLine = `${chalk.green('●')} tmux-lite    ${chalk.white('running')}    ${status.sessions} ${sessionText}${attachedText}`;
      if (status.uptime) {
        tmuxDetailLine = `              uptime: ${formatUptime(status.uptime)}`;
      }
    } catch {
      tmuxLine = `${chalk.green('●')} tmux-lite    ${chalk.white('running')}`;
    }
  } else {
    tmuxLine = `${chalk.gray('○')} tmux-lite    ${chalk.gray('not running')}`;
  }
  console.log(padLine(tmuxLine));
  if (tmuxDetailLine) {
    console.log(padLine(chalk.dim(tmuxDetailLine)));
  }

  // Check serve status
  let serveLine = '';
  let serveDetailLine = '';
  if (isServeRunning()) {
    try {
      const status = await queryServeStatus();
      if (status) {
        const relayIcon = status.relay.status === 'connected' ? chalk.green('●') :
                         status.relay.status === 'connecting' || status.relay.status === 'reconnecting' ? chalk.yellow('◐') :
                         chalk.red('○');
        const relayText = status.relay.status === 'connected' ? 'connected' :
                         status.relay.status === 'connecting' ? 'connecting' :
                         status.relay.status === 'reconnecting' ? 'reconnecting' :
                         'disconnected';
        const clientText = status.clients === 1 ? 'client' : 'clients';
        serveLine = `${chalk.green('●')} serve        ${relayIcon} ${relayText}    ${status.clients} ${clientText}`;

        if (status.uptime) {
          serveDetailLine = `              uptime: ${formatUptime(status.uptime)}`;
        }
      } else {
        serveLine = `${chalk.green('●')} serve        ${chalk.white('running')}`;
      }
    } catch {
      serveLine = `${chalk.green('●')} serve        ${chalk.white('running')}`;
    }
  } else {
    serveLine = `${chalk.gray('○')} serve        ${chalk.gray('not running')}`;
  }
  console.log(padLine(serveLine));
  if (serveDetailLine) {
    console.log(padLine(chalk.dim(serveDetailLine)));
  }

  console.log(chalk.cyan(emptyLine));
  console.log(padLine(chalk.dim(`Version: ${PACKAGE_VERSION}`)));
  console.log(chalk.cyan(bottomBorder));
  console.log();
}
