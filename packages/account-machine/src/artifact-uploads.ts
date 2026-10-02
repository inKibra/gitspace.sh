import { createHash } from 'node:crypto';
import { appendFile, mkdir, readdir, rm, stat, truncate, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Result, type Result as ResultType } from 'better-result';
import type { ArtifactCapability, LocalArtifactEntry, LocalArtifactResolver } from '@gitspace/core';
import { ARTIFACT_UPLOAD_CHUNK_BYTES, ARTIFACT_UPLOAD_MAX_BYTES } from '@gitspace/protocol/rpc-contract';

/** Uploads with no activity for this long are discarded together with their staged bytes. */
export const ARTIFACT_UPLOAD_IDLE_MS = 30 * 60 * 1000;
/** Uploaded names are materialized as files in agent mounts, so they obey NAME_MAX. */
const UPLOAD_NAME_MAX_BYTES = 255;

export type ArtifactUploadFailure =
  | { kind: 'conflict'; expected: number; actual: number }
  | { kind: 'state'; message: string }
  | { kind: 'other'; message: string };

export interface ArtifactUploadSpace {
  spaceId: string;
  generation: number;
  /** The space's own writable capability: project for a base space, workspace for a worktree. */
  capability: ArtifactCapability;
}

interface StagedUpload extends ArtifactUploadSpace {
  id: string;
  mount: 'base' | 'workspace';
  name: string;
  size: number;
  mediaType: string | null;
  file: string;
  received: number;
  last: { offset: number; sha256: string } | null;
  touchedAt: number;
  queue: Promise<unknown>;
  committed: LocalArtifactEntry | null;
}

const missingUpload: ArtifactUploadFailure = { kind: 'state', message: 'Upload does not exist, expired, or was aborted' };

function suffixedName(name: string, attempt: number): string {
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 && Buffer.byteLength(name.slice(dot)) <= 32 ? name.slice(dot) : '';
  const stem = Array.from(extension ? name.slice(0, dot) : name);
  const suffix = ` (${attempt})${extension}`;
  while (stem.length > 1 && Buffer.byteLength(stem.join('') + suffix) > UPLOAD_NAME_MAX_BYTES) stem.pop();
  return stem.join('') + suffix;
}

/**
 * Stages user uploads outside the artifact journal, then registers the finished file through
 * the same store and publication path as agent-written artifacts. Nothing is announced to agents.
 */
export class ArtifactUploads {
  private readonly uploads = new Map<string, StagedUpload>();
  private readonly sweeper: Timer;
  private readonly now: () => number;

  constructor(private readonly options: {
    artifacts: LocalArtifactResolver;
    /** Private staging directory; files here are never listed as artifacts. */
    root: string;
    publish(spaceId: string): Promise<void>;
    onError(error: unknown): void;
    now?: () => number;
  }) {
    this.now = options.now ?? Date.now;
    this.sweeper = setInterval(() => void this.sweep().catch(options.onError), 60_000);
    this.sweeper.unref();
  }

  close(): void {
    clearInterval(this.sweeper);
  }

