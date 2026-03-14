import { createHash } from 'node:crypto';
import type { OpenCodeBridgeBackend } from '../session/backend.js';
import { decodeBridgeBody, encodeBridgeBody } from './opencode-bridge.js';

export interface OpenCodeLocalBridgeHandle {
  workspaceId: string;
  baseUrl: string;
  stop: () => Promise<void>;
}

interface BridgeEntry {
  handle: OpenCodeLocalBridgeHandle;
  server: ReturnType<typeof Bun.serve>;
}

const bridgeEntries = new Map<string, BridgeEntry>();

function hashToPort(key: string): number {
  const hash = createHash('sha256').update(key).digest();
  return 44000 + (hash.readUInt16BE(0) % 10000);
}

function getContentType(headers?: Record<string, string>): string {
  return headers?.['content-type'] ?? headers?.['Content-Type'] ?? 'application/octet-stream';
}

function buildSseChunk(event?: string, data?: string, id?: string): string {
  const lines: string[] = [];
  if (id) {
    lines.push(`id: ${id}`);
  }
  if (event) {
    lines.push(`event: ${event}`);
  }
  for (const line of (data ?? '').split('\n')) {
    lines.push(`data: ${line}`);
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

export async function ensureOpenCodeLocalBridge(options: {
  backend: OpenCodeBridgeBackend;
  workspaceId: string;
}): Promise<OpenCodeLocalBridgeHandle> {
  const existing = bridgeEntries.get(options.workspaceId);
  if (existing) {
    return existing.handle;
  }

  let lastError: unknown = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const port = hashToPort(`${options.workspaceId}:${attempt}`);
    try {
      const server = Bun.serve({
        hostname: '127.0.0.1',
        port,
        fetch: async (request) => {
          const url = new URL(request.url);
          const path = url.pathname;
          const query = Object.fromEntries(url.searchParams.entries());

          if (path === '/event') {
            let unsubscribe: (() => Promise<void>) | undefined;
            const stream = new ReadableStream<Uint8Array>({
              async start(controller) {
                const encoder = new TextEncoder();
                controller.enqueue(encoder.encode(buildSseChunk('server.connected', JSON.stringify({ workspaceId: options.workspaceId }))));
                unsubscribe = await options.backend.subscribeOpenCode(
                  { workspaceId: options.workspaceId, path, query },
                  (event) => {
                    controller.enqueue(encoder.encode(buildSseChunk(event.event, event.data, event.id)));
                  },
                );
              },
              async cancel() {
                await unsubscribe?.();
              },
            });

            return new Response(stream, {
              headers: {
                'content-type': 'text/event-stream; charset=utf-8',
                'cache-control': 'no-cache',
                connection: 'keep-alive',
                'access-control-allow-origin': '*',
              },
            });
          }

          const bodyBytes = request.method === 'GET' || request.method === 'HEAD'
            ? undefined
            : new Uint8Array(await request.arrayBuffer());

          const response = await options.backend.requestOpenCode({
            workspaceId: options.workspaceId,
            method: request.method as 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
            path,
            query,
            headers: (() => {
              const headers: Record<string, string> = {};
              request.headers.forEach((value, key) => {
                headers[key] = value;
              });
              return headers;
            })(),
            bodyBase64: encodeBridgeBody(bodyBytes),
          });

          return new Response(Buffer.from(decodeBridgeBody(response.bodyBase64)), {
            status: response.status,
            headers: {
              ...response.headers,
              'content-type': getContentType(response.headers),
              'access-control-allow-origin': '*',
            },
          });
        },
      });

      const handle: OpenCodeLocalBridgeHandle = {
        workspaceId: options.workspaceId,
        baseUrl: `http://127.0.0.1:${server.port}`,
        stop: async () => {
          server.stop(true);
          bridgeEntries.delete(options.workspaceId);
        },
      };
      bridgeEntries.set(options.workspaceId, { handle, server });
      return handle;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Failed to start OpenCode local bridge');
}
