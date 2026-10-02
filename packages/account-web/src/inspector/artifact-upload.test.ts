import { createHash } from 'node:crypto';
import { ARTIFACT_UPLOAD_CHUNK_BYTES, ARTIFACT_UPLOAD_MAX_BYTES, rpcErrors } from '@gitspace/protocol/rpc-contract';
import { ClientNetworkFailure } from 'result-rpc';
import { describe, expect, it, vi } from 'vitest';
import { ArtifactUploadRejected, uploadArtifactFile, type ArtifactUploadClient, type ArtifactUploadSession } from './artifact-upload.js';

const url = 'local://workspace/uploads/data.zip';
const artifact = { kind: 'artifact' as const, url, hash: 'hash', label: 'uploads/data.zip', mediaType: null, generation: 1 };

function contents(size: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(size);
  for (let index = 0; index < size; index += 1) bytes[index] = (index * 31 + 7) % 251;
  return bytes;
}

/** A strict in-memory authority: offsets must be sequential and every chunk must match its hash. */
function authority(failures: Array<(offset: number) => Error | null> = []) {
  let stored = new Uint8Array(0);
  const offsets: number[] = [];
  const client = {
    begin: vi.fn<ArtifactUploadClient['begin']>(async () => ({ uploadId: 'upload-1', url, chunkBytes: ARTIFACT_UPLOAD_CHUNK_BYTES })),
    chunk: vi.fn<ArtifactUploadClient['chunk']>(async ({ uploadId, offset, sha256, data }) => {
      offsets.push(offset);
      expect(uploadId).toBe('upload-1');
      const failure = failures.shift()?.(offset);
      if (failure) throw failure;
      const bytes = Buffer.from(data, 'base64');
      expect(offset).toBe(stored.length);
      expect(bytes.length).toBeLessThanOrEqual(ARTIFACT_UPLOAD_CHUNK_BYTES);
      expect(sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
      const next = new Uint8Array(stored.length + bytes.length);
      next.set(stored);
      next.set(bytes, stored.length);
      stored = next;
      return { received: stored.length };
    }),
    commit: vi.fn<ArtifactUploadClient['commit']>(async () => artifact),
    abort: vi.fn<ArtifactUploadClient['abort']>(async () => undefined),
  };
  return { client, offsets, stored: () => stored };
}

describe('uploadArtifactFile', () => {
  it('streams a multi-chunk file in sequential verified slices and commits once all bytes are acknowledged', async () => {
    const bytes = contents(ARTIFACT_UPLOAD_CHUNK_BYTES * 2 + 1_234);
    const file = new File([bytes], 'data.zip', { type: 'application/zip' });
    const wholeRead = vi.spyOn(file, 'arrayBuffer');
    const { client, offsets, stored } = authority();
    const sessions: ArtifactUploadSession[] = [];

    await expect(uploadArtifactFile(client, file, { signal: new AbortController().signal, onSession: (session) => sessions.push(session) })).resolves.toEqual(artifact);

    expect(client.begin).toHaveBeenCalledWith({ fileName: 'data.zip', size: bytes.length, mediaType: 'application/zip' });
    expect(offsets).toEqual([0, ARTIFACT_UPLOAD_CHUNK_BYTES, ARTIFACT_UPLOAD_CHUNK_BYTES * 2]);
    expect(sessions.map((session) => session.received)).toEqual([0, ARTIFACT_UPLOAD_CHUNK_BYTES, ARTIFACT_UPLOAD_CHUNK_BYTES * 2, bytes.length]);
    expect(stored()).toEqual(bytes);
    expect(client.commit).toHaveBeenCalledExactlyOnceWith('upload-1');
    expect(client.commit.mock.invocationCallOrder[0]).toBeGreaterThan(client.chunk.mock.invocationCallOrder.at(-1)!);
    expect(wholeRead).not.toHaveBeenCalled();
  });

  it('retries a transient chunk failure at the same offset and continues from there', async () => {
    const bytes = contents(ARTIFACT_UPLOAD_CHUNK_BYTES + 10);
    const { client, offsets, stored } = authority([() => null, () => ClientNetworkFailure({ retryable: true })]);

    await expect(uploadArtifactFile(client, new File([bytes], 'data.zip'), { signal: new AbortController().signal, onSession() {}, retryDelaysMs: [0] })).resolves.toEqual(artifact);

    expect(offsets).toEqual([0, ARTIFACT_UPLOAD_CHUNK_BYTES, ARTIFACT_UPLOAD_CHUNK_BYTES]);
    expect(stored()).toEqual(bytes);
    expect(client.commit).toHaveBeenCalledOnce();
  });

  it('stops without committing once transient retries are exhausted or the authority rejects the chunk', async () => {
    const transient = authority([() => ClientNetworkFailure({ retryable: true }), () => ClientNetworkFailure({ retryable: true })]);
    await expect(uploadArtifactFile(transient.client, new File([contents(10)], 'a.bin'), { signal: new AbortController().signal, onSession() {}, retryDelaysMs: [0] })).rejects.toMatchObject({ _tag: 'client/network-failure' });
    expect(transient.offsets).toEqual([0, 0]);
    expect(transient.client.commit).not.toHaveBeenCalled();

    const rejected = authority([() => rpcErrors.inspectorState({ resource: 'upload', message: 'Chunk hash mismatch' })]);
    await expect(uploadArtifactFile(rejected.client, new File([contents(10)], 'a.bin'), { signal: new AbortController().signal, onSession() {}, retryDelaysMs: [0, 0] })).rejects.toMatchObject({ _tag: rpcErrors.inspectorState.tag });
    expect(rejected.offsets).toEqual([0]);
    expect(rejected.client.commit).not.toHaveBeenCalled();
  });

  it('resumes an acknowledged session without beginning a new upload', async () => {
    const bytes = contents(ARTIFACT_UPLOAD_CHUNK_BYTES + 10);
    const { client, offsets } = authority();
    await client.chunk({ uploadId: 'upload-1', offset: 0, sha256: createHash('sha256').update(bytes.subarray(0, ARTIFACT_UPLOAD_CHUNK_BYTES)).digest('hex'), data: Buffer.from(bytes.subarray(0, ARTIFACT_UPLOAD_CHUNK_BYTES)).toString('base64') }, new AbortController().signal);

    await uploadArtifactFile(client, new File([bytes], 'data.zip'), { signal: new AbortController().signal, onSession() {}, resume: { uploadId: 'upload-1', url, chunkBytes: ARTIFACT_UPLOAD_CHUNK_BYTES, received: ARTIFACT_UPLOAD_CHUNK_BYTES } });

    expect(client.begin).not.toHaveBeenCalled();
    expect(offsets).toEqual([0, ARTIFACT_UPLOAD_CHUNK_BYTES]);
    expect(client.commit).toHaveBeenCalledOnce();
  });

  it('rejects files over 1 GiB before beginning an upload', async () => {
    const file = new File([], 'huge.zip');
    Object.defineProperty(file, 'size', { value: ARTIFACT_UPLOAD_MAX_BYTES + 1 });
    const { client } = authority();

    const upload = uploadArtifactFile(client, file, { signal: new AbortController().signal, onSession() {} });

    await expect(upload).rejects.toBeInstanceOf(ArtifactUploadRejected);
    await expect(upload).rejects.toThrow('uploads are limited to 1 GiB');
    expect(client.begin).not.toHaveBeenCalled();
  });
});
