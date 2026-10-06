import { z } from 'zod';
import { GitLfsObjectSchema, type GitLfsObject } from './lfs.js';
import { collectBytes, streamBytes } from './byte-stream.js';

const DownloadResponse = z.object({ objects: z.array(GitLfsObjectSchema.extend({
  error: z.unknown().optional(),
  actions: z.object({ download: z.object({ href: z.string().url(), header: z.record(z.string(), z.string()).optional() }).optional() }).optional(),
})) });

type LfsBatchInput = {
  endpoint: string;
  objects: readonly GitLfsObject[];
  headers?: HeadersInit;
  fetcher?: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>;
  signal?: AbortSignal;
};

async function downloadActions(input: LfsBatchInput): Promise<z.infer<typeof DownloadResponse>['objects']> {
  if (!input.objects.length) return [];
  try {
    const endpoint = new URL(input.endpoint);
    if (!['https:', 'http:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) return [];
    endpoint.pathname = `${endpoint.pathname.replace(/\/$/u, '')}/objects/batch`;
    endpoint.hash = '';
    const headers = new Headers(input.headers);
    headers.set('accept', 'application/vnd.git-lfs+json');
    headers.set('content-type', 'application/vnd.git-lfs+json');
    const response = await (input.fetcher ?? fetch)(endpoint, {
      method: 'POST', headers, redirect: 'error', signal: input.signal,
      body: JSON.stringify({ operation: 'download', transfers: ['basic'], objects: input.objects }),
    });
    if (!response.ok || response.redirected || !response.body) {
      void response.body?.cancel().catch(() => undefined);
      return [];
    }
    // The batch reply is metadata, not a payload. Bound even a hostile server's JSON.
    const bytes = await collectBytes(streamBytes(response.body, input.signal), Math.max(64 * 1024, input.objects.length * 4096));
    const parsed = DownloadResponse.safeParse(JSON.parse(new TextDecoder().decode(bytes)));
    if (!parsed.success) return [];
    const requested = new Map(input.objects.map(object => [object.oid, object.size]));
    return parsed.data.objects.filter(object => {
      const action = object.actions?.download;
      if (object.error !== undefined || !action) return false;
      const url = new URL(action.href);
      return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password
        && requested.get(object.oid) === object.size;
    });
  } catch {
    // Unavailable, unauthorized and malformed answers are not origin ownership evidence.
    return [];
  }
}

/** A batch download action proves availability without fetching the payload. Never follow redirects. */
export async function confirmGitLfsObjects(input: LfsBatchInput): Promise<GitLfsObject[]> {
  const confirmed = new Map((await downloadActions(input)).map(object => [object.oid, object.size]));
  return input.objects.filter(object => confirmed.get(object.oid) === object.size);
}

/** Query credentials stay on the machine; native git-lfs appends batch paths after the query. */
export async function downloadGitLfsObject(input: Omit<LfsBatchInput, 'objects'> & { object: GitLfsObject }): Promise<AsyncIterable<Uint8Array> | null> {
  const [object] = await downloadActions({ ...input, objects: [input.object] });
  const action = object?.actions?.download;
  if (!action) return null;
  try {
    // Origin credentials must not be forwarded to a separate download host.
    const response = await (input.fetcher ?? fetch)(action.href, { headers: action.header, redirect: 'error', signal: input.signal });
    if (!response.ok || response.redirected || !response.body) {
      void response.body?.cancel().catch(() => undefined);
      return null;
    }
    const body = response.body;
    return (async function* () {
      let received = 0;
      for await (const chunk of streamBytes(body, input.signal)) {
        if (chunk.byteLength > input.object.size - received) throw new Error('LFS download exceeds declared size');
        received += chunk.byteLength;
        yield chunk;
      }
      if (received !== input.object.size) throw new Error('LFS download has an unexpected size');
    })();
  } catch { return null; }
}
