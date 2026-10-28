import { z } from 'zod';
import { mirrorNatives, nativeMirrorKey, portableNativesSchema, type NativeMirror } from '@gitspace/protocol/machine-release';

/** Upstream native files in RELEASES under `natives/sha256/<sha256>`. R2 checks each object's SHA-256 again as it stores it. */
export function releasesNativeMirror(bucket: R2Bucket): NativeMirror {
  return {
    async has(sha256) {
      return await bucket.head(nativeMirrorKey(sha256)) !== null;
    },
    async put(native, body) {
      const fixed = new FixedLengthStream(native.size);
      const piping = new AbortController();
      const [stored, piped] = await Promise.allSettled([
        bucket.put(nativeMirrorKey(native.sha256), fixed.readable, { sha256: native.sha256, httpMetadata: { contentType: 'application/octet-stream' } }).catch((error: unknown) => {
          // A put that fails without draining the body would leave the pipe waiting on it.
          piping.abort(error);
          throw error;
        }),
        body.pipeTo(fixed.writable, { signal: piping.signal }),
      ]);
      // A failed body (bytes that differ from the pin) is the cause of the failed put it aborts.
      if (piped.status === 'rejected') throw piped.reason;
      if (stored.status === 'rejected') throw stored.reason;
    },
  };
}

const mirrorRequestSchema = z.object({ natives: portableNativesSchema }).strict();

/**
 * `POST /machine-release/natives` `{ natives }`: copies into the mirror each upstream native a tenant's portable release
 * names that the mirror lacks, refusing bytes that differ from the named SHA-256 and size. Answers the SHA-256 of each
 * file copied. Caller authenticates the tenant's platform token before entering this helper.
 */
export async function nativeMirrorResponse(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { allow: 'POST' } });
  const parsed = mirrorRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: { code: 'INVALID_NATIVES', message: z.prettifyError(parsed.error).slice(0, 4_096) } }, { status: 400 });
  try {
    const copied = await mirrorNatives(parsed.data.natives, releasesNativeMirror(env.RELEASES), url => fetch(url, { signal: AbortSignal.timeout(5 * 60_000) }));
    return Response.json({ copied });
  } catch (error) {
    return Response.json({ error: { code: 'NATIVE_MIRROR_FAILED', message: error instanceof Error ? error.message : 'Mirroring the native files failed' } }, { status: 502 });
  }
}
