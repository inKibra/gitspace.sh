import { afterAll, afterEach, beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { HttpResponse, http } from 'msw';
import { network } from './network.js';

beforeAll(() => network.enable());
beforeEach(() => network.use(http.get('https://platform.test/__platform/operator/tenants/:handle', async ({ params }) => {
  const account = await env.ACCOUNTS.getByName('global').getByHandle(String(params.handle));
  if (!account) return new HttpResponse(null, { status: 404 });
  return HttpResponse.json({
    control: { status: account.status === 'active' ? 'active' : account.status, reason: account.reason, updatedAt: null },
    credits: null,
    usage: { records: 0, debitedMicros: 0 },
    deployment: { active: account.tenantRelease, uploadedAt: null, appliedMigrationTag: null },
  });
})));
afterEach(() => network.resetHandlers());
afterAll(() => network.disable());
