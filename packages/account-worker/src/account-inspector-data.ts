import { z } from 'zod';
import { posix } from 'node:path';
import { createHash } from 'node:crypto';
import {
  artifactManifestSchema, credentialProtocolBase64, DRIVE_FILE_MAX_BYTES,
  type ArtifactCopyRecord, type ArtifactManifest, type ArtifactShareRecord, type CanonicalArtifactScope, type CloudProjectSummary, type CloudWorkspaceDefinition,
  type InspectorView, type InspectorIdentity,
} from '@gitspace/protocol';
import type { TranscriptEvent } from '@gitspace/protocol/transcript';
import { createResourcePreview, parseResourceUri, resourceMediaType } from '@gitspace/protocol/resource-uri';
import { streamBytes } from '@gitspace/protocol-workspace';
import type { ProjectAuthorityDO, UserProjectIndexDO } from './project-authority.js';
import type { SpaceAuthorityDO } from './space-authority.js';
import type { SpaceAuthorityRecord } from '@gitspace/protocol-workspace';
import type { SpaceContextDO } from './space-context.js';
import type { TranscriptContentRequest, TranscriptPageRequest } from '@gitspace/blocks';
import { applyTextEdits, RuntimeSnapshotSchema, RuntimeSessionResultSchema, type RuntimeSessionCommand } from '@gitspace/protocol-runtime';
import { readRuntimeTranscript } from './runtime-transcript-reader.js';
import { tenantStore, type TenantStore } from './tenant-store.js';
import { DriveFiles, DriveUploadSchema, type DriveFile, type DriveFileRef } from './drive-files.js';
import { mintArtifactFileUrl } from './artifact-file-url.js';
import { mintUploadLink } from './upload-link.js';
import { ARTIFACT_UPLOAD_CHUNK_BYTES } from '@gitspace/protocol/rpc-contract';

export class InspectorWorkspaceMissing extends Error {
  constructor(readonly spaceId: string) { super(`Workspace ${spaceId} does not exist`); }
}
export class InspectorGenerationConflict extends Error {
  constructor(readonly spaceId: string, readonly expected: number, readonly actual: number) { super('Space generation changed'); }
}

type ArtifactChange = { bytes: Uint8Array; mediaType?: string | null } | { edits: readonly { oldText: string; newText: string }[] }
  /** Bytes as they arrive, stored without holding the whole file. */
  | { stream: ReadableStream<Uint8Array>; mediaType: string | null }
  /** A file already stored in the scope (by a machine through the data endpoint, or a finished upload): named by its
   * plaintext digest, or by `object` when it was streamed before its digest was known. */
  | { stored: { blobHash: string; size: number; object?: string }; mediaType: string | null };
const artifactUploadStateSchema = z.object({
  spaceId: z.string(), generation: z.number().int(), path: z.string(), size: z.number().int().positive().max(DRIVE_FILE_MAX_BYTES), mediaType: z.string().nullable(),
  received: z.number().int().nonnegative(), last: z.object({ offset: z.number().int().nonnegative(), sha256: z.string() }).nullable(),
  /** The parts sent so far; chunks past `upload.size` are staged until they fill a part. */
  upload: DriveUploadSchema,
});
type ArtifactUploadState = z.infer<typeof artifactUploadStateSchema>;
/** Generation conflicts a write retries before giving up: concurrent writers (captures, downloads, agents) each move
 * the scope by one generation. */
const ARTIFACT_WRITE_ATTEMPTS = 8;

export interface InspectorCloudContext {
  identity: InspectorIdentity;
  project: CloudProjectSummary;
  workspace: CloudWorkspaceDefinition;
  workspaces: CloudWorkspaceDefinition[];
  placement: SpaceAuthorityRecord | null;
  authority: DurableObjectStub<ProjectAuthorityDO>;
  context: DurableObjectStub<SpaceContextDO>;
}

/** Resolves canonical identity only: stored rows of the workspace and its project, read in parallel when the caller
 * names the project. It never opens the workspace's runtime. */
export async function readInspectorContext(env: Env, userId: string, spaceId: string, projectId?: string, expectedGeneration?: number): Promise<InspectorCloudContext> {
  if (userId !== env.ACCOUNT_ID) throw new Error('Account does not own this inspector scope');
  const placementRead = (env.SPACE_AUTHORITY as DurableObjectNamespace<SpaceAuthorityDO>).getByName(`${userId}:${spaceId}`).get();
  const resolvedProjectId = projectId ?? (await placementRead)?.projectId
    ?? await (env.USER_PROJECTS as DurableObjectNamespace<UserProjectIndexDO>).getByName(userId).locateWorkspace(spaceId);
  if (!resolvedProjectId) throw new InspectorWorkspaceMissing(spaceId);
  const authority = (env.PROJECT_AUTHORITY as DurableObjectNamespace<ProjectAuthorityDO>).getByName(`${userId}:${resolvedProjectId}`);
  const [placement, project, workspaces] = await Promise.all([placementRead, authority.getProject(), authority.listWorkspaces()]);
  if (placement && placement.projectId !== resolvedProjectId) throw new InspectorWorkspaceMissing(spaceId);
  if (!project) throw new InspectorWorkspaceMissing(spaceId);
  let workspace = workspaces.find((candidate) => candidate.id === spaceId);
  if (!workspace && spaceId === project.id) {
    workspace = await authority.ensureBaseWorkspace({ userId, projectId: project.id });
    workspaces.push(workspace);
  }
  if (!workspace || workspace.projectId !== project.id) throw new InspectorWorkspaceMissing(spaceId);
  const generation = placement?.generation ?? 0;
  if (expectedGeneration !== undefined && generation !== expectedGeneration) throw new InspectorGenerationConflict(spaceId, expectedGeneration, generation);
  const identity = { projectId: project.id, spaceId };
  const context = (env.SPACE_CONTEXT as DurableObjectNamespace<SpaceContextDO>).getByName(JSON.stringify([userId, project.id, spaceId]));
  return { identity, project, workspace, workspaces, placement, authority, context };
}

