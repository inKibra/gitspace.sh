/**
 * Fetches of URLs a caller names reach public addresses only: the agents' `web_fetch` (as its `fetch`), an MCP
 * client's `inspector.artifacts.import`, and a prompt's URL attachments (`prompt-attachments.ts`).
 *
 * Workers have no resolver API, and `fetch` resolves a name itself, so each request's host is checked before it is
 * sent. An address literal is checked against `isPrivateOrLocalHost` from `agents/webfetch` (the table `web_fetch`
 * already checks literals with: loopback, private, link-local, CGNAT, multicast and reserved IPv4; loopback, ULA and
 * link-local IPv6; and IPv6 forms carrying an IPv4 address, IPv4-mapped included, judged as that IPv4 address). A
 * name is resolved through Cloudflare's DNS-over-HTTPS JSON API (`cloudflare-dns.com`) for its A and AAAA records,
 * and refused when it has none or when any answer is such an address. A name whose answers change between the check
 * and the fetch (DNS rebinding) is not caught by this check.
 */
import { createHash } from 'node:crypto';
import { isPrivateOrLocalHost } from 'agents/webfetch';
import { z } from 'zod';

const DOH_URL = 'https://cloudflare-dns.com/dns-query';
/** DNS record types by name: the ones that carry an address. */
const ADDRESS_RECORDS: Record<string, number> = { A: 1, AAAA: 28 };
const REDIRECT_STATUSES: Record<number, true> = { 301: true, 302: true, 303: true, 307: true, 308: true };
/** `Status` 0 is NOERROR and 3 NXDOMAIN (no such name); `Answer` holds CNAME records as well as addresses. */
const DohResponseSchema = z.object({ Status: z.number().int(), Answer: z.array(z.object({ type: z.number().int(), data: z.string() })).optional() });

/** Redirects one file fetch follows, each checked again. */
export const PUBLIC_FILE_MAX_REDIRECTS = 3;
/** How long fetching one file may take, body included: within the 30 s an MCP tool call is given (`@gitspace/mcp-server`). */
export const PUBLIC_FILE_TIMEOUT_MS = 25_000;

/** `address` (an A or AAAA answer) as the URL parser writes a host, so IPv6 is compared in one canonical form. */
function addressHost(address: string): string {
  try { return new URL(`https://${address.includes(':') ? `[${address}]` : address}/`).hostname; } catch { return ''; }
}

async function resolve(host: string, record: string, signal: AbortSignal | null): Promise<string[]> {
  const query = new URL(DOH_URL);
  query.searchParams.set('name', host);
  query.searchParams.set('type', record);
  const response = await fetch(query, { headers: { accept: 'application/dns-json' }, ...(signal ? { signal } : {}) });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`${host} could not be resolved (DNS answered ${response.status})`);
  }
  const answer = DohResponseSchema.parse(await response.json());
  if (answer.Status === 3) return [];
  if (answer.Status !== 0) throw new Error(`${host} could not be resolved (DNS status ${answer.Status})`);
  return (answer.Answer ?? []).filter(item => item.type === ADDRESS_RECORDS[record]).map(item => item.data);
}

/** Throws unless `url`'s host is public (see the module comment). */
export async function assertPublicHost(url: URL, signal: AbortSignal | null = null): Promise<void> {
  const host = url.hostname;
  if (isPrivateOrLocalHost(host)) throw new Error(`${host} is a private or local address`);
  if (host.startsWith('[') || /^[0-9.]+$/u.test(host)) return;
  const answers = (await Promise.all(Object.keys(ADDRESS_RECORDS).map(record => resolve(host, record, signal)))).flat();
  if (answers.length === 0) throw new Error(`${host} does not resolve to an address`);
  const refused = answers.find(address => isPrivateOrLocalHost(addressHost(address)));
  if (refused !== undefined) throw new Error(`${host} resolves to a private or local address (${refused})`);
}

/** `fetch` to a public host only (`assertPublicHost` first). `web_fetch` sends every hop it follows through it. */
export async function publicFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = new Request(input, init);
  await assertPublicHost(new URL(request.url), request.signal);
  return fetch(request);
}

