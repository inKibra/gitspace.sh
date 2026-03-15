import type { OpenCodeBridgeBackend } from '../session/backend.js';
import {
  decodeBridgeBody,
  encodeBridgeBody,
  type OpenCodeBridgeStreamEvent,
} from './opencode-bridge.js';
import type { SessionStatus } from './opencode-event-types.js';

export interface OpenCodeRelayClientOptions {
  backend: OpenCodeBridgeBackend;
  workspaceId: string;
}

export class OpenCodeRelayClient {
  private readonly backend: OpenCodeBridgeBackend;
  private readonly workspaceId: string;

  constructor(options: OpenCodeRelayClientOptions) {
    this.backend = options.backend;
    this.workspaceId = options.workspaceId;
  }

  async listSessions(): Promise<unknown> {
    const response = await this.backend.requestOpenCode({
      workspaceId: this.workspaceId,
      method: 'GET',
      path: '/session',
    });

    return JSON.parse(Buffer.from(decodeBridgeBody(response.bodyBase64)).toString('utf8'));
  }

  async createSession(title?: string): Promise<unknown> {
    const response = await this.backend.requestOpenCode({
      workspaceId: this.workspaceId,
      method: 'POST',
      path: '/session',
      headers: {
        'content-type': 'application/json',
      },
      bodyBase64: encodeBridgeBody(JSON.stringify({ title })),
    });

    return JSON.parse(Buffer.from(decodeBridgeBody(response.bodyBase64)).toString('utf8'));
  }

  async getSessionMessages(sessionId: string): Promise<unknown> {
    const response = await this.backend.requestOpenCode({
      workspaceId: this.workspaceId,
      method: 'GET',
      path: `/session/${encodeURIComponent(sessionId)}/message`,
    });

    return JSON.parse(Buffer.from(decodeBridgeBody(response.bodyBase64)).toString('utf8'));
  }

  async subscribe(handler: (event: OpenCodeBridgeStreamEvent) => void): Promise<() => Promise<void>> {
    return this.backend.subscribeOpenCode(
      {
        workspaceId: this.workspaceId,
        path: '/event',
      },
      handler,
    );
  }

  async getSessionStatuses(): Promise<Record<string, SessionStatus>> {
    const response = await this.backend.requestOpenCode({
      workspaceId: this.workspaceId,
      method: 'GET',
      path: '/session/status',
    });
    return JSON.parse(Buffer.from(decodeBridgeBody(response.bodyBase64)).toString('utf8'));
  }

  async abortSession(sessionId: string): Promise<boolean> {
    const response = await this.backend.requestOpenCode({
      workspaceId: this.workspaceId,
      method: 'POST',
      path: `/session/${encodeURIComponent(sessionId)}/abort`,
    });
    return JSON.parse(Buffer.from(decodeBridgeBody(response.bodyBase64)).toString('utf8'));
  }

  async respondToPermission(
    sessionId: string,
    permissionId: string,
    response: 'allow' | 'deny',
    remember?: boolean,
  ): Promise<boolean> {
    const resp = await this.backend.requestOpenCode({
      workspaceId: this.workspaceId,
      method: 'POST',
      path: `/session/${encodeURIComponent(sessionId)}/permissions/${encodeURIComponent(permissionId)}`,
      headers: { 'content-type': 'application/json' },
      bodyBase64: encodeBridgeBody(JSON.stringify({ response, remember })),
    });
    return JSON.parse(Buffer.from(decodeBridgeBody(resp.bodyBase64)).toString('utf8'));
  }
}
