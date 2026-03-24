import { realpathSync } from 'node:fs';

export interface OpenCodeRuntimeTarget {
  workspaceId: string;
  workspacePath: string;
  projectName?: string;
}

export interface OpenCodeRuntimeInfo {
  /** Machine/runtime-scoped identifier. */
  runtimeKey: string;
  /** Legacy fields kept during migration; no longer authoritative. */
  workspaceId?: string;
  workspacePath?: string;
  hostname: string;
  port: number;
  baseUrl: string;
  username: string;
  password: string;
  startedAt: string;
}

export function buildAuthenticatedOpenCodeUrl(
  info: Pick<OpenCodeRuntimeInfo, 'hostname' | 'port' | 'username' | 'password'>,
): string {
  const url = new URL(`http://${info.hostname}:${info.port}`);
  url.username = info.username;
  url.password = info.password;
  return url.toString();
}

export function createOpenCodeBasicAuthHeader(
  info: Pick<OpenCodeRuntimeInfo, 'username' | 'password'>,
): string {
  return `Basic ${Buffer.from(`${info.username}:${info.password}`).toString('base64')}`;
}

export function normalizeWorkspacePath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
