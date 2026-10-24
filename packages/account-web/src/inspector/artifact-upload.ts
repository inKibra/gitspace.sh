import { DRIVE_FILE_MAX_BYTES, Sha256State, type EvidenceReference } from '@gitspace/protocol';
import { ClientHttpFailure, ClientNetworkFailure, ClientOffline, ClientTimeout, isTaggedError, ServerInternal } from 'result-rpc';

type ArtifactReference = Extract<EvidenceReference, { kind: 'artifact' }>;

/** Authority calls for one workspace's `uploads/` artifact folder; every method throws the authority's error on failure.
 * Begin answers with the upload's link, the whole authority for the parts, commit and abort that follow. */
export interface ArtifactUploadClient {
  /** `sha256` is the lowercase hex digest of the whole file; commit refuses bytes that do not match it. */
  begin(input: { fileName: string; size: number; sha256: string; mediaType: string | null }): Promise<{ link: string; url: string; partBytes: number }>;
  /** Sends part `partNumber` (1-based) through `link`: `partBytes` raw bytes, or the rest of the file for the last
   * part. Resending the last acknowledged part is safe. Resolves with the bytes the authority now holds. */
  part(input: { link: string; partNumber: number; bytes: Uint8Array<ArrayBuffer> }, signal: AbortSignal): Promise<{ received: number }>;
  /** Resolves with the registered artifact, which may precede its appearance in the published catalog. */
  commit(link: string): Promise<ArtifactReference>;
  abort(link: string): Promise<void>;
}

/** Server-acknowledged position of an upload; resuming continues at `received`. */
export interface ArtifactUploadSession {
  link: string;
  url: string;
  partBytes: number;
  received: number;
}

export class ArtifactUploadRejected extends Error {}

// Only failures that leave the server's upload state intact are retried with the same part.
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
  if (file.size > DRIVE_FILE_MAX_BYTES) return `This file is ${formatBytes(file.size)}; uploads are limited to ${formatBytes(DRIVE_FILE_MAX_BYTES)}.`;
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

/** Bytes read per step while hashing the whole file before begin; the signal is checked between steps. */
const HASH_SLICE_BYTES = 4 * 1024 * 1024;

export interface UploadArtifactOptions {
  signal: AbortSignal;
  /** Continue a session whose last failure left server state intact. */
  resume?: ArtifactUploadSession;
  /** Called as the whole file is hashed before begin, with the bytes hashed so far. */
  onHashed?(hashed: number): void;
  /** Called after begin and after every acknowledged part. */
  onSession(session: ArtifactUploadSession): void;
  /** Backoff before each retry of a transient part failure; its length bounds the retries. */
  retryDelaysMs?: readonly number[];
}

/**
 * Hashes `file` slice by slice (the authority stores it under its digest), then sends it as raw parts of the size begin
 * names, strictly in order: only the current part is ever in memory.
 */
export async function uploadArtifactFile(client: ArtifactUploadClient, file: File, options: UploadArtifactOptions): Promise<ArtifactReference> {
  const rejection = uploadRejection(file);
  if (rejection) throw new ArtifactUploadRejected(rejection);
  const { signal, retryDelaysMs = [500, 1_000, 2_000] } = options;
  let session: ArtifactUploadSession;
  if (options.resume) session = options.resume;
  else {
    const state = new Sha256State();
    for (let offset = 0; offset < file.size; offset += HASH_SLICE_BYTES) {
      signal.throwIfAborted();
      state.update(new Uint8Array(await file.slice(offset, Math.min(file.size, offset + HASH_SLICE_BYTES)).arrayBuffer()));
      options.onHashed?.(Math.min(file.size, offset + HASH_SLICE_BYTES));
    }
    signal.throwIfAborted();
    const begun = await client.begin({ fileName: file.name, size: file.size, sha256: state.digest().slice('sha256:'.length), mediaType: file.type || null });
    session = { ...begun, received: 0 };
    options.onSession(session);
    signal.throwIfAborted();
  }
  while (session.received < file.size) {
    const offset = session.received;
    const bytes = new Uint8Array(await file.slice(offset, Math.min(file.size, offset + session.partBytes)).arrayBuffer());
    const partNumber = offset / session.partBytes + 1;
    for (let attempt = 0; ; attempt += 1) {
      signal.throwIfAborted();
      try {
        const { received } = await client.part({ link: session.link, partNumber, bytes }, signal);
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
  return client.commit(session.link);
}
