import { DurableObject } from 'cloudflare:workers';
import { AccountBrowserRelay, browserRelayArchive } from '../../src/browser-relay.js';
import { RuntimeAccountBrowserAuthorizationSchema, RuntimeBrowserTrustSchema, RuntimeProjectBrowserPreferencesSchema } from '@gitspace/protocol-runtime';
import { z } from 'zod';

type FixtureEnv = { RELAY: DurableObjectNamespace<BrowserRelayFixture> };
export class BrowserRelayFixture extends DurableObject<FixtureEnv> {
  private readonly browser = new AccountBrowserRelay(this.ctx, { ACCOUNT_ID: 'account' });
  async fetch(request: Request) {
    const url = new URL(request.url);
    if (url.pathname === '/api/browser-relay/extension') return this.browser.fetch(request);
    if (url.pathname === '/pair') return Response.json(await this.browser.pair(RuntimeBrowserTrustSchema.parse(await request.json()), url.origin));
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
}
export default { fetch(request: Request, env: FixtureEnv) { return env.RELAY.get(env.RELAY.idFromName('account')).fetch(request); } };