  async begin(input: ArtifactUploadSpace & { fileName: string; size: number; mediaType: string | null }): Promise<ResultType<{ uploadId: string; url: string; chunkBytes: number }, ArtifactUploadFailure>> {
    try {
      await this.sweep();
    } catch (error) {
      this.options.onError(error);
    }
    if (Buffer.byteLength(input.fileName) > UPLOAD_NAME_MAX_BYTES || !input.fileName || input.fileName === '.' || input.fileName === '..'
      || /[\u0000-\u001f\u007f/\\]/u.test(input.fileName)) {
      return Result.err({ kind: 'state', message: `File names must be a single path segment of 1-${UPLOAD_NAME_MAX_BYTES} bytes without control characters` });
    }
    if (!Number.isSafeInteger(input.size) || input.size < 1 || input.size > ARTIFACT_UPLOAD_MAX_BYTES) {
      return Result.err({ kind: 'state', message: `Uploads must contain 1 to ${ARTIFACT_UPLOAD_MAX_BYTES} bytes` });
    }
    const name = this.availableName(input, input.fileName, null);
    if (name.status === 'error') return name;
    const id = crypto.randomUUID();
    const mount = input.capability.kind === 'workspace' ? 'workspace' : 'base';
    const upload: StagedUpload = {
      id, spaceId: input.spaceId, generation: input.generation, capability: input.capability, mount, name: name.value,
      size: input.size, mediaType: input.mediaType, file: join(this.options.root, `${id}.part`), received: 0, last: null,
      touchedAt: this.now(), queue: Promise.resolve(), committed: null,
    };
    // Reserve the name before yielding so concurrent uploads of one name get distinct suffixes.
    this.uploads.set(id, upload);
    try {
      await mkdir(this.options.root, { recursive: true });
      await writeFile(upload.file, new Uint8Array(), { flag: 'wx', mode: 0o600 });
    } catch (error) {
      this.uploads.delete(id);
      return Result.err({ kind: 'other', message: error instanceof Error ? error.message : String(error) });
    }
    return Result.ok({ uploadId: id, url: `local://${mount}/uploads/${upload.name}`, chunkBytes: ARTIFACT_UPLOAD_CHUNK_BYTES });
  }

  /** Offsets must continue exactly at the stored size; resending the last stored chunk is idempotent. */
  async chunk(input: ArtifactUploadSpace & { uploadId: string; offset: number; sha256: string; data: string }): Promise<ResultType<{ received: number }, ArtifactUploadFailure>> {
    const upload = this.owned(input);
    if (!upload) return Result.err(missingUpload);
    return this.serialize<{ received: number }>(upload, async () => {
      if (upload.committed) return Result.err({ kind: 'state', message: 'Upload was already committed' });
      const bytes = Buffer.from(input.data, 'base64');
      if (bytes.byteLength === 0 || bytes.byteLength > ARTIFACT_UPLOAD_CHUNK_BYTES) {
        return Result.err({ kind: 'state', message: `Upload chunks must contain 1 to ${ARTIFACT_UPLOAD_CHUNK_BYTES} bytes` });
      }
      const sha256 = input.sha256.toLowerCase();
      if (createHash('sha256').update(bytes).digest('hex') !== sha256) {
        return Result.err({ kind: 'state', message: 'Upload chunk failed sha256 verification' });
      }
      const end = input.offset + bytes.byteLength;
      if (upload.last && upload.last.offset === input.offset && upload.last.sha256 === sha256 && end === upload.received) {
        return Result.ok({ received: upload.received });
      }
      if (input.offset !== upload.received) return Result.err({ kind: 'conflict', expected: upload.received, actual: input.offset });
      if (end > upload.size) return Result.err({ kind: 'state', message: 'Upload chunk extends past the declared file size' });
      try {
        await appendFile(upload.file, bytes);
      } catch (error) {
        // Keep the staged file equal to the acknowledged prefix so the client can retry this offset.
        await truncate(upload.file, upload.received).catch(() => undefined);
        throw error;
      }
      upload.received = end;
      upload.last = { offset: input.offset, sha256 };
      return Result.ok({ received: end });
    });
  }

  /** Registers the staged file once; a retried commit returns the same artifact. Cloud publication continues in the background. */
  async commit(input: ArtifactUploadSpace & { uploadId: string }): Promise<ResultType<LocalArtifactEntry, ArtifactUploadFailure>> {
    const upload = this.owned(input);
    if (!upload) return Result.err(missingUpload);
    return this.serialize<LocalArtifactEntry>(upload, async () => {
      if (upload.committed) return Result.ok(upload.committed);
      if (upload.received !== upload.size) return Result.err({ kind: 'conflict', expected: upload.size, actual: upload.received });
      if ((await stat(upload.file)).size !== upload.size) return Result.err({ kind: 'other', message: 'Staged upload size does not match its acknowledged chunks' });
      // An agent may have created the reserved name since begin; never overwrite it.
      const name = this.availableName(upload, upload.name, upload.id);
      if (name.status === 'error') return name;
      upload.name = name.value;
      const written = await this.options.artifacts.writeFile(
        upload.capability, `local://${upload.mount}/uploads/${encodeURIComponent(upload.name)}`, upload.file, upload.mediaType ?? undefined,
      );
      if (written.status === 'error') return Result.err({ kind: 'other', message: written.error.message });
      upload.committed = written.value;
      void this.options.publish(upload.spaceId).catch(this.options.onError);
      return Result.ok(written.value);
    });
  }

