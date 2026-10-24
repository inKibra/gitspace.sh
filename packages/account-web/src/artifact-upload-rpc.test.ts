import { describe, expect, it, vi } from 'vitest';
import { artifactUploadRpcClient } from './artifact-upload-rpc.js';
import { isTransientUploadError } from './inspector/artifact-upload.js';

describe('artifact upload parts', () => {
  it('PUTs raw part bytes to the space-scoped part URL and maps gateway failures to retries, refusals to final errors', async () => {
    const replies = [
      Response.json({ status: 'ok', value: { received: 3 } }),
      new Response('bad gateway', { status: 502 }),
      Response.json({ status: 'error', error: { code: 'UPLOAD_PART_REJECTED', message: 'Expected part 2' } }, { status: 409 }),
    ];
    const fetchPart = vi.fn<typeof fetch>(async () => replies.shift()!);
    const client = artifactUploadRpcClient({ spaceId: 'workspace 1', expectedGeneration: 4 }, () => 1, fetchPart);
    const bytes = new Uint8Array([1, 2, 3]);
    const signal = new AbortController().signal;
    const uploadId = '0b7c8a52-5d3c-4c1e-9f2a-3f6e1b2c4d5e';

    await expect(client.part({ uploadId, partNumber: 1, bytes }, signal)).resolves.toEqual({ received: 3 });
    const [target, init] = fetchPart.mock.calls[0]!;
    expect(target).toBe(`/api/drive/uploads/${uploadId}/parts/1?spaceId=workspace+1&expectedGeneration=4`);
    expect(init).toMatchObject({ method: 'PUT', body: bytes, signal });

    const transient = await client.part({ uploadId, partNumber: 2, bytes }, signal).catch((error: unknown) => error);
    expect(isTransientUploadError(transient)).toBe(true);
    const refused = await client.part({ uploadId, partNumber: 3, bytes }, signal).catch((error: unknown) => error);
    expect(isTransientUploadError(refused)).toBe(false);
    expect(refused).toMatchObject({ message: 'Expected part 2' });
  });
});
