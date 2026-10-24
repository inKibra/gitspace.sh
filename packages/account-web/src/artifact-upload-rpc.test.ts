import { describe, expect, it, vi } from 'vitest';
import { artifactUploadRpcClient } from './artifact-upload-rpc.js';
import { isTransientUploadError } from './inspector/artifact-upload.js';

const link = 'https://account.test/api/uploads/token-1';

function linkClient(replies: Array<Response | Error>) {
  const send = vi.fn<typeof fetch>(async () => {
    const reply = replies.shift()!;
    if (reply instanceof Error) throw reply;
    return reply;
  });
  return { send, client: artifactUploadRpcClient({ spaceId: 'workspace 1', expectedGeneration: 4 }, ({ workspaceId }) => workspaceId === 'workspace 1' ? 7 : 0, send) };
}

describe('artifact uploads through a link', () => {
  it('PUTs raw part bytes to the link without credentials, retrying lost connections and gateway failures but not refusals', async () => {
    const { send, client } = linkClient([
      Response.json({ status: 'ok', value: { received: 3 } }),
      new TypeError('Failed to fetch'),
      new Response('bad gateway', { status: 502 }),
      Response.json({ status: 'error', error: { code: 'UPLOAD_PART_REJECTED', message: 'Expected part 2' } }, { status: 409 }),
      Response.json({ status: 'error', error: { code: 'UPLOAD_LINK_EXPIRED', message: 'The upload link expired.' } }, { status: 410 }),
    ]);
    const bytes = new Uint8Array([1, 2, 3]);
    const signal = new AbortController().signal;

    await expect(client.part({ link, partNumber: 1, bytes }, signal)).resolves.toEqual({ received: 3 });
    const [target, init] = send.mock.calls[0]!;
    expect(target).toBe(`${link}/parts/1`);
    expect(init).toMatchObject({ method: 'PUT', body: bytes, signal, credentials: 'omit', headers: { 'content-type': 'application/octet-stream' } });
    expect(Object.keys(init?.headers ?? {})).toEqual(['content-type']);

    for (const partNumber of [2, 3]) {
      const transient = await client.part({ link, partNumber, bytes }, signal).catch((error: unknown) => error);
      expect(isTransientUploadError(transient)).toBe(true);
    }
    for (const message of ['Expected part 2', 'The upload link expired.']) {
      const refused = await client.part({ link, partNumber: 4, bytes }, signal).catch((error: unknown) => error);
      expect(isTransientUploadError(refused)).toBe(false);
      expect(refused).toMatchObject({ message });
    }
  });

  it('lets a part abandoned by its own signal reject with the abort, not a retry', async () => {
    const controller = new AbortController();
    const { client } = linkClient([new DOMException('aborted', 'AbortError')]);
    controller.abort();

    const error = await client.part({ link, partNumber: 1, bytes: new Uint8Array([1]) }, controller.signal).catch((reason: unknown) => reason);
    expect(isTransientUploadError(error)).toBe(false);
    expect(error).toMatchObject({ name: 'AbortError' });
  });

  it('completes through the link into an artifact reference pinned to its scope generation', async () => {
    const { send, client } = linkClient([
      Response.json({ status: 'ok', value: { url: 'drive://workspace/uploads/report.pdf', path: 'uploads/report.pdf', hash: 'sha256:abc', size: 3, mediaType: 'application/pdf', scope: 'workspace', workspaceId: 'workspace 1' } }),
    ]);

    await expect(client.commit(link)).resolves.toEqual({ kind: 'artifact', url: 'drive://workspace/uploads/report.pdf', hash: 'sha256:abc', label: 'uploads/report.pdf', mediaType: 'application/pdf', generation: 7 });
    expect(send).toHaveBeenCalledExactlyOnceWith(`${link}/complete`, expect.objectContaining({ method: 'POST', credentials: 'omit' }));
  });

  it('keeps a failed completion retryable only when the server, not the request, failed', async () => {
    const { client } = linkClient([
      new Response('unavailable', { status: 503 }),
      Response.json({ status: 'error', error: { code: 'UPLOAD_HASH_MISMATCH', message: 'The bytes do not match the digest.' } }, { status: 409 }),
    ]);

    expect(isTransientUploadError(await client.commit(link).catch((error: unknown) => error))).toBe(true);
    const refused = await client.commit(link).catch((error: unknown) => error);
    expect(isTransientUploadError(refused)).toBe(false);
    expect(refused).toMatchObject({ message: 'The bytes do not match the digest.' });
  });

  it('abandons the upload by deleting its link', async () => {
    const { send, client } = linkClient([
      Response.json({ status: 'ok', value: { aborted: true } }),
      Response.json({ status: 'error', error: { code: 'UPLOAD_LINK_UNKNOWN', message: 'Unknown upload link.' } }, { status: 404 }),
    ]);

    await expect(client.abort(link)).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledWith(link, expect.objectContaining({ method: 'DELETE', credentials: 'omit' }));
    await expect(client.abort(link)).rejects.toThrow('Unknown upload link.');
  });
});
