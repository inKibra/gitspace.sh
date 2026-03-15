import type { OpenCodeRuntimeInfo } from './opencode-types.js';

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

/**
 * Build the opencode attach command for a runtime with authentication.
 * Uses --password flag instead of embedding credentials in the URL,
 * because the Fetch spec forbids URLs with userinfo (user:pass@host)
 * and Bun's Request constructor will throw a TypeError.
 */
export function buildOpenCodeAttachCommand(runtime: OpenCodeRuntimeInfo, sessionId?: string): {
  command: string;
  args: string[];
} {
  const url = `http://${runtime.hostname}:${runtime.port}`;
  const args = ['attach', url, '--username', runtime.username, '--password', runtime.password];
  if (sessionId) {
    args.push('--session', sessionId);
  }
  return {
    command: 'opencode',
    args,
  };
}
