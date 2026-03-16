import { buildAuthenticatedOpenCodeUrl, type OpenCodeRuntimeInfo } from './opencode-runtime-shared.js';

export function encodeWorkspacePathForRoute(workspacePath: string): string {
  // Isomorphic: Buffer for Bun/Node, TextEncoder+btoa for browser
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(workspacePath, 'utf8').toString('base64url');
  }
  const bytes = new TextEncoder().encode(workspacePath);
  const binary = String.fromCharCode(...bytes);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function buildOpenCodeWebUrl(runtime: OpenCodeRuntimeInfo, sessionId?: string): string {
  const base = new URL(buildAuthenticatedOpenCodeUrl(runtime));
  const encodedDir = encodeWorkspacePathForRoute(runtime.workspacePath);
  if (sessionId) {
    base.pathname = `/${encodedDir}/session/${encodeURIComponent(sessionId)}`;
  } else {
    base.pathname = `/${encodedDir}/session`;
  }
  return base.toString();
}

export function buildOpenCodeWebProxyUrl(params: {
  machineId: string;
  workspaceId: string;
  workspacePath: string;
  sessionId?: string;
}): string {
  const encodedDir = encodeWorkspacePathForRoute(params.workspacePath);
  const base = `/agent-ui/${encodeURIComponent(params.machineId)}/${encodeURIComponent(params.workspaceId)}`;
  if (params.sessionId) {
    return `${base}/${encodedDir}/session/${encodeURIComponent(params.sessionId)}`;
  }
  return `${base}/${encodedDir}/session`;
}
