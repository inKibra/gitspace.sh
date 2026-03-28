import { homedir } from 'os';
import { join } from 'path';

function readEnvPath(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

function resolveHomeDir(): string {
  return process.env.HOME?.trim() || homedir();
}

/**
 * Root directory containing GitSpace projects/workspaces.
 *
 * This is intentionally separate from identity/config overrides so dev sandboxes
 * can keep using the real workspace tree while isolating auth/runtime state.
 */
export function getWorkspaceRoot(): string {
  return readEnvPath('GITSPACE_WORKSPACE_ROOT')
    ?? readEnvPath('GITSPACE_HOME')
    ?? join(resolveHomeDir(), 'gitspace');
}

/**
 * Root directory for identity files (.identity/*).
 * Defaults under the workspace root but may be sandboxed independently.
 */
export function getIdentityRoot(): string {
  return readEnvPath('GITSPACE_IDENTITY_DIR')
    ?? join(getWorkspaceRoot(), '.identity');
}

/**
 * Root directory for global GitSpace config files.
 * Kept separate so future sandboxes can isolate config without moving workspaces.
 */
export function getConfigRoot(): string {
  return readEnvPath('GITSPACE_CONFIG_ROOT')
    ?? getWorkspaceRoot();
}

export function getWorkspaceProjectDir(projectName: string): string {
  return join(getWorkspaceRoot(), projectName);
}

export function getWorkspaceDir(projectName: string, workspaceName: string): string {
  return join(getWorkspaceProjectDir(projectName), 'workspaces', workspaceName);
}
