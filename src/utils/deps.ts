/**
 * Dependency checking utilities
 */

import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import type { Dependency } from '../types/workspace.js';
import { DependencyError, GitHubAuthError } from '../types/errors.js';
import { logger } from './logger.js';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

/**
 * Required system dependencies
 */
export const REQUIRED_DEPS: Dependency[] = [
  {
    name: 'Git',
    command: 'git',
    checkArgs: ['--version'],
    installUrl: 'https://git-scm.com/',
  },
];

/**
 * Optional dependencies used for GitHub repo discovery.
 */
export const GITHUB_DEPS: Dependency[] = [
  {
    name: 'GitHub CLI',
    command: 'gh',
    checkArgs: ['--version'],
    installUrl: 'https://cli.github.com/',
    authCheck: async () => {
      try {
        await execAsync('gh auth status');
        return true;
      } catch {
        return false;
      }
    },
  },
];

/**
 * Check if a command exists by running it with args
 */
async function commandExists(command: string, checkArgs: string[]): Promise<boolean> {
  try {
    await execAsync(`${command} ${checkArgs.join(' ')}`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a command exists in PATH using `which`
 * Validates command name to prevent injection
 */
export async function checkCommandExists(command: string): Promise<boolean> {
  if (!/^[a-zA-Z0-9_-]+$/.test(command)) {
    return false;
  }

  try {
    await execFileAsync('which', [command]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check all required dependencies
 */
export async function checkDependencies(deps: Dependency[] = REQUIRED_DEPS): Promise<{
  missing: Dependency[];
  allPresent: boolean;
}> {
  const missing: Dependency[] = [];

  for (const dep of deps) {
    const exists = await commandExists(dep.command, dep.checkArgs);
    if (!exists) {
      missing.push(dep);
    }
  }

  return {
    missing,
    allPresent: missing.length === 0,
  };
}

/**
 * Check GitHub CLI authentication
 */
export async function checkGitHubAuth(): Promise<void> {
  const ghDep = GITHUB_DEPS.find((d) => d.command === 'gh');
  if (!ghDep?.authCheck) {
    return;
  }

  const isAuthenticated = await ghDep.authCheck();
  if (!isAuthenticated) {
    throw new GitHubAuthError();
  }
}

/**
 * Display missing dependencies and exit
 */
export function displayMissingDependencies(missing: Dependency[]): never {
  logger.error('Missing required dependencies:\n');

  for (const dep of missing) {
    logger.log(`  ${dep.name} (${dep.command})`);
    logger.dim(`    Install: ${dep.installUrl}\n`);
  }

  throw new DependencyError(
    'Please install the missing dependencies and try again.'
  );
}

/**
 * Check dependencies and throw if any are missing
 */
export async function ensureDependencies(deps?: Dependency[]): Promise<void> {
  const { missing, allPresent } = await checkDependencies(deps);

  if (!allPresent) {
    displayMissingDependencies(missing);
  }
}

/**
 * Check specific dependencies (subset of all required)
 */
export async function checkSpecificDeps(commands: string[]): Promise<void> {
  const depsToCheck = REQUIRED_DEPS.filter((d) => commands.includes(d.command));
  await ensureDependencies(depsToCheck);
}
