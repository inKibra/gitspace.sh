import { createOpencodeClient, type OpencodeClient as SdkClient } from '@opencode-ai/sdk/v2';
import type { SessionStatus, PendingQuestion } from './opencode-event-types.js';

export interface OpenCodeSessionRecord {
  id: string;
  title?: string;
  directory?: string;
  parentID?: string;
  createdAt?: string;
  updatedAt?: string;
  time?: {
    created?: number;
    updated?: number;
  };
}

export interface OpenCodeProviderRecord {
  id: string;
  name?: string;
}

export type OpenCodeFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface OpenCodeClientOptions {
  baseUrl: string;
  fetch?: OpenCodeFetch;
  /** Default workspace directory used for session-scoped requests. */
  directory?: string;
}

function trimTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

function requireData<T>(value: T | undefined, message: string): T {
  if (value === undefined) {
    throw new Error(message);
  }
  return value;
}

export class OpenCodeClient {
  readonly baseUrl: string;
  readonly directory?: string;
  private readonly fetchImpl?: OpenCodeFetch;
  private readonly client: SdkClient;

  constructor(options: OpenCodeClientOptions) {
    this.baseUrl = trimTrailingSlash(options.baseUrl);
    this.directory = options.directory;
    this.fetchImpl = options.fetch;
    this.client = createOpencodeClient({
      baseUrl: this.baseUrl,
      // Cast needed: our OpenCodeFetch is a simplified subset of the native fetch
      // signature; the v2 SDK types require the full overloaded typeof fetch.
      fetch: options.fetch as typeof fetch | undefined,
      directory: options.directory,
      responseStyle: 'fields',
      throwOnError: true,
    });
  }

  withDirectory(directory: string): OpenCodeClient {
    return new OpenCodeClient({
      baseUrl: this.baseUrl,
      fetch: this.fetchImpl,
      directory,
    });
  }

  async checkHealth(): Promise<boolean> {
    try {
      const response = await this.client.global.health();
      return response.data !== undefined;
    } catch {
      return false;
    }
  }

  async listSessions(directory = this.directory): Promise<OpenCodeSessionRecord[]> {
    const response = await this.client.session.list(
      directory ? { directory } : undefined,
    );
    return requireData(response.data, 'OpenCode session list missing response data').map((s) => ({
      id: s.id,
      title: s.title,
      directory: s.directory,
      parentID: s.parentID,
      time: {
        created: s.time?.created,
        updated: s.time?.updated,
      },
    }));
  }

  async createSession(
    input: { title?: string; parentID?: string },
    directory = this.directory,
  ): Promise<OpenCodeSessionRecord> {
    const response = await this.client.session.create({
      ...input,
      ...(directory ? { directory } : {}),
    });
    const s = requireData(response.data, 'OpenCode session creation missing response data');
    return {
      id: s.id,
      title: s.title,
      directory: s.directory,
      parentID: s.parentID,
      time: {
        created: s.time?.created,
        updated: s.time?.updated,
      },
    };
  }

  async getSession(sessionId: string, directory = this.directory): Promise<OpenCodeSessionRecord> {
    const response = await this.client.session.get({
      sessionID: sessionId,
      ...(directory ? { directory } : {}),
    });
    const s = requireData(response.data, 'OpenCode session lookup missing response data');
    return {
      id: s.id,
      title: s.title,
      directory: s.directory,
      parentID: s.parentID,
      time: {
        created: s.time?.created,
        updated: s.time?.updated,
      },
    };
  }

  async destroySession(sessionId: string, directory = this.directory): Promise<void> {
    await this.client.session.delete({
      sessionID: sessionId,
      ...(directory ? { directory } : {}),
    });
  }

  async sendMessage(
    sessionId: string,
    input: { parts: Array<{ type: 'text'; text: string }> },
    directory = this.directory,
  ): Promise<void> {
    await this.client.session.prompt({
      sessionID: sessionId,
      parts: input.parts,
      ...(directory ? { directory } : {}),
    });
  }

  async listProviders(): Promise<OpenCodeProviderRecord[]> {
    const response = await this.client.provider.list();
    const providers = requireData(response.data, 'OpenCode provider list missing response data').all;
    return providers.map((provider) => ({
      id: provider.id,
      name: provider.name,
    }));
  }

  async getSessionStatuses(directory = this.directory): Promise<Record<string, SessionStatus>> {
    const response = await this.client.session.status(
      directory ? { directory } : undefined,
    );
    return requireData(response.data, 'OpenCode session status missing response data') as Record<string, SessionStatus>;
  }

  /**
   * Subscribe to the OpenCode SSE event stream, scoped to the given directory.
   * Returns an async iterable of parsed events. Ends when the signal is aborted.
   */
  async *subscribeToEvents(
    signal: AbortSignal,
    directory = this.directory,
  ): AsyncGenerator<{ type: string; properties: Record<string, unknown> }> {
    const result = await this.client.event.subscribe(
      directory ? { directory } : undefined,
    );
    for await (const event of result.stream) {
      if (signal.aborted) break;
      const raw = event as unknown as { type: string; properties: Record<string, unknown> };
      if (raw?.type) yield raw;
    }
  }

  async getQuestions(directory = this.directory): Promise<PendingQuestion[]> {
    const response = await this.client.question.list(
      directory ? { directory } : undefined,
    );
    return requireData(response.data, 'OpenCode question list missing response data') as PendingQuestion[];
  }

  /**
   * Reply to a pending question request.
   * @param answers One entry per question in the request; each entry is the
   *   array of selected labels (supports multi-select questions).
   *   For a single-select question pass `[['label']]`.
   */
  async respondToQuestion(
    requestId: string,
    answers: string[][],
    directory = this.directory,
  ): Promise<void> {
    await this.client.question.reply({
      requestID: requestId,
      answers,
      ...(directory ? { directory } : {}),
    });
  }

  async rejectQuestion(requestId: string, directory = this.directory): Promise<void> {
    await this.client.question.reject({
      requestID: requestId,
      ...(directory ? { directory } : {}),
    });
  }

  async abortSession(sessionId: string, directory = this.directory): Promise<boolean> {
    const response = await this.client.session.abort({
      sessionID: sessionId,
      ...(directory ? { directory } : {}),
    });
    return requireData(response.data, 'OpenCode abort missing response data');
  }

  async respondToPermission(
    permissionId: string,
    response: 'allow' | 'deny',
    remember?: boolean,
    directory = this.directory,
  ): Promise<boolean> {
    const reply = response === 'allow'
      ? (remember ? 'always' : 'once')
      : 'reject';
    await this.client.permission.reply({
      requestID: permissionId,
      reply,
      ...(directory ? { directory } : {}),
    });
    return true;
  }
}
