import { HttpResponse, http } from 'msw';

/** Cloudflare's DNS-over-HTTPS JSON API (`public-fetch.ts`) answering for `zone`: each name's A and AAAA addresses; a
 * name not in it does not exist (NXDOMAIN). */
export function dnsAnswers(zone: Record<string, { A?: string[]; AAAA?: string[] }>) {
  return http.get('https://cloudflare-dns.com/dns-query', ({ request }) => {
    const query = new URL(request.url);
    const name = query.searchParams.get('name') ?? '';
    const record = query.searchParams.get('type') === 'AAAA' ? 'AAAA' : 'A';
    const addresses = zone[name];
    if (!addresses) return HttpResponse.json({ Status: 3 });
    return HttpResponse.json({ Status: 0, Answer: (addresses[record] ?? []).map(data => ({ name, type: record === 'A' ? 1 : 28, TTL: 60, data })) });
  });
}

/** A PNG's signature and header, as small as a file can be. */
export const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 0x1f, 0x15, 0xc4, 0x89]);
