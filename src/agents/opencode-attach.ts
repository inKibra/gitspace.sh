import { buildAuthenticatedOpenCodeUrl, type OpenCodeRuntimeInfo } from './opencode-types.js';

export function buildOpenCodeAttachUrlCommand(url: string, sessionId?: string): {
  command: string;
  args: string[];
} {
  const args = ['attach', url];
  if (sessionId) {
    args.push('--session', sessionId);
  }
  return {
    command: 'opencode',
    args,
  };
}

export function buildOpenCodeAttachCommand(runtime: OpenCodeRuntimeInfo, sessionId?: string): {
  command: string;
  args: string[];
} {
  return buildOpenCodeAttachUrlCommand(buildAuthenticatedOpenCodeUrl(runtime), sessionId);
}