async function digest(bytes: Uint8Array): Promise<`sha256:${string}`> {
  const hash = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return `sha256:${Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

/** A drive URL with each path segment encoded, so names with ':' or '%' read back as written. */
function driveUrl(mount: string, path: string): string {
  return `drive://${mount}/${path.split('/').map(encodeURIComponent).join('/')}`;
}

/** Drive files: per-scope names in the tenant store (see `DriveFiles`), encrypted at rest under the scope's key. */
export class InspectorCloudArtifacts {
  private readonly store: TenantStore;
  readonly files: DriveFiles;
  constructor(private readonly env: Env, private readonly userId: string, private readonly source: InspectorCloudContext) {
    this.store = tenantStore(env);
    this.files = new DriveFiles(this.store, userId);
  }

  /** One whole drive file of at most `limit` bytes, verified against its digest and the size a manifest names. */
  private async readObject(scopeId: string, file: DriveFileRef, limit: number): Promise<Uint8Array<ArrayBuffer>> {
    if (file.size !== undefined && file.size > limit) throw new Error(`Resource reads are limited to ${limit / 1024 / 1024} MiB`);
    const bytes = await this.files.bytes(scopeId, file, limit);
    if (!bytes) throw new Error('Artifact object is unavailable');
    if (file.size !== undefined && bytes.byteLength !== file.size) throw new Error('Artifact size mismatch');
    return bytes;
  }

  private async entries(scope: CanonicalArtifactScope): Promise<ArtifactManifest['entries']> {
    if (scope.manifestHash === null) {
      if (scope.generation !== 0) throw new Error('Committed artifact scope is missing its manifest hash');
      return [];
    }
    const bytes = await this.readObject(scope.id, { blobHash: scope.manifestHash }, 64 * 1024 * 1024);
    const manifest = artifactManifestSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
    if (manifest.scopeId !== scope.id || manifest.generation !== scope.generation) throw new Error('Artifact manifest does not match its canonical scope and generation');
    if (new Set(manifest.entries.map((entry) => entry.path)).size !== manifest.entries.length) throw new Error('Artifact manifest contains duplicate paths');
    return manifest.entries;
  }

