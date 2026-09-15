import { afterAll, afterEach, beforeAll, beforeEach } from 'vitest';
import { env, reset } from 'cloudflare:test';
import { HttpResponse, http } from 'msw';
import { network } from './network.js';

export const tenantRootPrivateKey = Uint8Array.from({ length: 32 }, (_, index) => index + 1);

beforeAll(() => network.enable());
beforeEach(() => network.use(http.get(`${env.PLATFORM_URL}/__platform/tenants/${env.TENANT_ID}/state`, ({ request }) => {
  if (request.headers.get('authorization') !== `Bearer ${env.PLATFORM_TOKEN}`) return new HttpResponse(null, { status: 401 });
  return HttpResponse.json({ control: { status: 'active' } });
})));
afterEach(async () => {
  network.resetHandlers();
  await reset();
});
afterAll(() => network.disable());
