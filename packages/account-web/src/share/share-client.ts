import { RuntimeBrowserShareJoinedSchema, RuntimeBrowserSharePreviewSchema, RuntimeBrowserShareServerMessageSchema } from '@gitspace/protocol-runtime';
import type { RuntimeBrowserSharePreview, RuntimeBrowserShareServerMessage, RuntimeBrowserShareViewerMessage } from '@gitspace/protocol-runtime';
import { z } from 'zod';
import { createDeviceSignedFetch } from '../device.js';
import { currentDevice, deviceRejected } from '../device-session.js';

export type ShareJoined = z.infer<typeof RuntimeBrowserShareJoinedSchema>;

/** A refused share request: `SHARE_UNKNOWN` (no such share, or a wrong secret), `SHARE_ENDED`, `SHARE_FULL`, or another
 * code the server or the network gave. */
export class ShareRequestError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) {
    super(message);
    this.name = 'ShareRequestError';
  }
}

const OkSchema = z.object({ status: z.literal('ok'), value: z.unknown() });
const FailureSchema = z.object({ error: z.object({ code: z.string(), message: z.string().optional() }) });
const signedFetch = createDeviceSignedFetch(currentDevice, deviceRejected);

async function shareRequest(shareId: string, action: 'preview' | 'join', body: object, signed: boolean): Promise<unknown> {
  const url = new URL(`/api/shares/${encodeURIComponent(shareId)}/${action}`, window.location.origin);
  const init: RequestInit = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store' };
  const response = await (signed ? signedFetch(url, init) : fetch(url, init));
  const answer: unknown = await response.json().catch(() => null);
  const ok = OkSchema.safeParse(answer);
  if (response.ok && ok.success) return ok.data.value;
  const failure = FailureSchema.safeParse(answer);
  throw new ShareRequestError(failure.data?.error.code ?? `HTTP_${response.status}`, response.status, failure.data?.error.message ?? `The share answered ${response.status}`);
}

/** The greeting: who shares what, until when. Redeems nothing. `signed`: with this browser's enrolled device, which also
 * learns the name of the shared tab's Chrome. */
export async function previewShare(shareId: string, secret: string, signed: boolean): Promise<RuntimeBrowserSharePreview> {
  return RuntimeBrowserSharePreviewSchema.parse(await shareRequest(shareId, 'preview', { secret }, signed));
}

/** Joins as a viewer. `signed`: with this browser's enrolled device, so the account's owner joins under their own name. */
export async function joinShare(shareId: string, secret: string, name: string, signed: boolean): Promise<ShareJoined> {
  return RuntimeBrowserShareJoinedSchema.parse(await shareRequest(shareId, 'join', { secret, name }, signed));
}

export interface ShareLive {
  send(message: RuntimeBrowserShareViewerMessage): void;
  close(): void;
}

/**
 * The live socket of one join: says hello with the join's token first, then carries the viewer's messages. Messages sent
 * before the socket opens wait for it (only the latest of each type). Server messages that do not match the schema are
 * dropped. `dropped` fires once when the socket closes without `close()`.
 */
export function openShareLive(shareId: string, token: string, handlers: { message(message: RuntimeBrowserShareServerMessage): void; dropped(): void }): ShareLive {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(`${protocol}//${window.location.host}/api/shares/${encodeURIComponent(shareId)}/live`);
  const waiting = new Map<RuntimeBrowserShareViewerMessage['type'], RuntimeBrowserShareViewerMessage>();
  let closed = false;
  socket.addEventListener('open', () => {
    socket.send(JSON.stringify({ type: 'hello', token } satisfies RuntimeBrowserShareViewerMessage));
    for (const message of waiting.values()) socket.send(JSON.stringify(message));
    waiting.clear();
  });
  socket.addEventListener('message', (event: MessageEvent) => {
    if (closed || typeof event.data !== 'string') return;
    let data: unknown;
    try { data = JSON.parse(event.data); } catch { return; }
    const parsed = RuntimeBrowserShareServerMessageSchema.safeParse(data);
    if (parsed.success) handlers.message(parsed.data);
  });
  socket.addEventListener('close', () => {
    if (closed) return;
    closed = true;
    handlers.dropped();
  });
  return {
    send(message) {
      if (closed) return;
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
      else waiting.set(message.type, message);
    },
    close() {
      closed = true;
      socket.close(1000);
    },
  };
}
