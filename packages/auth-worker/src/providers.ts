import { refreshAnthropicTokenPortable } from '@oh-my-pi/pi-ai/oauth/anthropic-refresh';
import { refreshCursorTokenPortable } from '@oh-my-pi/pi-ai/oauth/cursor-refresh';
import { refreshAntigravityTokenPortable } from '@oh-my-pi/pi-ai/oauth/google-antigravity-refresh';
import { refreshGoogleCloudTokenPortable } from '@oh-my-pi/pi-ai/oauth/google-gemini-cli-refresh';
import { refreshOpenAICodexTokenPortable } from '@oh-my-pi/pi-ai/oauth/openai-codex-refresh';
import { WorkerOAuthRefreshError } from '@oh-my-pi/pi-ai/oauth/worker-refresh';

export type WorkerOAuthProvider = 'anthropic' | 'openai-codex' | 'google-gemini-cli' | 'google-antigravity' | 'cursor';

export interface StoredOAuthCredential {
  provider: WorkerOAuthProvider;
  refresh: string;
  access: string;
  expires: number;
  accountId?: string;
  email?: string;
  orgId?: string;
  projectId?: string;
}

export class ProviderRefreshError extends Error {
  constructor(
    readonly provider: WorkerOAuthProvider,
    readonly kind: 'network' | 'rejected' | 'invalid-response',
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ProviderRefreshError';
  }
}

function mappedError(provider: WorkerOAuthProvider, error: unknown): never {
  if (error instanceof WorkerOAuthRefreshError) {
    throw new ProviderRefreshError(provider, error.kind, `Provider refresh ${error.kind}`, error.status);
  }
  throw error;
}

export async function refreshCredential(
  credential: StoredOAuthCredential,
  fetcher: typeof fetch = fetch,
): Promise<StoredOAuthCredential> {
  try {
    switch (credential.provider) {
      case 'anthropic': {
        const token = await refreshAnthropicTokenPortable(credential.refresh, fetcher);
        return {
          ...credential,
          access: token.access_token,
          refresh: token.refresh_token || credential.refresh,
          expires: Date.now() + token.expires_in * 1000 - 5 * 60 * 1000,
        };
      }
      case 'openai-codex': {
        const token = await refreshOpenAICodexTokenPortable(credential.refresh, fetcher);
        return {
          ...credential,
          access: token.access_token,
          refresh: token.refresh_token || credential.refresh,
          expires: Date.now() + token.expires_in * 1000,
        };
      }
      case 'google-gemini-cli':
        return {
          ...credential,
          ...await refreshGoogleCloudTokenPortable(credential.refresh, credential.projectId ?? '', fetcher),
          provider: credential.provider,
        };
      case 'google-antigravity':
        return {
          ...credential,
          ...await refreshAntigravityTokenPortable(credential.refresh, credential.projectId ?? '', fetcher),
          provider: credential.provider,
        };
      case 'cursor':
        return {
          ...credential,
          ...await refreshCursorTokenPortable(credential.refresh, fetcher),
          provider: credential.provider,
        };
    }
  } catch (error) {
    return mappedError(credential.provider, error);
  }
}
