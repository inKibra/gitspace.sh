import { SERVICE_FORWARD_ORIGIN_HEADER } from '@gitspace/protocol/service-access';
import { z } from 'zod';
import type { RuntimeBrowserRelayChannel } from './browser-relay-transport.js';
import { BrowserServicePolicy, BrowserServicePaused, type BrowserWorkspaceServiceHostname } from './browser-service-policy.js';

export type BrowserServiceForward = { url: string; headers: Record<string, string>; close(): Promise<void> };
export type BrowserServiceAccess = { serviceHostname(hostname: string): boolean; workspaceServiceHostname: BrowserWorkspaceServiceHostname; serviceForward(hostname: string): Promise<BrowserServiceForward> };
const Paused = z.object({ method: z.literal('Fetch.requestPaused'), sessionId: z.string(), params: BrowserServicePaused });
/** Fulfill hosted requests through the authenticated localhost owner, never their public hostname. */
export async function attachBrowserServiceForward(channel: RuntimeBrowserRelayChannel, sessionId: string, access: Pick<BrowserServiceAccess, 'serviceHostname' | 'serviceForward'>, fence: (error: unknown) => void, policy: BrowserServicePolicy) {
  const forwards = new Map<string, Promise<BrowserServiceForward>>();
  const unsubscribe = channel.subscribe(raw => {
    policy.observe(raw, sessionId);
    const parsed = Paused.safeParse(raw);
    if (!parsed.success || parsed.data.sessionId !== sessionId) return;
    const { requestId, request } = parsed.data.params;
    void (async () => {
      const destination = new URL(request.url);
      if (!access.serviceHostname(destination.hostname)) { await channel.send('Fetch.continueRequest', { requestId }, sessionId); return; }
      if (!await policy.allows(parsed.data.params)) { await channel.send('Fetch.failRequest', { requestId, errorReason: 'AccessDenied' }, sessionId); return; }
      let pending = forwards.get(destination.hostname);
      if (!pending) { pending = access.serviceForward(destination.hostname); forwards.set(destination.hostname, pending); }
      const forward = await pending, local = new URL(forward.url);
      if (local.protocol !== 'http:' || local.hostname !== '127.0.0.1') throw new Error('Service forward must bind localhost');
      local.pathname = destination.pathname; local.search = destination.search;
      const headers = new Headers(request.headers);
      const origin = headers.get('origin');
      // Strip page-supplied metadata before using the authenticated loopback
      // transport. Only this policy-approved request may preserve original Origin.
      headers.delete(SERVICE_FORWARD_ORIGIN_HEADER);
      if (origin !== null) {
        headers.set(SERVICE_FORWARD_ORIGIN_HEADER, origin);
        headers.set('origin', local.origin);
      }
      for (const [name, value] of Object.entries(forward.headers)) headers.set(name, value);
      const response = await fetch(local, { method: request.method, headers, ...(request.postData === undefined ? {} : { body: request.postData }), redirect: 'manual' });
      await channel.send('Fetch.fulfillRequest', { requestId, responseCode: response.status, responseHeaders: [...response.headers].map(([name, value]) => ({ name, value })), body: Buffer.from(await response.arrayBuffer()).toString('base64') }, sessionId);
    })().catch(async error => { fence(error); try { await channel.send('Fetch.failRequest', { requestId, errorReason: 'AccessDenied' }, sessionId); } catch {} });
  });
  policy.initialize(await channel.send('Page.getFrameTree', {}, sessionId));
  await channel.send('Network.enable', {}, sessionId);
  await channel.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }, sessionId);
  return async () => { unsubscribe(); await Promise.all([...forwards.values()].map(async pending => { const forward = await pending; await forward.close(); })); forwards.clear(); };
}
