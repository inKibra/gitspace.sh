import { createHash } from 'node:crypto';
import { DRIVE_FILE_MAX_BYTES, TENANT_OBJECT_PART_BYTES } from '@gitspace/protocol';
import { rpcErrors } from '@gitspace/protocol/rpc-contract';
import { ClientNetworkFailure } from 'result-rpc';
import { describe, expect, it, vi } from 'vitest';
import { ArtifactUploadRejected, uploadArtifactFile, uploadRejection, type ArtifactUploadClient, type ArtifactUploadSession } from './artifact-upload.js';

/** A small part size from begin, so files of a few parts stay small. */
const PART = 256 * 1024;
const url = 'drive://workspace/uploads/data.zip';
const link = 'https://account.test/api/uploads/token-1';
const artifact = { kind: 'artifact' as const, url, hash: 'hash', label: 'uploads/data.zip', mediaType: null, generation: 1 };

function contents(size: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(size);
  for (let index = 0; index < size; index += 1) bytes[index] = (index * 31 + 7) % 251;
  return bytes;
}

/** A strict in-memory authority: parts must arrive in order, each `partBytes` long except the last. */
function authority(failures: Array<(offset: number) => Error | null> = [], partBytes = PART) {
  let stored = new Uint8Array(0);
  const offsets: number[] = [];
  const sizes: number[] = [];
  const client = {
    begin: vi.fn<ArtifactUploadClient['begin']>(async () => ({ link, url, partBytes })),
    part: vi.fn<ArtifactUploadClient['part']>(async ({ link: partLink, partNumber, bytes }) => {
      const offset = (partNumber - 1) * partBytes;
      offsets.push(offset);
      expect(partLink).toBe(link);
      const failure = failures.shift()?.(offset);
      if (failure) throw failure;
      expect(offset).toBe(stored.length);
      expect(bytes.length).toBeLessThanOrEqual(partBytes);
      sizes.push(bytes.length);
      const next = new Uint8Array(stored.length + bytes.length);
      next.set(stored);
      next.set(bytes, stored.length);
      stored = next;
      return { received: stored.length };
    }),
    commit: vi.fn<ArtifactUploadClient['commit']>(async () => artifact),
    abort: vi.fn<ArtifactUploadClient['abort']>(async () => undefined),
  };
  return { client, offsets, sizes, stored: () => stored };
}

describe('uploadArtifactFile', () => {
  it('sends a multi-part file in sequential raw parts and commits once all bytes are acknowledged', async () => {
    const bytes = contents(PART * 2 + 1_234);
    const file = new File([bytes], 'data.zip', { type: 'application/zip' });
    const wholeRead = vi.spyOn(file, 'arrayBuffer');
    const { client, offsets, stored } = authority();
    const sessions: ArtifactUploadSession[] = [];

    await expect(uploadArtifactFile(client, file, { signal: new AbortController().signal, onSession: (session) => sessions.push(session) })).resolves.toEqual(artifact);

    expect(client.begin).toHaveBeenCalledWith({ fileName: 'data.zip', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), mediaType: 'application/zip' });
    expect(offsets).toEqual([0, PART, PART * 2]);
    expect(sessions.map((session) => session.received)).toEqual([0, PART, PART * 2, bytes.length]);
    expect(stored()).toEqual(bytes);
    expect(client.commit).toHaveBeenCalledExactlyOnceWith(link);
    expect(client.commit.mock.invocationCallOrder[0]).toBeGreaterThan(client.part.mock.invocationCallOrder.at(-1)!);
    expect(wholeRead).not.toHaveBeenCalled();
  });

  it('hashes a file larger than one read in slices and begins with the whole file\'s digest', async () => {
    const bytes = contents(4 * 1024 * 1024 * 2 + 5);
    const { client } = authority();
    const controller = new AbortController();
    // Stop after begin: this test is about the digest, not the parts.
    client.begin.mockImplementationOnce(async () => { controller.abort(); return { link, url, partBytes: PART }; });
    const hashed: number[] = [];

    await expect(uploadArtifactFile(client, new File([bytes], 'big.bin'), { signal: controller.signal, onSession() {}, onHashed: (count) => hashed.push(count) })).rejects.toThrow();

    expect(hashed).toEqual([4 * 1024 * 1024, 8 * 1024 * 1024, bytes.length]);
    expect(client.begin).toHaveBeenCalledExactlyOnceWith({ fileName: 'big.bin', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), mediaType: null });
  });

  it('stops hashing and never begins an upload cancelled while the file is being hashed', async () => {
    const controller = new AbortController();
    const { client } = authority();
    const hashed: number[] = [];

    await expect(uploadArtifactFile(client, new File([contents(4 * 1024 * 1024 + 1)], 'big.bin'), { signal: controller.signal, onSession() {}, onHashed: (count) => { hashed.push(count); controller.abort(); } })).rejects.toThrow();

    expect(hashed).toEqual([4 * 1024 * 1024]);
    expect(client.begin).not.toHaveBeenCalled();
  });

  it('retries a transient part failure with the same part and continues from there', async () => {
    const bytes = contents(PART + 10);
    const { client, offsets, stored } = authority([() => null, () => ClientNetworkFailure({ retryable: true })]);

    await expect(uploadArtifactFile(client, new File([bytes], 'data.zip'), { signal: new AbortController().signal, onSession() {}, retryDelaysMs: [0] })).resolves.toEqual(artifact);

    expect(offsets).toEqual([0, PART, PART]);
    expect(stored()).toEqual(bytes);
    expect(client.commit).toHaveBeenCalledOnce();
  });

  it('stops without committing once transient retries are exhausted or the authority rejects the part', async () => {
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
    const bytes = contents(PART + 10);
    const { client, offsets } = authority();
    await client.part({ link, partNumber: 1, bytes: bytes.subarray(0, PART) }, new AbortController().signal);

    await uploadArtifactFile(client, new File([bytes], 'data.zip'), { signal: new AbortController().signal, onSession() {}, resume: { link, url, partBytes: PART, received: PART } });

    expect(client.begin).not.toHaveBeenCalled();
    expect(offsets).toEqual([0, PART]);
    expect(client.commit).toHaveBeenCalledOnce();
  });

  it('sends a file larger than one account part as 32 MiB parts and a short last part', async () => {
    const { client, sizes, stored } = authority([], TENANT_OBJECT_PART_BYTES);

    await uploadArtifactFile(client, new File([new Uint8Array(TENANT_OBJECT_PART_BYTES + 10)], 'screen.webm'), { signal: new AbortController().signal, onSession() {} });

    expect(client.part.mock.calls.map(([input]) => input.partNumber)).toEqual([1, 2]);
    expect(sizes).toEqual([TENANT_OBJECT_PART_BYTES, 10]);
    expect(stored().length).toBe(TENANT_OBJECT_PART_BYTES + 10);
    expect(client.commit).toHaveBeenCalledOnce();
  });

  it('accepts files over the former 16 MiB limit', () => {
    expect(uploadRejection({ size: 16 * 1024 * 1024 + 1 })).toBeNull();
  });

  it('rejects files over the drive file limit before beginning an upload', async () => {
    const file = new File([], 'huge.zip');
    Object.defineProperty(file, 'size', { value: DRIVE_FILE_MAX_BYTES + 1 });
    const { client } = authority();

    const upload = uploadArtifactFile(client, file, { signal: new AbortController().signal, onSession() {} });

    await expect(upload).rejects.toBeInstanceOf(ArtifactUploadRejected);
    await expect(upload).rejects.toThrow('uploads are limited to 1 GiB');
    expect(client.begin).not.toHaveBeenCalled();
  });
});
