import { env, SELF } from 'cloudflare:test';
import { expect, it } from 'vitest';

const manifest = 'defaults/releases/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/manifest.json';

it('serves the catalog and published release files with their length, and HEAD without a body', async () => {
  await env.CHANNEL.put('catalog.json', '{"schemaVersion":1,"releases":[]}');
  await env.CHANNEL.put(manifest, '{"commit":"a"}');
  const catalog = await SELF.fetch('https://channel.internal/catalog.json');
  expect([catalog.status, await catalog.text()]).toEqual([200, '{"schemaVersion":1,"releases":[]}']);
  const head = await SELF.fetch(`https://channel.internal/${manifest}`, { method: 'HEAD' });
  expect([head.status, head.headers.get('content-length'), head.headers.get('etag') !== null, await head.text()]).toEqual([200, '14', true, '']);
  expect((await SELF.fetch('https://channel.internal/defaults/releases/missing/manifest.json')).status).toBe(404);
});

it('never writes or deletes, and serves nothing outside the published releases', async () => {
  await env.CHANNEL.put(manifest, 'published');
  await env.CHANNEL.put('defaults/account.json', 'pointer');
  for (const method of ['PUT', 'POST', 'DELETE']) {
    const response = await SELF.fetch(`https://channel.internal/${manifest}`, { method, body: method === 'DELETE' ? undefined : 'replaced' });
    expect(response.status).toBe(405);
  }
  expect(await (await env.CHANNEL.get(manifest))?.text()).toBe('published');
  expect((await SELF.fetch('https://channel.internal/defaults/account.json')).status).toBe(404);
});
