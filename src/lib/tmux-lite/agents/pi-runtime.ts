import { join } from 'node:path';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { getGitspaceDir } from '../../../core/config.js';
import type { AgentWorkspaceTarget } from '../../../agents/backend.js';

const OMP_PACKAGE = '@oh-my-pi/pi-coding-agent';
const OMP_BIN_NAME = 'omp';

/**
 * Pi agent directory, scoped under gitspace.
 *
 * Structure:
 *   ~/gitspace/.pi/
 *     bin/                 ← managed binaries (omp, fd, ast-grep, etc.)
 *     extensions/          ← gitspace-managed extensions
 *     sessions/            ← Pi session storage (by workspace path)
 *     node_modules/        ← oh-my-pi installation
 *     package.json         ← managed package manifest
 *     settings.json        ← Pi settings (tool enable/disable)
 */
export function getPiAgentDir(): string {
  return join(getGitspaceDir(), '.pi');
}

/**
 * Ensure the Pi agent directory exists with expected subdirectories.
 */
export function ensurePiAgentDir(): string {
  const agentDir = getPiAgentDir();
  const dirs = [
    agentDir,
    join(agentDir, 'bin'),
    join(agentDir, 'extensions'),
    join(agentDir, 'sessions'),
  ];
  for (const dir of dirs) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
  }
  return agentDir;
}

/**
 * Get the installed oh-my-pi version, or null if not installed.
 */
function getInstalledOmpVersion(agentDir: string): string | null {
  try {
    const pkgPath = join(agentDir, 'node_modules', OMP_PACKAGE, 'package.json');
    if (!existsSync(pkgPath)) return null;
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

/**
 * Get the path to the omp binary.
 */
export function getOmpBinPath(): string {
  const agentDir = getPiAgentDir();
  return join(agentDir, 'node_modules', '.bin', OMP_BIN_NAME);
}

/**
 * Ensure oh-my-pi is installed and up to date.
 * Installs to ~/gitspace/.pi/ with its own package.json so it's
 * independent of gitspace's node_modules.
 *
 * Returns the path to the omp binary.
 */
export async function ensureOmpInstalled(): Promise<string> {
  const agentDir = ensurePiAgentDir();
  const binPath = getOmpBinPath();

  // Ensure a package.json exists in the agent dir for bun install
  const pkgJsonPath = join(agentDir, 'package.json');
  if (!existsSync(pkgJsonPath)) {
    writeFileSync(pkgJsonPath, JSON.stringify({
      name: 'gitspace-pi-agent',
      private: true,
      dependencies: {
        [OMP_PACKAGE]: 'latest',
      },
    }, null, 2));
  }

  // Check if already installed
  const installed = getInstalledOmpVersion(agentDir);
  if (installed && existsSync(binPath)) {
    return binPath;
  }

  // Install oh-my-pi
  execSync('bun install', {
    cwd: agentDir,
    stdio: 'ignore',
    timeout: 120_000,
  });

  if (!existsSync(binPath)) {
    throw new Error(`oh-my-pi installation failed: ${binPath} not found`);
  }

  return binPath;
}

/**
 * Update oh-my-pi to the latest version.
 * Called periodically (e.g., on tmux-lite server startup).
 */
export async function updateOmp(): Promise<{ version: string; updated: boolean }> {
  const agentDir = ensurePiAgentDir();
  const before = getInstalledOmpVersion(agentDir);

  // Update the dependency
  const pkgJsonPath = join(agentDir, 'package.json');
  const pkg = existsSync(pkgJsonPath)
    ? JSON.parse(readFileSync(pkgJsonPath, 'utf-8'))
    : { name: 'gitspace-pi-agent', private: true, dependencies: {} };
  pkg.dependencies[OMP_PACKAGE] = 'latest';
  writeFileSync(pkgJsonPath, JSON.stringify(pkg, null, 2));

  execSync('bun install', {
    cwd: agentDir,
    stdio: 'ignore',
    timeout: 120_000,
  });

  const after = getInstalledOmpVersion(agentDir);
  return {
    version: after ?? 'unknown',
    updated: before !== after,
  };
}

/**
 * Build environment variables for a Pi agent session scoped to a workspace.
 *
 * Sets PI_CODING_AGENT_DIR so oh-my-pi reads config/extensions/sessions
 * from the gitspace-managed directory (~/.pi/) instead of the default (~/.omp/agent/).
 */
export function setupPiEnvironment(
  _target: AgentWorkspaceTarget,
): Record<string, string> {
  const agentDir = ensurePiAgentDir();
  return {
    // Both upstream Pi and oh-my-pi use PI_CODING_AGENT_DIR
    PI_CODING_AGENT_DIR: agentDir,
  };
}
