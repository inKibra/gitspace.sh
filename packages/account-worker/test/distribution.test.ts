import { expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { HttpResponse, http } from 'msw';
import worker from '../src/index.js';
import { network } from './network.js';

const clientPath = `${env.PLATFORM_URL}/__platform/tenants/${env.TENANT_ID}/machine-release/client`;
const sha256 = 'a'.repeat(64);
const get = (path: string) => worker.fetch(new Request(`${env.ACCOUNT_URL}${path}`), env);
const platformRequests: string[] = [];
function platformClient() {
  platformRequests.length = 0;
  network.use(
    http.get(`${clientPath}/:platform`, ({ request, params }) => {
      platformRequests.push(new URL(request.url).pathname);
      if (request.headers.get('authorization') !== `Bearer ${env.PLATFORM_TOKEN}`) return new HttpResponse(null, { status: 401 });
      return HttpResponse.json({ release: params.platform === 'linux-x64' ? 'develop-570989e89ca1' : '1.0.0-rc.20261028.2', platform: params.platform, sha256, size: 6 });
    }),
    http.get(`${clientPath}/linux-x64/:release`, ({ params }) => params.release === 'develop-570989e89ca1'
      ? new HttpResponse(new TextEncoder().encode('client'), { headers: { 'content-type': 'application/octet-stream', 'content-length': '6' } })
      : new HttpResponse(null, { status: 404 })),
  );
}

it('serves an installer that installs from this account and pairs with --pair', async () => {
  const response = await get('/install');
  expect(response.status).toBe(200);
  const script = await response.text();
  expect(script).toContain('base="${GITSPACE_DISTRIBUTION_URL:-https://test.gitspace.sh/distribution/v1}"');
  expect(script).toContain('"${install_dir}/gitspace" machine setup --pair "$pair"');
});

it('answers the stable channel with the client the platform names for the account release', async () => {
  platformClient();
  const linux = await get('/distribution/v1/stable/linux-x64.txt');
  expect(linux.status).toBe(200);
  expect(await linux.text()).toBe(`gitspace-distribution-v1\ndevelop-570989e89ca1\n${sha256}\n`);
  const darwin = await get('/distribution/v1/stable/darwin-arm64.txt');
  expect(await darwin.text()).toBe(`gitspace-distribution-v1\n1.0.0-rc.20261028.2\n${sha256}\n`);
});

it('refuses an unknown platform without asking the platform', async () => {
  platformClient();
  expect((await get('/distribution/v1/stable/windows-x64.txt')).status).toBe(404);
  expect((await get('/distribution/v1/releases/develop-570989e89ca1/windows-x64/gitspace')).status).toBe(404);
  expect(platformRequests).toEqual([]);
});

it('streams the named client and refuses any other release', async () => {
  platformClient();
  const download = await get('/distribution/v1/releases/develop-570989e89ca1/linux-x64/gitspace');
  expect(download.status).toBe(200);
  expect(download.headers.get('content-length')).toBe('6');
  expect(new TextDecoder().decode(await download.arrayBuffer())).toBe('client');
  expect((await get('/distribution/v1/releases/1.0.0-rc.20260905.3/linux-x64/gitspace')).status).toBe(404);
});

it('fails the channel when the platform cannot name a client', async () => {
  network.use(http.get(`${clientPath}/:platform`, () => HttpResponse.json({ error: { code: 'MACHINE_CLIENT_UNAVAILABLE' } }, { status: 409 })));
  expect((await get('/distribution/v1/stable/linux-x64.txt')).status).toBe(503);
});
