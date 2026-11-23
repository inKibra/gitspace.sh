import { createHash } from 'node:crypto';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { fetchPublicFile, publicFetch, type PublicFile } from '../src/public-fetch.js';
import { network } from './network.js';
import { dnsAnswers, png } from './public-network.js';

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const fetchFile = (url: string, more: { maxBytes?: number; sha256?: string } = {}) => fetchPublicFile(url, { maxBytes: 1024, signal: AbortSignal.timeout(5_000), ...more });
const bytesOf = async (file: PublicFile) => new Uint8Array(await new Response(file.body).arrayBuffer());
const PUBLIC = { A: ['93.184.216.34'], AAAA: ['2606:2800:220:1:248:1893:25c8:1946'] };

describe('fetching a file a caller names', () => {
  it('fetches a whole public https file with its type and name, checking its sha256', async () => {
    network.use(dnsAnswers({ 'files.example.com': PUBLIC }), http.get('https://files.example.com/signed/abc', () => new HttpResponse(png, {
      headers: { 'content-type': 'image/png; charset=binary', 'content-disposition': 'attachment; filename="dot.png"' },
    })));
    const file = await fetchFile('https://files.example.com/signed/abc?X-Signature=secret', { sha256: sha256(png) });
    expect({ mediaType: file.mediaType, fileName: file.fileName }).toEqual({ mediaType: 'image/png', fileName: 'dot.png' });
    expect(await bytesOf(file)).toEqual(png);
  });

  it('refuses http, address literals that are not public, and names with any answer that is not', async () => {
    network.use(dnsAnswers({
      'files.example.com': PUBLIC,
      'mapped.example.com': { A: ['93.184.216.34'], AAAA: ['::ffff:10.0.0.7'] },
      'cgnat.example.com': { A: ['100.64.0.9'] },
      'loopback.example.com': { A: ['127.0.0.1'] },
      'ula.example.com': { AAAA: ['fd00::1'] },
      'nothing.example.com': {},
    }), http.get('https://*/*', () => new HttpResponse(png)), http.get('http://*/*', () => new HttpResponse(png)));
    await expect(fetchFile('http://files.example.com/dot.png')).rejects.toThrow('https only');
    for (const host of ['127.0.0.1', '[::1]', '10.1.2.3', '169.254.169.254', '[::ffff:192.168.0.1]', 'localhost']) {
      await expect(fetchFile(`https://${host}/dot.png`)).rejects.toThrow('private or local address');
    }
    for (const host of ['mapped', 'cgnat', 'loopback', 'ula']) {
      await expect(fetchFile(`https://${host}.example.com/dot.png`)).rejects.toThrow(`${host}.example.com resolves to a private or local address`);
    }
    await expect(fetchFile('https://nothing.example.com/dot.png')).rejects.toThrow('does not resolve');
    await expect(fetchFile('https://unknown.example.com/dot.png')).rejects.toThrow('does not resolve');
  });

  it('checks every redirect again, and follows at most three', async () => {
    network.use(dnsAnswers({ 'files.example.com': PUBLIC, 'internal.example.com': { A: ['10.0.0.1'] } }), http.get('https://files.example.com/:hop', ({ params }) => {
      const hop = String(params.hop);
      const to: Record<string, string> = {
        private: 'https://internal.example.com/secret', plain: 'http://files.example.com/dot.png', hop1: '/hop2', hop2: '/hop3', hop3: '/dot.png', loop1: '/loop2', loop2: '/loop3', loop3: '/loop4', loop4: '/dot.png',
      };
      return to[hop] ? new HttpResponse(null, { status: 302, headers: { location: to[hop] } }) : new HttpResponse(png, { headers: { 'content-type': 'image/png' } });
    }));
    await expect(fetchFile('https://files.example.com/private')).rejects.toThrow('internal.example.com resolves to a private or local address (10.0.0.1)');
    await expect(fetchFile('https://files.example.com/plain')).rejects.toThrow('https only');
    expect(await bytesOf(await fetchFile('https://files.example.com/hop1'))).toEqual(png);
    await expect(fetchFile('https://files.example.com/loop1')).rejects.toThrow('redirected more than 3 times');
  });

  it('refuses a partial answer, an error answer, and a file past the cap whether or not it declares its length', async () => {
    const large = new Uint8Array(4096).fill(7);
    network.use(dnsAnswers({ 'files.example.com': PUBLIC }), http.get('https://files.example.com/:name', ({ params }) => {
      if (params.name === 'partial') return new HttpResponse(png, { status: 206, headers: { 'content-range': `bytes 0-${png.byteLength - 1}/9999` } });
      if (params.name === 'missing') return new HttpResponse(null, { status: 404 });
      if (params.name === 'declared') return new HttpResponse(large, { headers: { 'content-length': String(large.byteLength) } });
      if (params.name === 'empty') return new HttpResponse(new Uint8Array(0));
      // Streamed with no length: the cap is applied to the bytes as they arrive.
      return new HttpResponse(new ReadableStream({ start(controller) { for (let chunk = 0; chunk < 4; chunk++) controller.enqueue(large.subarray(chunk * 1024, (chunk + 1) * 1024)); controller.close(); } }));
    }));
    await expect(fetchFile('https://files.example.com/partial')).rejects.toThrow('206 Partial Content');
    await expect(fetchFile('https://files.example.com/missing')).rejects.toThrow('answered 404');
    await expect(fetchFile('https://files.example.com/declared')).rejects.toThrow('larger than');
    await expect(bytesOf(await fetchFile('https://files.example.com/streamed'))).rejects.toThrow('larger than');
    await expect(bytesOf(await fetchFile('https://files.example.com/empty'))).rejects.toThrow('empty');
  });

  it('ends the body in an error when its bytes do not match the sha256 given', async () => {
    network.use(dnsAnswers({ 'files.example.com': PUBLIC }), http.get('https://files.example.com/dot.png', () => new HttpResponse(png)));
    await expect(bytesOf(await fetchFile('https://files.example.com/dot.png', { sha256: '0'.repeat(64) }))).rejects.toThrow('does not match the given sha256');
  });

  it('serves the account\'s own /files/ link in place, never fetching its own hostname, and refuses its other paths', async () => {
    const served: string[] = [];
    const own = { origin: 'https://account.example.com', serve: async (request: Request) => { served.push(new URL(request.url).pathname); return new Response(png, { headers: { 'content-type': 'image/png' } }); } };
    network.use(dnsAnswers({ 'files.example.com': PUBLIC }), http.get('https://files.example.com/to-own', () => new HttpResponse(null, { status: 302, headers: { location: 'https://account.example.com/files/token-2' } })));
    const file = await fetchPublicFile('https://account.example.com/files/token-1', { maxBytes: 1024, signal: AbortSignal.timeout(5_000), own, sha256: sha256(png) });
    expect(await bytesOf(file)).toEqual(png);
    // A public link redirecting to the account's own file is served the same way.
    expect(await bytesOf(await fetchPublicFile('https://files.example.com/to-own', { maxBytes: 1024, signal: AbortSignal.timeout(5_000), own }))).toEqual(png);
    expect(served).toEqual(['/files/token-1', '/files/token-2']);
    await expect(fetchPublicFile('https://account.example.com/v1/rpc', { maxBytes: 1024, signal: AbortSignal.timeout(5_000), own })).rejects.toThrow('Only account.example.com/files/ links');
  });

  it('refuses a web_fetch hop to a name that resolves to a private address', async () => {
    network.use(dnsAnswers({ 'internal.example.com': { A: ['192.168.1.20'] }, 'files.example.com': PUBLIC }), http.get('https://*/*', () => HttpResponse.text('page')));
    await expect(publicFetch('https://internal.example.com/admin', { redirect: 'manual' })).rejects.toThrow('resolves to a private or local address');
    expect(await (await publicFetch('https://files.example.com/page')).text()).toBe('page');
  });
});
