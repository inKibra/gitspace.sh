import { collectBytes, streamBytes } from '@gitspace/protocol-workspace';
import { InspectorCloudArtifacts, readInspectorContext } from './account-inspector-data.js';
import type { DriveUpload } from './drive-files.js';
import type { TenantRange } from './tenant-store.js';
import type { ArtifactFileGrant } from './artifact-file-url.js';

/** Whole-file `read`s hold the file in memory; larger files are read by range or through `url`. */
export const WORKSPACE_DRIVE_READ_MAX_BYTES = 32 * 1024 * 1024;

export interface WorkspaceDriveWritten { path: string; size: number; blobHash: string }
export interface WorkspaceDriveFile { path: string; size: number; mediaType: string | null; blobHash: string }

/**
 * One workspace's writable drive scope (`drive://workspace/…`; the project's base workspace writes `drive://base/…`)
 * for account code: Worker routes and Durable Objects. Paths are relative to the scope (`browser/captures/<id>/…`).
 * Every write is one manifest generation, retried over concurrent writers. Bytes are stored as they arrive (R2
 * multipart), up to `DRIVE_FILE_MAX_BYTES`; a file that spans requests is written with `upload`/`append`/`finish`.
 */
export interface WorkspaceDrive {
  write(path: string, mediaType: string | null, body: Uint8Array | ReadableStream<Uint8Array>): Promise<WorkspaceDriveWritten>;
  /** The scope's files whose path starts with `prefix` (`''` lists every file). */
  list(prefix: string): Promise<WorkspaceDriveFile[]>;
  /** The file's bytes, or one range of them; null when no file has the path. */
  read(path: string, range?: TenantRange): Promise<Uint8Array | null>;
  /** An absolute sealed `/files/` link to the file's current version, valid for `ARTIFACT_FILE_URL_MS`. */
  url(path: string): Promise<string>;
  /** What a file link grants for the file's current version, for a route that serves it under its own token. */
  grant(path: string): Promise<ArtifactFileGrant>;
  /** A new upload into this workspace's scope: JSON to keep between requests. Nothing is stored yet. */
  upload(): Promise<DriveUpload>;
  /** Stores the next part, `size` bytes arriving as `stream`, and returns the upload after it. Every part but the last
   * is `TENANT_OBJECT_PART_BYTES` (32 MiB); a shorter part ends the upload. Appending the same part to the same upload
   * again is safe. */
  append(upload: DriveUpload, stream: ReadableStream<Uint8Array>, size: number): Promise<DriveUpload>;
  /** Publishes the appended bytes at `path`; finishing the same upload again publishes the same file. */
  finish(upload: DriveUpload, path: string, mediaType: string | null): Promise<WorkspaceDriveWritten>;
  /** Abandons an unfinished upload's parts. */
  discard(upload: DriveUpload): Promise<void>;
  /** Where a machine stores the file it publishes to `path` (`drive_transfer` `fromMachine`). */
  machineTarget(path: string): Promise<{ scopeId: string; path: string }>;
  /** Names a file a machine stored (`drive_transfer` `fromMachine`'s result) at `path`. */
  record(path: string, mediaType: string | null, stored: { blobHash: string; size: number }): Promise<WorkspaceDriveWritten>;
  /** Names the file at `from` at `to` too, replacing a file there: the same stored object under its type, so no bytes
   * move whatever its size. */
  copy(from: string, to: string): Promise<WorkspaceDriveWritten>;
}

export function workspaceDrive(env: Env, workspace: { projectId: string; workspaceId: string }): WorkspaceDrive {
  let opened: Promise<InspectorCloudArtifacts> | null = null;
  const artifacts = () => {
    opened ??= readInspectorContext(env, env.ACCOUNT_ID, workspace.workspaceId, workspace.projectId).then(source => new InspectorCloudArtifacts(env, env.ACCOUNT_ID, source));
    opened.catch(() => { opened = null; });
    return opened;
  };
  const written = (view: { path: string; size: number; hash: string }): WorkspaceDriveWritten => ({ path: view.path, size: view.size, blobHash: view.hash });
  const scopeId = `space:${workspace.workspaceId}`;
  const owned = (upload: DriveUpload) => {
    if (upload.scopeId !== scopeId) throw new Error('This upload belongs to another workspace drive');
    return upload;
  };
  return {
    async write(path, mediaType, body) {
      const drive = await artifacts();
      return written(await drive.write(drive.writableUrl(path), body instanceof Uint8Array ? { bytes: body, mediaType } : { stream: body, mediaType }));
    },
    async list(prefix) {
      return (await (await artifacts()).writableEntries()).entries
        .filter(entry => entry.path.startsWith(prefix))
        .map(({ path, size, mediaType, blobHash }) => ({ path, size, mediaType, blobHash }));
    },
    async read(path, range) {
      const drive = await artifacts();
      const { scope, entries } = await drive.writableEntries();
      const entry = entries.find(candidate => candidate.path === path);
      if (!entry) return null;
      const limit = range?.length ?? entry.size;
      if (limit > WORKSPACE_DRIVE_READ_MAX_BYTES) throw new Error(`Read ${path} by range: whole reads are limited to ${WORKSPACE_DRIVE_READ_MAX_BYTES / 1024 / 1024} MiB`);
      const file = await drive.files.get(scope.id, entry, range);
      if (!file) throw new Error(`${path} is missing from storage`);
      return collectBytes(streamBytes(file.body), limit);
    },
    async url(path) {
      const drive = await artifacts();
      return new URL((await drive.file(drive.writableUrl(path))).url, env.ACCOUNT_URL).href;
    },
    async grant(path) {
      const drive = await artifacts();
      return drive.grant(drive.writableUrl(path));
    },
    async upload() {
      return (await artifacts()).files.begin(scopeId);
    },
    async append(upload, stream, size) {
      return (await (await artifacts()).files.appendStream(owned(upload), stream, size)).upload;
    },
    async finish(upload, path, mediaType) {
      const drive = await artifacts();
      const file = await drive.files.finish(owned(upload));
      return written(await drive.write(drive.writableUrl(path), { stored: file, mediaType }));
    },
    async discard(upload) {
      await (await artifacts()).files.discard(owned(upload));
    },
    async machineTarget(path) {
      const drive = await artifacts();
      return drive.machineTarget(drive.writableUrl(path));
    },
    async record(path, mediaType, stored) {
      const drive = await artifacts();
      return written(await drive.write(drive.writableUrl(path), { stored: { blobHash: stored.blobHash, size: stored.size }, mediaType }));
    },
    async copy(from, to) {
      const drive = await artifacts();
      const entry = (await drive.writableEntries()).entries.find(candidate => candidate.path === from);
      if (!entry) throw new Error(`${from} does not exist`);
      return written(await drive.write(drive.writableUrl(to), { stored: { blobHash: entry.blobHash, size: entry.size, ...(entry.object ? { object: entry.object } : {}) }, mediaType: entry.mediaType }));
    },
  };
}