export interface PublicFile {
  /** The bytes as they arrive. The stream errors past `maxBytes`, when it ends empty, and (with `sha256`) when it ends
   * with another digest, so a writer reading it to the end never finishes such a file. */
  readonly body: ReadableStream<Uint8Array>;
  /** The response's `Content-Type` without parameters, or null. */
  readonly mediaType: string | null;
  /** The response's `Content-Disposition` file name, else the final URL's last path segment, or null. */
  readonly fileName: string | null;
}

/** `Content-Disposition`'s `filename*` (RFC 5987) or `filename`, else the last segment of `url`'s path. */
function fileNameOf(response: Response, url: URL): string | null {
  const disposition = response.headers.get('content-disposition') ?? '';
  const extended = /filename\*\s*=\s*[^']*'[^']*'([^;]+)/iu.exec(disposition)?.[1];
  const plain = /filename\s*=\s*(?:"([^"]*)"|([^;]+))/iu.exec(disposition);
  const segment = url.pathname.slice(url.pathname.lastIndexOf('/') + 1);
  for (const candidate of [extended, plain?.[1] ?? plain?.[2], segment]) {
    if (!candidate?.trim()) continue;
    try { return decodeURIComponent(candidate.trim()); } catch { return candidate.trim(); }
  }
  return null;
}

/** Counts, caps and (with `sha256`) hashes the bytes passing through; see `PublicFile.body`. */
function checked(maxBytes: number, sha256: string | undefined): TransformStream<Uint8Array, Uint8Array> {
  let size = 0;
  const hash = sha256 === undefined ? null : createHash('sha256');
  return new TransformStream({
    transform(chunk, controller) {
      size += chunk.byteLength;
      if (size > maxBytes) throw new Error(`The file is larger than ${maxBytes / 1024 / 1024} MiB`);
      hash?.update(chunk);
      controller.enqueue(chunk);
    },
    flush() {
      if (size === 0) throw new Error('The file is empty');
      if (hash && hash.digest('hex') !== sha256) throw new Error('The file does not match the given sha256');
    },
  });
}

/**
 * One whole file from a public https URL: every hop must be https to a public host (`assertPublicHost`), at most
 * `PUBLIC_FILE_MAX_REDIRECTS` redirects are followed, `206 Partial Content` and any other non-2xx answer are refused,
 * and the body is capped at `maxBytes` as it streams (a `Content-Length` above it is refused at once; a smaller one is
 * not trusted). `sha256` is the whole file's hexadecimal digest. Messages name the host, never the URL, which may hold
 * a signature. `own` is this account: a Worker cannot fetch its own hostname (Cloudflare answers 530), so a hop to the
 * account's `/files/` link is served by `own.serve` in this isolate, and any other path of the account is refused.
 */
export async function fetchPublicFile(url: string, options: { maxBytes: number; sha256?: string; signal: AbortSignal; own?: { origin: string; serve(request: Request): Promise<Response> } }): Promise<PublicFile> {
  let target: URL;
  try { target = new URL(url); } catch { throw new Error('The file URL is not a valid URL'); }
  for (let redirects = 0; ; redirects++) {
    if (target.protocol !== 'https:') throw new Error(`Files are fetched over https only; ${target.host || target.protocol} is not https`);
    const own = options.own && target.origin === options.own.origin ? options.own : null;
    if (own && !target.pathname.startsWith('/files/')) throw new Error(`Only ${target.host}/files/ links of this account are fetched`);
    const response = own ? await own.serve(new Request(target, { signal: options.signal })) : await publicFetch(target, { redirect: 'manual', signal: options.signal });
    const location = REDIRECT_STATUSES[response.status] ? response.headers.get('location') : null;
    if (location !== null) {
      await response.body?.cancel();
      if (redirects === PUBLIC_FILE_MAX_REDIRECTS) throw new Error(`${target.host} redirected more than ${PUBLIC_FILE_MAX_REDIRECTS} times`);
      target = new URL(location, target);
      continue;
    }
    if (response.status === 206 || !response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error(response.status === 206 ? `${target.host} answered 206 Partial Content; the whole file is needed` : `${target.host} answered ${response.status}`);
    }
    if (Number(response.headers.get('content-length')) > options.maxBytes) {
      await response.body.cancel();
      throw new Error(`The file is larger than ${options.maxBytes / 1024 / 1024} MiB`);
    }
    const mediaType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() || null;
    return { body: response.body.pipeThrough(checked(options.maxBytes, options.sha256)), mediaType, fileName: fileNameOf(response, target) };
  }
}