  async abort(input: ArtifactUploadSpace & { uploadId: string }): Promise<ResultType<{ aborted: boolean }, ArtifactUploadFailure>> {
    const upload = this.owned(input);
    if (!upload) return Result.ok({ aborted: false });
    return this.serialize<{ aborted: boolean }>(upload, async () => {
      if (upload.committed) return Result.ok({ aborted: false });
      this.uploads.delete(upload.id);
      await rm(upload.file, { force: true });
      return Result.ok({ aborted: true });
    });
  }

  /** Discards idle uploads, and staged files whose state was lost with a previous machine process. */
  async sweep(): Promise<void> {
    const cutoff = this.now() - ARTIFACT_UPLOAD_IDLE_MS;
    for (const upload of [...this.uploads.values()]) {
      if (upload.touchedAt > cutoff) continue;
      this.uploads.delete(upload.id);
      await rm(upload.file, { force: true });
    }
    let names: string[];
    try {
      names = await readdir(this.options.root);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return;
      throw error;
    }
    const staged = new Set([...this.uploads.values()].map((upload) => upload.file));
    for (const name of names) {
      const path = join(this.options.root, name);
      if (staged.has(path)) continue;
      const metadata = await stat(path).catch(() => null);
      if (metadata && metadata.mtimeMs <= cutoff) await rm(path, { recursive: true, force: true });
    }
  }

  private owned(input: ArtifactUploadSpace & { uploadId: string }): StagedUpload | null {
    const upload = this.uploads.get(input.uploadId);
    return upload && upload.spaceId === input.spaceId && upload.generation === input.generation ? upload : null;
  }

  /** One operation per upload at a time; a timed-out client retry waits for the original. */
  private serialize<T>(upload: StagedUpload, operation: () => Promise<ResultType<T, ArtifactUploadFailure>>): Promise<ResultType<T, ArtifactUploadFailure>> {
    const next = upload.queue.then(async (): Promise<ResultType<T, ArtifactUploadFailure>> => {
      if (this.uploads.get(upload.id) !== upload) return Result.err(missingUpload);
      upload.touchedAt = this.now();
      try {
        return await operation();
      } catch (error) {
        return Result.err({ kind: 'other', message: error instanceof Error ? error.message : String(error) });
      } finally {
        upload.touchedAt = this.now();
      }
    });
    upload.queue = next;
    return next;
  }

  private availableName(space: ArtifactUploadSpace, requested: string, except: string | null): ResultType<string, ArtifactUploadFailure> {
    const mount = space.capability.kind === 'workspace' ? 'workspace' : 'base';
    const listed = this.options.artifacts.list(space.capability, `local://${mount}/uploads`);
    if (listed.status === 'error') return Result.err({ kind: 'other', message: listed.error.message });
    if (listed.value.some((entry) => entry.path === 'uploads')) return Result.err({ kind: 'state', message: 'An artifact file named uploads blocks the uploads folder' });
    // Case-insensitive: macOS agent mounts would otherwise merge two uploads into one file.
    const taken = new Set(listed.value.map((entry) => entry.path.slice('uploads/'.length).split('/')[0]!.toLowerCase()));
    for (const upload of this.uploads.values()) {
      if (upload.spaceId === space.spaceId && upload.committed === null && upload.id !== except) taken.add(upload.name.toLowerCase());
    }
    let candidate = requested;
    for (let attempt = 1; taken.has(candidate.toLowerCase()); attempt++) candidate = suffixedName(requested, attempt);
    return Result.ok(candidate);
  }
}
