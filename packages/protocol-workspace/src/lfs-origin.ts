import { z } from 'zod';
import { GitLfsObjectSchema, type GitLfsObject } from './lfs.js';

const DownloadResponse = z.object({ objects: z.array(GitLfsObjectSchema.extend({
  error: z.unknown().optional(),
  actions: z.object({ download: z.object({ href: z.string().url(), header: z.record(z.string(), z.string()).optional() }).optional() }).optional(),
})) });

/** A batch download action proves availability without fetching the payload. Never follow redirects. */
export async function confirmGitLfsObjects(input: {
  endpoint: string;
  objects: readonly GitLfsObject[];
  headers?: HeadersInit;
  fetcher?: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>;
  signal?: AbortSignal;
}): Promise<GitLfsObject[]> {
  if (!input.objects.length) return [];
  try {
    const endpoint = new URL(input.endpoint);
    if (!['https:', 'http:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) return [];
    endpoint.pathname = `${endpoint.pathname.replace(/\/$/u, '')}/objects/batch`;
    const headers = new Headers(input.headers);
    headers.set('accept', 'application/vnd.git-lfs+json');
    headers.set('content-type', 'application/vnd.git-lfs+json');
    const response = await (input.fetcher ?? fetch)(endpoint, {
      method: 'POST', headers, redirect: 'error', signal: input.signal,
      body: JSON.stringify({ operation: 'download', transfers: ['basic'], objects: input.objects }),
    });
    if (!response.ok || response.redirected) return [];
    const parsed = DownloadResponse.safeParse(await response.json());
    if (!parsed.success) return [];
    const confirmed = new Map<string, number>();
    for (const object of parsed.data.objects) {
      const action = object.actions?.download;
      if (object.error !== undefined || !action) continue;
      const url = new URL(action.href);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) continue;
      confirmed.set(object.oid, object.size);
    }
    return input.objects.filter(object => confirmed.get(object.oid) === object.size);
  } catch {
    // Unavailable, unauthorized and malformed answers are not origin ownership evidence.
    return [];
  }
}
