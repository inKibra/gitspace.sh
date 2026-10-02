import type { EvidenceReference } from '@gitspace/protocol';
import { ARTIFACT_UPLOAD_MAX_BYTES } from '@gitspace/protocol/rpc-contract';
import { ClientHttpFailure, ClientNetworkFailure, ClientOffline, ClientTimeout, isTaggedError, ServerInternal } from 'result-rpc';

type ArtifactReference = Extract<EvidenceReference, { kind: 'artifact' }>;

/** Authority calls for one workspace's `uploads/` artifact folder; every method throws the RPC error on failure. */
export interface ArtifactUploadClient {
  begin(input: { fileName: string; size: number; mediaType: string | null }): Promise<{ uploadId: string; url: string; chunkBytes: number }>;
  /** `data` is the chunk's base64 encoding; `sha256` is the lowercase hex digest of its raw bytes. */
  chunk(input: { uploadId: string; offset: number; sha256: string; data: string }, signal: AbortSignal): Promise<{ received: number }>;
  /** Resolves with the registered artifact, which may precede its appearance in the published catalog. */
  commit(uploadId: string): Promise<ArtifactReference>;
  abort(uploadId: string): Promise<void>;
}

/** Server-acknowledged position of an upload; resuming continues at `received`. */
export interface ArtifactUploadSession {
  uploadId: string;
  url: string;
  chunkBytes: number;
  received: number;
}

export class ArtifactUploadRejected extends Error {}

// Only failures that leave the server's upload state intact are retried at the same offset.
const transientTags: Readonly<Record<string, true>> = {
  [ClientOffline.tag]: true,
  [ClientNetworkFailure.tag]: true,
  [ClientTimeout.tag]: true,
  [ClientHttpFailure.tag]: true,
  [ServerInternal.tag]: true,
};

export function isTransientUploadError(error: unknown): boolean {
  return isTaggedError(error) && transientTags[error._tag] === true;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB'] as const;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${Number.isInteger(value) ? value : value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

/** Rejects files the authority would refuse before any upload state is created. */
export function uploadRejection(file: Pick<File, 'size'>): string | null {
  if (file.size === 0) return 'Empty files cannot be uploaded.';
  if (file.size > ARTIFACT_UPLOAD_MAX_BYTES) return `This file is ${formatBytes(file.size)}; uploads are limited to ${formatBytes(ARTIFACT_UPLOAD_MAX_BYTES)}.`;
  return null;
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const cancel = (): void => { clearTimeout(timer); reject(signal.reason); };
  const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(); }, ms);
  signal.addEventListener('abort', cancel, { once: true });
  return promise;
}

export interface UploadArtifactOptions {
  signal: AbortSignal;
  /** Continue a session whose last failure left server state intact. */
  resume?: ArtifactUploadSession;
  /** Called after begin and after every acknowledged chunk. */
  onSession(session: ArtifactUploadSession): void;
  /** Backoff before each same-offset retry of a transient chunk failure; its length bounds the retries. */
  retryDelaysMs?: readonly number[];
}

/**
 * Streams `file` to the authority one chunk at a time: only the current slice is ever in memory,
 * and chunks are sent strictly in offset order.
 */
export async function uploadArtifactFile(client: ArtifactUploadClient, file: File, options: UploadArtifactOptions): Promise<ArtifactReference> {
  const rejection = uploadRejection(file);
  if (rejection) throw new ArtifactUploadRejected(rejection);
  const { signal, retryDelaysMs = [500, 1_000, 2_000] } = options;
  let session: ArtifactUploadSession;
  if (options.resume) session = options.resume;
  else {
    const begun = await client.begin({ fileName: file.name, size: file.size, mediaType: file.type || null });
    session = { ...begun, received: 0 };
    options.onSession(session);
    signal.throwIfAborted();
  }
  while (session.received < file.size) {
    const offset = session.received;
    const bytes = new Uint8Array(await file.slice(offset, Math.min(file.size, offset + session.chunkBytes)).arrayBuffer());
    const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (byte) => byte.toString(16).padStart(2, '0')).join('');
    let binary = '';
    for (let start = 0; start < bytes.length; start += 32 * 1024) binary += String.fromCharCode(...bytes.subarray(start, start + 32 * 1024));
    const data = btoa(binary);
    for (let attempt = 0; ; attempt += 1) {
      signal.throwIfAborted();
      try {
        const { received } = await client.chunk({ uploadId: session.uploadId, offset, sha256, data }, signal);
        if (received !== offset + bytes.byteLength) throw new Error(`The authority stored ${formatBytes(received)} where ${formatBytes(offset + bytes.byteLength)} was expected.`);
        session = { ...session, received };
        break;
      } catch (error) {
        const delay = retryDelaysMs[attempt];
        if (signal.aborted || delay === undefined || !isTransientUploadError(error)) throw error;
        await wait(delay, signal);
      }
    }
    options.onSession(session);
  }
  signal.throwIfAborted();
  return client.commit(session.uploadId);
}
