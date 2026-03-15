/**
 * Platform-agnostic OpenCode types and helpers.
 * Safe to import from both Bun (TUI/daemon) and browser (web) contexts.
 */

export interface OpenCodeRuntimeTarget {
  workspaceId: string;
  workspacePath: string;
  projectName?: string;
}

export interface OpenCodeRuntimeInfo {
  workspaceId: string;
  workspacePath: string;
  hostname: string;
  port: number;
  baseUrl: string;
  username: string;
  password: string;
  startedAt: string;
}

export function buildAuthenticatedOpenCodeUrl(info: Pick<OpenCodeRuntimeInfo, 'hostname' | 'port' | 'username' | 'password'>): string {
  const url = new URL(`http://${info.hostname}:${info.port}`);
  url.username = info.username;
  url.password = info.password;
  return url.toString();
}