  /** Normalizes a drive:// URL to the workspace it addresses; that workspace's scope may not exist yet. */
  private target(url: string) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'drive:') throw new Error('Artifact URL must use drive://');
    const decoded = decodeURIComponent(parsed.pathname).replace(/^\/+/, '');
    let path = decoded ? posix.normalize(decoded) : '';
    if (path === '..' || path.startsWith('../') || path.startsWith('/')) throw new Error('Artifact path escapes its scope');
    const isBase = this.source.workspace.kind === 'base';
    let spaceId: string;
    if (parsed.hostname === 'base') spaceId = this.source.project.id;
    else if (parsed.hostname === 'workspace' && !isBase) spaceId = this.source.workspace.id;
    else if (parsed.hostname === 'workspaces' && isBase) {
      const [id, ...rest] = path.split('/');
      spaceId = id ?? '';
      path = rest.join('/');
    } else throw new Error('Artifact scope is not accessible from this workspace');
    const workspace = this.source.workspaces.find((candidate) => candidate.id === spaceId);
    if (!workspace || (parsed.hostname === 'base' ? workspace.kind !== 'base' : workspace.kind !== 'worktree')) throw new Error('Artifact scope does not exist');
    return { spaceId, path };
  }

  private async resolve(url: string) {
    const { spaceId, path } = this.target(url);
    const scope = (await this.source.authority.listArtifactScopes()).find((candidate) => candidate.workspaceId === spaceId);
    if (!scope) throw new Error('Artifact scope does not exist');
    return { scope, path };
  }

  /** The workspace's committed scope, or the empty generation-0 scope its first commit creates. */
  private scopeOf(scopes: readonly CanonicalArtifactScope[], workspaceId: string): CanonicalArtifactScope {
    return scopes.find((scope) => scope.workspaceId === workspaceId) ?? {
      id: `space:${workspaceId}`, workspaceId, generation: 0, manifestHash: null, updatedAt: new Date().toISOString(),
    };
  }

  private async persistManifest(scope: CanonicalArtifactScope, generation: number, entries: Iterable<ArtifactManifest['entries'][number]>) {
    const manifest: ArtifactManifest = { version: 1, scopeId: scope.id, generation, entries: [...entries].sort((left, right) => left.path.localeCompare(right.path)) };
    return (await this.files.put(scope.id, new TextEncoder().encode(JSON.stringify(manifest)))).blobHash;
  }

  async list(): Promise<InspectorView['artifacts']> {
    const scopes = await this.source.authority.listArtifactScopes();
    const selected = scopes.filter((scope) => scope.workspaceId === this.source.workspace.id || scope.workspaceId === this.source.project.id);
    const groups = await Promise.all(selected.map(async (scope) => {
      const base = scope.workspaceId === this.source.project.id;
      return (await this.entries(scope)).map((entry) => ({
        url: driveUrl(base ? 'base' : 'workspace', entry.path), path: entry.path, hash: entry.blobHash,
        size: entry.size, mediaType: entry.mediaType, scope: base ? 'base' as const : 'workspace' as const,
        workspaceId: base ? null : scope.workspaceId,
      }));
    }));
    return groups.flat();
  }

  async read(url: string, hash?: string | null) {
    const { bytes, mediaType } = await this.bytes(url, hash);
    return createResourcePreview(url, bytes, mediaType);
  }

  /** The stored version a drive URL names: its current one, or the exact `hash` of an earlier one (found under its
   * digest: an earlier streamed version is named only by the manifest that held it). */
  private async version(url: string, hash?: string | null) {
    const resource = parseResourceUri(url);
    if (resource?.kind !== 'drive' || !resource.mount) throw new Error('Inspector artifacts require a canonical drive resource URI');
    const resolved = await this.resolve(resource.url);
    const current = (await this.entries(resolved.scope)).find((candidate) => candidate.path === resolved.path);
    const entry = hash && current?.blobHash !== hash ? { blobHash: hash, mediaType: current?.mediaType ?? null, size: undefined } : current;
    if (!entry) throw new Error('Artifact does not exist');
    return { scope: resolved.scope, path: resolved.path, entry, mediaType: entry.mediaType ?? resourceMediaType(resource.path) };
  }

  /** A drive file's stored bytes, at most 16 MiB, and its media type. */
  async bytes(url: string, hash?: string | null): Promise<{ bytes: Uint8Array<ArrayBuffer>; mediaType: string | null }> {
    const { scope, entry, mediaType } = await this.version(url, hash);
    const bytes = await this.readObject(scope.id, entry, 16 * 1024 * 1024);
    return { bytes, mediaType };
  }

  /** A short-lived URL serving a drive file's bytes over HTTP, for media elements and downloads. */
  async file(url: string, hash?: string | null) {
    const { scope, path, entry, mediaType } = await this.version(url, hash);
    const size = entry.size ?? (await this.files.head(scope.id, entry))?.size;
    if (size === undefined) throw new Error('Artifact object is unavailable');
    const object = 'object' in entry ? entry.object : undefined;
    const minted = await mintArtifactFileUrl(this.env, { scopeId: scope.id, hash: entry.blobHash, ...(object ? { object } : {}), size, mediaType, name: (path.split('/').at(-1) || 'file').slice(0, 255) });
    return { ...minted, size, mediaType };
  }

  /** The stored object a drive URL names and the scope whose key opens it, for a machine to fetch itself. */
  async locate(url: string): Promise<{ scopeId: string; blobHash: string; size: number; object?: string }> {
    const resource = parseResourceUri(url);
    if (resource?.kind !== 'drive' || !resource.mount) throw new Error('Name the file as drive://workspace/<path> or drive://base/<path>');
    const resolved = await this.resolve(resource.url);
    const entry = (await this.entries(resolved.scope)).find((candidate) => candidate.path === resolved.path);
    if (!entry) throw new Error('Artifact does not exist');
    return { scopeId: resolved.scope.id, blobHash: entry.blobHash, size: entry.size, ...(entry.object ? { object: entry.object } : {}) };
  }

  async catalog() {
    const [artifacts, scopes] = await Promise.all([this.list(), this.source.authority.listArtifactScopes()]);
    return { artifacts, scopes: scopes.filter((scope) => scope.workspaceId === this.source.workspace.id || scope.workspaceId === this.source.project.id).map(({ workspaceId, generation }) => ({ workspaceId, generation })) };
  }

  async copyToProject(files: readonly { url: string; hash: string; destinationPath: string; expectedDestinationHash: string | null }[], expectedProjectGeneration: number) {
    if (this.source.workspace.kind !== 'worktree') throw new Error('Select workspace artifacts to copy to the project');
    if (files.length === 0 || files.length > 100) throw new Error('Select between 1 and 100 artifacts');
    const scopes = await this.source.authority.listArtifactScopes();
    const source = scopes.find((scope) => scope.workspaceId === this.source.workspace.id);
    if (!source) throw new Error('Workspace artifacts have not been published yet');
    const destination = this.scopeOf(scopes, this.source.project.id);
    if (destination.generation !== expectedProjectGeneration) throw new Error('Project artifacts changed. Refresh and choose destination paths again.');
    const [sourceEntries, destinationEntries] = await Promise.all([this.entries(source), this.entries(destination)]);
    const sourceByPath = new Map(sourceEntries.map((entry) => [entry.path, entry]));
    const destinationByPath = new Map(destinationEntries.map((entry) => [entry.path, entry]));
    const paths = new Set<string>();
    const selected = files.map((file) => {
      const parsed = new URL(file.url);
      if (parsed.protocol !== 'drive:' || parsed.hostname !== 'workspace') throw new Error('Only this workspace’s artifacts can be copied');
      const path = decodeURIComponent(parsed.pathname).replace(/^\/+/u, '');
      const entry = sourceByPath.get(path);
      if (!entry || entry.blobHash !== file.hash) throw new Error(`Selected version of ${path} changed. Refresh and select it again.`);
      const target = file.destinationPath;
      if (!target || target.length > 1_024 || target.includes('\\') || /[\u0000-\u001f\u007f]/u.test(target) || target.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error(`Invalid destination path: ${target}`);
      if (paths.has(target) || [...destinationByPath.keys(), ...paths].some((other) => target !== other && (target.startsWith(`${other}/`) || other.startsWith(`${target}/`)))) {
        throw new Error(`Destination conflict: ${target}. Choose a different path; no files were copied.`);
      }
      const existingHash = destinationByPath.get(target)?.blobHash ?? null;
      if (existingHash !== file.expectedDestinationHash) {
        throw new Error(existingHash !== null && file.expectedDestinationHash === null
          ? `Destination ${target} already exists. Confirm replacing this version or choose another name; no files were copied.`
          : `Destination ${target} changed after confirmation. Refresh and confirm the current version again; no files were copied.`);
      }
      paths.add(target);
      return { entry, target };
    });
    if (selected.reduce((total, { entry }) => total + entry.size, 0) > 32 * 1024 * 1024) throw new Error('Copy batches are limited to 32 MiB');
    const generation = destination.generation + 1;
    const createdAt = new Date().toISOString();
    const copies: ArtifactCopyRecord[] = [];
    for (const { entry, target } of selected) {
      const copied = await this.files.copy({ scopeId: source.id, file: entry }, destination.id);
      destinationByPath.set(target, { path: target, blobHash: copied.blobHash, size: copied.size, mediaType: entry.mediaType });
      copies.push({
        id: crypto.randomUUID(), sourceScopeId: source.id, sourceWorkspaceId: source.workspaceId,
        sourceGeneration: source.generation, sourcePath: entry.path, sourceHash: entry.blobHash as `sha256:${string}`,
        destinationScopeId: destination.id, destinationPath: target, destinationHash: copied.blobHash, destinationGeneration: generation, createdAt,
      });
    }
    const manifestHash = await this.persistManifest(destination, generation, destinationByPath.values());
    await this.source.authority.commitArtifactCopies({ id: destination.id, workspaceId: destination.workspaceId, generation, manifestHash, expectedGeneration: destination.generation }, copies);
    return this.catalog();
  }

  /** This session's writable scope: a worktree session writes drive://workspace/…, the project session drive://base/…. */
  private writable(): { mount: 'base' | 'workspace'; spaceId: string } {
    return this.source.workspace.kind === 'base' ? { mount: 'base', spaceId: this.source.project.id } : { mount: 'workspace', spaceId: this.source.workspace.id };
  }

  /**
   * Writes one artifact in this session's writable scope. Bytes keep the current media type unless one is given;
   * `edits` apply the repository edit tool's semantics to the current text of the same generation.
   */
  async write(url: string, change: ArtifactChange) {
    return this.put(this.writablePath(url), change);
  }

  /** Where a machine stores a file it publishes to `url`: the path, and the writable scope it is stored in. */
  async machineTarget(url: string): Promise<{ scopeId: string; path: string }> {
    const path = this.writablePath(url);
    return { scopeId: this.scopeOf(await this.source.authority.listArtifactScopes(), this.writable().spaceId).id, path };
  }

  /** The drive URL of `path` in this session's writable scope. */
  writableUrl(path: string): string {
    return driveUrl(this.writable().mount, path);
  }

  /** This session's writable scope (generation 0 before its first write) and its files. */
  async writableEntries(): Promise<{ scope: CanonicalArtifactScope; entries: ArtifactManifest['entries'] }> {
    const scope = this.scopeOf(await this.source.authority.listArtifactScopes(), this.writable().spaceId);
    return { scope, entries: await this.entries(scope) };
  }

  /** The path a drive URL names in this session's writable scope; any other mount is refused. */
  private writablePath(url: string): string {
    const writable = this.writable();
    const resource = parseResourceUri(url);
    if (resource?.kind !== 'drive') throw new Error('Unsupported or unsafe resource URI');
    if (resource.mount !== writable.mount) {
      throw new Error(writable.mount === 'workspace'
        ? 'This workspace can write drive://workspace/<path>; drive://base/ is written from the project session'
        : 'The project session can write drive://base/<path>; drive://workspace/ is written from that workspace’s session');
    }
    return this.target(resource.url).path;
  }

  private async put(path: string, change: ArtifactChange): Promise<InspectorView['artifacts'][number]> {
    const { mount, spaceId } = this.writable();
    const scopeId = `space:${spaceId}`;
    // New bytes are stored once, before the manifest, so a generation conflict retries only the manifest.
    let file: DriveFile | null = null;
    if ('bytes' in change) file = await this.files.put(scopeId, change.bytes);
    else if ('stream' in change) file = await this.files.write(scopeId, change.stream);
    else if ('stored' in change) {
      if (change.stored.size > DRIVE_FILE_MAX_BYTES) throw new Error(`Drive files are limited to ${DRIVE_FILE_MAX_BYTES / 1024 / 1024 / 1024} GiB`);
      // Stored by a machine or an upload: the manifest names it only once this scope holds it with the stated digest and size.
      const stored = await this.files.head(scopeId, change.stored);
      if (stored?.sha256 !== change.stored.blobHash || stored.size !== change.stored.size) throw new Error('The stored drive file does not match its digest and size');
      file = { blobHash: stored.sha256, size: stored.size, ...(change.stored.object ? { object: change.stored.object } : {}) };
    }
    for (let attempt = 1; ; attempt++) {
      const { scope, entries: listed } = await this.writableEntries();
      if (scope.id !== scopeId) throw new Error('The writable drive scope is not this workspace’s');
      const entries = new Map(listed.map((entry) => [entry.path, entry]));
      const conflict = [...entries.keys()].find((other) => other.startsWith(`${path}/`) || path.startsWith(`${other}/`));
      if (conflict) throw new Error(`${path} conflicts with artifact ${conflict}`);
      const current = entries.get(path);
      let entry: ArtifactManifest['entries'][number];
      if ('edits' in change) {
        if (!current) throw new Error('Artifact does not exist');
        const original = new TextDecoder('utf-8', { fatal: true }).decode(await this.readObject(scope.id, current, 16 * 1024 * 1024));
        const edited = await this.files.put(scope.id, new TextEncoder().encode(applyTextEdits(original, change.edits)));
        entry = { path, blobHash: edited.blobHash, size: edited.size, mediaType: current.mediaType };
      } else {
        if (!file) throw new Error('Artifact change has no content');
        const mediaType = change.mediaType === undefined ? current?.mediaType ?? null : change.mediaType;
        entry = { path, blobHash: file.blobHash, size: file.size, mediaType, ...(file.object ? { object: file.object } : {}) };
      }
      const view = { url: driveUrl(mount, path), path, hash: entry.blobHash, size: entry.size, mediaType: entry.mediaType, scope: mount, workspaceId: mount === 'base' ? null : spaceId };
      // A replayed publication of the same object is already committed.
      if (current?.blobHash === entry.blobHash && current.mediaType === entry.mediaType && current.object === entry.object) return view;
      entries.set(path, entry);
      const generation = scope.generation + 1;
      const manifestHash = await this.persistManifest(scope, generation, entries.values());
      try {
        await this.source.authority.putArtifactScope({ id: scope.id, workspaceId: scope.workspaceId, generation, manifestHash, expectedGeneration: scope.generation });
        return view;
      } catch (error) {
        if (attempt === ARTIFACT_WRITE_ATTEMPTS || !(error instanceof Error) || !error.message.startsWith('Artifact scope generation conflict')) throw error;
      }
    }
  }

  /** Staged upload objects live under the account prefix until commit or abort removes them, encrypted under the
   * session's writable scope: the state, and the chunks received since the last part was sent. */
  private uploadKey(uploadId: string, part: string): string {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(uploadId)) throw new Error('Upload does not exist');
    return `${this.uploadsPrefix()}${uploadId}/${part}`;
  }

  private uploadsPrefix(): string {
    return `accounts/${Buffer.from(this.userId).toString('base64url')}/artifact-uploads/`;
  }

  private get stagingScope(): string {
    return `space:${this.writable().spaceId}`;
  }

  private async saveUpload(uploadId: string, state: ArtifactUploadState): Promise<void> {
    await this.store.put(this.uploadKey(uploadId, 'state'), this.stagingScope, new TextEncoder().encode(JSON.stringify(state)));
  }

  private async uploadState(uploadId: string): Promise<ArtifactUploadState | null> {
    const bytes = await this.store.bytes(this.uploadKey(uploadId, 'state'), this.stagingScope, 64 * 1024);
    if (!bytes) return null;
    const state = artifactUploadStateSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
    if (state.spaceId !== this.source.identity.spaceId || state.generation !== (this.source.placement?.generation ?? 0)) throw new Error('This upload belongs to another workspace');
    return state;
  }

  private async requireUpload(uploadId: string): Promise<ArtifactUploadState> {
    const state = await this.uploadState(uploadId);
    if (!state) throw new Error('Upload does not exist');
    return state;
  }

  /** The staged chunks from offset `from` to `to`, as one part. */
  private async staged(uploadId: string, from: number, to: number): Promise<Uint8Array> {
    const part = new Uint8Array(to - from);
    const offsets = Array.from({ length: Math.ceil((to - from) / ARTIFACT_UPLOAD_CHUNK_BYTES) }, (_, index) => from + index * ARTIFACT_UPLOAD_CHUNK_BYTES);
    await Promise.all(offsets.map(async (offset) => {
      const chunk = await this.store.bytes(this.uploadKey(uploadId, String(offset)), this.stagingScope, ARTIFACT_UPLOAD_CHUNK_BYTES);
      if (chunk?.byteLength !== Math.min(ARTIFACT_UPLOAD_CHUNK_BYTES, to - offset)) throw new Error(`Upload chunk at offset ${offset} is missing`);
      part.set(chunk, offset - from);
    }));
    return part;
  }

  /** Reserves `uploads/<fileName>` in this session's writable scope; the file is listed only after commit. The file is
   * stored under the digest the browser declares, and commit refuses other bytes. `link` is the upload's link
   * (`upload-link.ts`): its parts, commit and abort without further signatures. */
  async beginUpload(fileName: string, size: number, sha256: string, mediaType: string | null) {
    const name = (fileName.split(/[\\/]/u).at(-1) ?? '').replace(/[\u0000-\u001f\u007f]/gu, '').trim();
    if (!name || name === '.' || name === '..' || name.length > 255) throw new Error('Choose a file with a valid name');
    if (!/^[a-f0-9]{64}$/u.test(sha256)) throw new Error('Declare the file’s SHA-256 as 64 hexadecimal digits');
    await this.deleteAbandonedUploads();
    const upload = this.files.begin(this.stagingScope, { declared: { sha256: `sha256:${sha256}`, size } });
    const generation = this.source.placement?.generation ?? 0;
    const state: ArtifactUploadState = { spaceId: this.source.identity.spaceId, generation, path: `uploads/${name}`, size, mediaType, received: 0, last: null, upload };
    await this.saveUpload(upload.id, state);
    const link = await mintUploadLink(this.env, { kind: 'drive', spaceId: state.spaceId, generation, uploadId: upload.id });
    return { uploadId: upload.id, url: driveUrl(this.writable().mount, state.path), link, chunkBytes: ARTIFACT_UPLOAD_CHUNK_BYTES, partBytes: upload.partBytes };
  }

  /** Staged uploads untouched for a day were abandoned (a closed tab, a failed send); a new upload removes them. A
   * multipart upload one of them began is dropped by R2 after a week. */
  private async deleteAbandonedUploads(): Promise<void> {
    const prefix = this.uploadsPrefix();
    const listed = await this.store.list(prefix);
    const newest = new Map<string, number>();
    for (const object of listed.objects) {
      const uploadId = object.name.slice(prefix.length).split('/')[0]!;
      newest.set(uploadId, Math.max(newest.get(uploadId) ?? 0, object.uploaded.getTime()));
    }
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const abandoned = new Set([...newest].filter(([, uploaded]) => uploaded < cutoff).map(([uploadId]) => uploadId));
    const names = listed.objects.filter(object => abandoned.has(object.name.slice(prefix.length).split('/')[0]!)).map(object => object.name);
    if (names.length) await this.store.delete(names);
  }

  /** Stores the chunk at the next offset; resending the last stored chunk is acknowledged without rewriting it. Each
   * full part of chunks is sent on as it completes, so at most one part is ever staged. */
  async uploadChunk(uploadId: string, offset: number, sha256: string, data: string) {
    const state = await this.requireUpload(uploadId);
    const bytes = credentialProtocolBase64.decode(data);
    if ((await digest(bytes)).slice(7) !== sha256) throw new Error('Chunk hash mismatch');
    if (state.last?.offset === offset && state.last.sha256 === sha256) return { received: state.received };
    if (offset !== state.received) throw new Error(`Expected the chunk at offset ${state.received}`);
    const expected = Math.min(ARTIFACT_UPLOAD_CHUNK_BYTES, state.size - offset);
    if (expected <= 0 || bytes.byteLength !== expected) throw new Error('Chunk length does not match the upload');
    await this.store.put(this.uploadKey(uploadId, String(offset)), this.stagingScope, bytes);
    const received = offset + bytes.byteLength;
    const sent = state.upload.size;
    // The last part waits for commit: an upload of one part is stored whole.
    const upload = received - sent === state.upload.partBytes && received < state.size ? await this.files.append(state.upload, await this.staged(uploadId, sent, received)) : state.upload;
    await this.saveUpload(uploadId, { ...state, received, last: { offset, sha256 }, upload });
    if (upload.size > sent) await this.store.delete(Array.from({ length: (upload.size - sent) / ARTIFACT_UPLOAD_CHUNK_BYTES }, (_, index) => this.uploadKey(uploadId, String(sent + index * ARTIFACT_UPLOAD_CHUNK_BYTES))));
    return { received };
  }

  /** Streams part `partNumber` (1-based) straight into the upload's multipart object: every part `upload.partBytes`
   * except the last. The last stored part sent again (a lost acknowledgement) is acknowledged when its bytes match,
   * without storing it twice. Not mixed with chunks: an upload that staged chunks finishes through them. */
  async uploadPart(uploadId: string, partNumber: number, part: { stream: ReadableStream<Uint8Array>; size: number }) {
    const state = await this.requireUpload(uploadId);
    const offset = (partNumber - 1) * state.upload.partBytes;
    if (state.last?.offset === offset && offset + part.size === state.received) {
      const hash = createHash('sha256');
      for await (const chunk of streamBytes(part.stream)) hash.update(chunk);
      if (hash.digest('hex') !== state.last.sha256) throw new Error(`Part ${partNumber} was already stored with other bytes`);
      return { received: state.received };
    }
    if (state.received !== state.upload.size) throw new Error('This upload is being sent in chunks');
    if (!Number.isSafeInteger(partNumber) || partNumber < 1 || offset !== state.received) throw new Error(`Expected part ${state.received / state.upload.partBytes + 1}`);
    const expected = Math.min(state.upload.partBytes, state.size - offset);
    if (expected <= 0 || part.size !== expected) throw new Error(`Part ${partNumber} must be ${expected} bytes`);
    const { upload, sha256 } = await this.files.appendStream(state.upload, part.stream, part.size);
    const received = offset + part.size;
    await this.saveUpload(uploadId, { ...state, received, last: { offset, sha256 }, upload });
    return { received };
  }

  /** Sends the last part and publishes the file once its bytes match the declared digest; a commit retried after a
   * failure finishes the same file. */
  async commitUpload(uploadId: string) {
    let state = await this.requireUpload(uploadId);
    if (state.received !== state.size) throw new Error(`Upload is incomplete: ${state.received} of ${state.size} bytes received`);
    if (state.upload.size < state.received) {
      state = { ...state, upload: await this.files.append(state.upload, await this.staged(uploadId, state.upload.size, state.received)) };
      await this.saveUpload(uploadId, state);
    }
    const file = await this.files.finish(state.upload);
    const artifact = await this.put(state.path, { stored: file, mediaType: state.mediaType });
    await this.deleteUpload(uploadId, state);
    return artifact;
  }

  async abortUpload(uploadId: string) {
    const state = await this.uploadState(uploadId);
    if (state) {
      await this.files.discard(state.upload).catch(() => undefined);
      await this.deleteUpload(uploadId, state);
    }
    return { aborted: state !== null };
  }

  private async deleteUpload(uploadId: string, state: ArtifactUploadState) {
    const names = [this.uploadKey(uploadId, 'state')];
    for (let offset = 0; offset < state.received; offset += ARTIFACT_UPLOAD_CHUNK_BYTES) names.push(this.uploadKey(uploadId, String(offset)));
    await this.store.delete(names);
  }

  async listShares(url: string) {
    const { scope, path } = await this.resolve(url);
    return (await this.source.authority.listArtifactShares(scope.workspaceId, path)).map((record) => artifactShareView(this.userId, this.source.project.id, record, url));
  }

  async createShare(url: string, hash: string, expiresAt: string | null) {
    const { scope, path } = await this.resolve(url);
    const entry = (await this.entries(scope)).find((candidate) => candidate.path === path && candidate.blobHash === hash);
    if (!entry) throw new Error('Selected artifact version changed. Refresh and select it again.');
    if (expiresAt !== null && (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now())) throw new Error('Choose an expiry in the future');
    // Read the whole version back, verified against its recorded digest, before publishing a bearer capability.
    const object = await this.files.get(scope.id, entry);
    if (object?.size !== entry.size) {
      await object?.body.cancel();
      throw new Error('Artifact object is unavailable');
    }
    for await (const _part of streamBytes(object.body)) {
      // Exhaust the verified stream without retaining file contents.
    }
    const record = await this.source.authority.createArtifactShare({
      token: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url'),
      scopeId: scope.id, workspaceId: scope.workspaceId, path, hash: hash as `sha256:${string}`,
      size: entry.size, mediaType: entry.mediaType, ...(entry.object ? { object: entry.object } : {}), createdAt: new Date().toISOString(),
      expiresAt: expiresAt === null ? null : new Date(expiresAt).toISOString(), revokedAt: null,
    });
    return artifactShareView(this.userId, this.source.project.id, record, url);
  }

  async revokeShare(token: string) {
    return { revoked: await this.source.authority.revokeArtifactShare(token, [this.source.workspace.id, this.source.project.id]) };
  }
}

