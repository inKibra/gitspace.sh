import type { SessionStatus } from './opencode-event-types.js';

export interface OpenCodeSessionRecord {
  id: string;
  title?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface OpenCodeProviderRecord {
  id: string;
  name?: string;
}

export type OpenCodeFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface OpenCodeClientOptions {
  baseUrl: string;
  fetch?: OpenCodeFetch;
}

function trimTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

export class OpenCodeClient {
  readonly baseUrl: string;
  private readonly fetchImpl: OpenCodeFetch;

  constructor(options: OpenCodeClientOptions) {
    this.baseUrl = trimTrailingSlash(options.baseUrl);
    this.fetchImpl = options.fetch ?? fetch;
  }

  async listSessions(): Promise<OpenCodeSessionRecord[]> {
    return this.request<OpenCodeSessionRecord[]>('/session');
  }

  async createSession(input: { title?: string }): Promise<OpenCodeSessionRecord> {
    return this.request<OpenCodeSessionRecord>('/session', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  async getSession(sessionId: string): Promise<OpenCodeSessionRecord> {
    return this.request<OpenCodeSessionRecord>(`/session/${encodeURIComponent(sessionId)}`);
  }

  async destroySession(sessionId: string): Promise<void> {
    await this.request(`/session/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
    });
  }

  async sendMessage(sessionId: string, input: { parts: Array<{ type: 'text'; text: string }> }): Promise<void> {
    await this.request(`/session/${encodeURIComponent(sessionId)}/message`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  async listProviders(): Promise<OpenCodeProviderRecord[]> {
    return this.request<OpenCodeProviderRecord[]>('/provider');
  }

  /** GET /session/status — returns per-session status map */
  async getSessionStatuses(): Promise<Record<string, SessionStatus>> {
    return this.request<Record<string, SessionStatus>>('/session/status');
  }

  /** POST /session/:id/abort — stops a running session */
  async abortSession(sessionId: string): Promise<boolean> {
    return this.request<boolean>(`/session/${encodeURIComponent(sessionId)}/abort`, {
      method: 'POST',
    });
  }

  /** POST /session/:id/permissions/:permissionId — respond to a permission request */
  async respondToPermission(
    sessionId: string,
    permissionId: string,
    response: 'allow' | 'deny',
    remember?: boolean,
  ): Promise<boolean> {
    return this.request<boolean>(
      `/session/${encodeURIComponent(sessionId)}/permissions/${encodeURIComponent(permissionId)}`,
      {
        method: 'POST',
        body: JSON.stringify({ response, remember }),
      },
    );
  }

  async request<T = unknown>(path: string, init?: RequestInit): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        ...(init?.headers ?? {}),
      },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`OpenCode request failed (${response.status}): ${text || response.statusText}`);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return await response.json() as T;
  }
}
