import { DurableObject } from 'cloudflare:workers';
import { AccountBrowserRelay, browserRelayArchive } from '../../src/browser-relay.js';
import { RuntimeAccountBrowserAuthorizationSchema, RuntimeBrowserTrustSchema, RuntimeProjectBrowserPreferencesSchema } from '@gitspace/protocol-runtime';
import { z } from 'zod';

type FixtureEnv = { RELAY: DurableObjectNamespace<BrowserRelayFixture> };
export class BrowserRelayFixture extends DurableObject<FixtureEnv> {
  // This fixture hosts the relay alone, with no workspaces: group reports and page comments have nowhere to go and are
  // dropped, there is no drive for captures or uploads, share links have no account to name or seal their viewers, and
  // there is no alarm for their deadlines.
  private readonly browser = new AccountBrowserRelay(this.ctx, { ACCOUNT_ID: 'account', SPACE_AUTHORITY: { getByName: () => ({ browserGroupReported: async () => {}, browserCommentWrite: async () => { throw new Error('This fixture keeps no comments'); }, browserComments: async () => [], captureReplayAsked: async () => {} }) }, USER_PROJECTS: { getByName: () => ({ list: async () => [] }) } }, () => { throw new Error('This fixture has no drive'); }, { url: 'https://account.test', name: async () => 'account', viewer: async () => null }, async () => {}, async () => true);
  async fetch(request: Request) {
    const url = new URL(request.url);
    if (url.pathname === '/api/browser-relay/extension') return this.browser.fetch(request);
    if (url.pathname === '/pair') {
      // GitSpace starts the pairing; the extension redeems its short code for the pairing's details, answered here.
      const redeemed = await this.browser.redeemPairingCode((await this.browser.pair(RuntimeBrowserTrustSchema.parse(await request.json()))).code, '127.0.0.1', url.origin);
      return redeemed.ok ? Response.json(redeemed.value) : Response.json({ error: redeemed.message }, { status: redeemed.status });
    }
    if (url.pathname === '/status') return Response.json(await this.browser.status());
    if (url.pathname === '/placement') { const body = z.object({ projectId: z.string(), pairingId: z.string().uuid().optional() }).parse(await request.json()); return Response.json(await this.browser.placement(body.projectId, body.pairingId)); }
    if (url.pathname === '/project-update') { const body = z.object({ projectId: z.string(), expectedRevision: z.number().int().nonnegative(), preferences: RuntimeProjectBrowserPreferencesSchema }).parse(await request.json()); return Response.json(await this.browser.setProjectSettings(body.projectId, body.expectedRevision, body.preferences)); }
    if (url.pathname === '/unpair') return Response.json(await this.browser.unpair(z.object({ pairingId: z.string().uuid() }).parse(await request.json()).pairingId));
    if (url.pathname === '/confirm') { const body = z.object({ pairingId: z.string().uuid(), fingerprint: z.string() }).parse(await request.json()); return Response.json(await this.browser.confirm(body.pairingId, body.fingerprint)); }
    if (url.pathname === '/extension.zip') return new Response(Uint8Array.from(browserRelayArchive(url.origin)).buffer);
    if (url.pathname === '/execute') {
      try { return Response.json(await this.browser.execute(RuntimeAccountBrowserAuthorizationSchema.parse(await request.json()))); }
      catch (error) { return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 403 }); }
    }
    return new Response('Not found', { status: 404 });
  }
  webSocketMessage(socket: WebSocket, data: string | ArrayBuffer) { return this.browser.webSocketMessage(socket, data); }
  webSocketClose(socket: WebSocket) { this.browser.webSocketClose(socket); }
  webSocketError(socket: WebSocket) { this.browser.webSocketError(socket); }
}
export default { fetch(request: Request, env: FixtureEnv) { return env.RELAY.get(env.RELAY.idFromName('account')).fetch(request); } };