function artifactShareView(userId: string, projectId: string, record: ArtifactShareRecord, artifactUrl: string) {
  return {
    id: record.token, url: `/shared-artifacts/${encodeURIComponent(userId)}/${encodeURIComponent(projectId)}/${record.token}`,
    artifactUrl, hash: record.hash, createdAt: record.createdAt, expiresAt: record.expiresAt,
  };
}

/** Bearer delivery is always an attachment, even for HTML/SVG; it never gains account-origin script privileges. */
export async function serveArtifactShare(request: Request, env: Env): Promise<Response> {
  const headers = new Headers({
    'cache-control': 'private, no-store, max-age=0', 'content-security-policy': "sandbox; default-src 'none'; frame-ancestors 'none'",
    'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-robots-tag': 'noindex, nofollow, noarchive',
  });
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405, headers: { ...Object.fromEntries(headers), allow: 'GET, HEAD' } });
  const match = /^\/shared-artifacts\/([^/]+)\/([^/]+)\/([A-Za-z0-9_-]{43})$/u.exec(new URL(request.url).pathname);
  if (!match) return new Response('Not found', { status: 404, headers });
  try {
    const userId = decodeURIComponent(match[1]!);
    const projectId = decodeURIComponent(match[2]!);
    const authority = (env.PROJECT_AUTHORITY as DurableObjectNamespace<ProjectAuthorityDO>).getByName(`${userId}:${projectId}`);
    const record = await authority.getArtifactShare(match[3]!);
    if (!record) return new Response('Link expired or revoked', { status: 404, headers });
    if (userId !== env.ACCOUNT_ID) return new Response('Shared artifact is unavailable', { status: 404, headers });
    const files = new DriveFiles(tenantStore(env), userId);
    const file = { blobHash: record.hash, size: record.size, object: record.object };
    const object = request.method === 'GET' ? await files.get(record.scopeId, file) : null;
    const metadata = request.method === 'GET' ? object : await files.head(record.scopeId, file);
    if (metadata?.size !== record.size) {
      await object?.body.cancel();
      throw new Error('Shared artifact object is unavailable');
    }
    // Recheck after the asynchronous storage read so revocation/expiry during delivery cannot issue fresh bytes.
    if (!await authority.getArtifactShare(match[3]!)) return new Response('Link expired or revoked', { status: 404, headers });
    const filename = record.path.split('/').at(-1) ?? 'artifact';
    headers.set('content-type', record.mediaType && /^[\w!#$&^.+-]+\/[\w!#$&^.+-]+(?:;[^\r\n]*)?$/u.test(record.mediaType) ? record.mediaType : 'application/octet-stream');
    headers.set('content-disposition', `attachment; filename="artifact"; filename*=UTF-8''${encodeURIComponent(filename).replace(/['()*]/gu, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)}`);
    headers.set('content-length', String(record.size));
    if (!object) {
      if (!await authority.getArtifactShare(match[3]!)) { headers.delete('content-length'); return new Response('Link expired or revoked', { status: 404, headers }); }
      return new Response(null, { headers });
    }
    const iterator = streamBytes(object.body);
    return new Response(new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await iterator.next();
          if (!await authority.getArtifactShare(match[3]!)) throw new Error('Link expired or revoked');
          if (next.done) controller.close();
          else controller.enqueue(next.value);
        } catch (error) {
          await iterator.return(undefined);
          controller.error(error);
        }
      },
      async cancel() { await iterator.return(undefined); },
    }, { highWaterMark: 0 }), { headers });
  } catch {
    headers.delete('content-length');
    return new Response('Shared artifact is unavailable', { status: 404, headers });
  }
}

