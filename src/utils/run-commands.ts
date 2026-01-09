/**
 * Run commands in the current terminal (not tmux)
 * Intelligently runs setup commands only once, then select commands
 */

import { spawn } from 'child_process';
import { SpacesError } from '../types/errors.js';
import { logger } from './logger.js';
import { hasSetupBeenRun, markSetupComplete } from './workspace-state.js';

/**
 * Run a single command in the workspace directory
 * Streams output to current terminal
 */
async function runCommand(
  command: string,
  workspacePath: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    logger.dim(`  $ ${command}`);

    // Parse command and args
    const [cmd, ...args] = command.split(' ');

    const child = spawn(cmd, args, {
      cwd: workspacePath,
      stdio: 'inherit', // Stream output to current terminal
      shell: true, // Use shell to handle complex commands
    });

    child.on('close', (code) => {
      if (code !== 0) {
        reject(
          new SpacesError(
            `Command failed with exit code ${code}: ${command}`,
            'SYSTEM_ERROR',
            2
          )
        );
      } else {
        resolve();
      }
    });

    child.on('error', (error) => {
      reject(
        new SpacesError(
          `Failed to run command: ${error.message}`,
          'SYSTEM_ERROR',
          2
        )
      );
    });
  });
}

/**
 * Run commands in terminal with smart setup tracking
 * Runs setup commands only once (first time), then select commands on subsequent runs
 */
export async function runCommandsInTerminal(
  workspacePath: string,
  setupCommands: string[] = [],
  selectCommands: string[] = []
): Promise<void> {
  const setupAlreadyRun = hasSetupBeenRun(workspacePath);

  let commandsToRun: string[] = [];
  let commandType: string;

  if (setupAlreadyRun) {
    // Setup has been run before, use select commands
    commandsToRun = selectCommands;
    commandType = 'select';
  } else {
    // First time setup, run setup commands
    commandsToRun = setupCommands;
    commandType = 'setup';
  }

  if (commandsToRun.length === 0) {
    logger.debug('No commands to run');
    return;
  }

  logger.info(`Running ${commandType} commands...`);

  try {
    // Run commands sequentially
    for (const cmd of commandsToRun) {
      await runCommand(cmd, workspacePath);
    }

    // Mark setup as complete if we just ran setup commands
    if (!setupAlreadyRun && setupCommands.length > 0) {
      markSetupComplete(workspacePath);
      logger.debug('Setup marked as complete');
    }

    logger.success('Commands completed');
  } catch (error) {
    if (error instanceof SpacesError) {
      throw error;
    }

    throw new SpacesError(
      `Failed to run commands: ${error instanceof Error ? error.message : 'Unknown error'}`,
      'SYSTEM_ERROR',
      2
    );
  }
}