/** The workspace's main cloud conversation, read without starting a runtime that never ran; null before it exists. */
async function mainConversation(env: Env, userId: string, source: InspectorCloudContext): Promise<string | null> {
  const space = env.SPACE_AUTHORITY.getByName(`${userId}:${source.workspace.id}`);
  if (!await space.hasCloudRuntime()) return null;
  const live = RuntimeSnapshotSchema.parse(await (await space.runtimeSnapshot({ projectId: source.project.id, workspaceId: source.workspace.id })).json());
  return live.conversations.find(item => item.parentId === null)?.id ?? null;
}

async function conversationSession(env: Env, userId: string, source: InspectorCloudContext, command: RuntimeSessionCommand) {
  const conversationId = await mainConversation(env, userId, source);
  if (!conversationId) throw new Error('This workspace has no conversation yet');
  const response = await env.SPACE_AUTHORITY.getByName(`${userId}:${source.workspace.id}`).runtimeSession({ projectId: source.project.id, workspaceId: source.workspace.id, conversationId, command }, { canApprove: false });
  return RuntimeSessionResultSchema.parse(await response.json());
}

export async function readInspectorTranscript(env: Env, userId: string, source: InspectorCloudContext): Promise<AsyncIterable<TranscriptEvent>> {
  const conversationId = await mainConversation(env, userId, source);
  if (!conversationId) return (async function* () {})();
  const response = await env.SPACE_AUTHORITY.getByName(`${userId}:${source.workspace.id}`).runtimeTranscript({ projectId: source.project.id, workspaceId: source.workspace.id, conversationId }, 'ndjson');
  return (async function* () {
    for await (const event of readRuntimeTranscript(response)) yield { ...event, sessionId: conversationId, createdAt: new Date(event.createdAt) };
  })();
}

export async function readInspectorTranscriptPage(env: Env, userId: string, source: InspectorCloudContext, request: TranscriptPageRequest) {
  const result = await conversationSession(env, userId, source, { type: 'transcriptPage', request });
  if (!result.transcriptPage) throw new Error('Cloud transcript page is unavailable');
  return result.transcriptPage;
}

export async function readInspectorTranscriptContent(env: Env, userId: string, source: InspectorCloudContext, request: TranscriptContentRequest) {
  const result = await conversationSession(env, userId, source, { type: 'transcriptContent', request });
  if (!result.transcriptContent) throw new Error('Cloud transcript content is unavailable');
  return result.transcriptContent;
}
