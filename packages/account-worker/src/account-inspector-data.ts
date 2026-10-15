import { z } from 'zod';
import { posix } from 'node:path';
import {
  artifactManifestSchema, credentialProtocolBase64, decryptArtifactBytes, deriveArtifactScopeKey, encryptArtifactBytes,
  type ArtifactCopyRecord, type ArtifactManifest, type ArtifactShareRecord, type CanonicalArtifactScope, type CloudProjectSummary, type CloudWorkspaceDefinition,
  type InspectorView, type InspectorIdentity,
} from '@gitspace/protocol';
import type { TranscriptEvent } from '@gitspace/protocol/transcript';
import { createResourcePreview, parseResourceUri, resourceMediaType } from '@gitspace/protocol/resource-uri';
import type { CredentialVaultDO } from './application.js';
import type { ProjectAuthorityDO, UserProjectIndexDO } from './project-authority.js';
import type { SpaceAuthorityDO } from './space-authority.js';
import { CHUNKED_CHECKPOINT_VERSION, chunkedCheckpointManifestSchema, parseWorkspaceCheckpoint, spaceOmpCheckpointKey, type SpaceAuthorityRecord } from '@gitspace/protocol-workspace';
import type { SpaceContextDO } from './space-context.js';
import { SavedTranscriptIndex } from './saved-transcript-index.js';
import type { TranscriptContentRequest, TranscriptPageRequest } from '@gitspace/blocks';
import { applyTextEdits, RuntimeIdentitySchema, RuntimeSnapshotSchema, RuntimeSessionResultSchema } from '@gitspace/protocol-runtime';
import { readRuntimeTranscript } from './runtime-transcript-reader.js';
import { openLegacySession } from './legacy-checkpoint-reader.js';
import { readArtifactObject, readArtifactManifestObject } from './artifact-object-reader.js';
import { ARTIFACT_UPLOAD_CHUNK_BYTES } from '@gitspace/protocol/rpc-contract';

export class InspectorWorkspaceMissing extends Error {
  constructor(readonly spaceId: string) { super(`Workspace ${spaceId} does not exist`); }
}
export class InspectorGenerationConflict extends Error {
  constructor(readonly spaceId: string, readonly expected: number, readonly actual: number) { super('Space generation changed'); }
}

type ArtifactChange = { bytes: Uint8Array; mediaType?: string | null } | { edits: readonly { oldText: string; newText: string }[] };
const artifactUploadStateSchema = z.object({
  spaceId: z.string(), generation: z.number().int(), path: z.string(), size: z.number().int().positive(), mediaType: z.string().nullable(),
  received: z.number().int().nonnegative(), last: z.object({ offset: z.number().int().nonnegative(), sha256: z.string() }).nullable(),
});
type ArtifactUploadState = z.infer<typeof artifactUploadStateSchema>;

export interface InspectorCloudContext {
  identity: InspectorIdentity;
  project: CloudProjectSummary;
  workspace: CloudWorkspaceDefinition;
  workspaces: CloudWorkspaceDefinition[];
  placement: SpaceAuthorityRecord | null;
  authority: DurableObjectStub<ProjectAuthorityDO>;
  context: DurableObjectStub<SpaceContextDO>;
}

/** Resolves canonical identity only. In particular, this never calls space.bootstrap/beginOpen. */
export async function readInspectorContext(env: Env, userId: string, spaceId: string, projectId?: string, expectedGeneration?: number): Promise<InspectorCloudContext> {
  if (userId !== env.ACCOUNT_ID) throw new Error('Account does not own this inspector scope');
  const placement = await (env.SPACE_AUTHORITY as DurableObjectNamespace<SpaceAuthorityDO>).getByName(`${userId}:${spaceId}`).get();
  const resolvedProjectId = placement?.projectId ?? projectId
    ?? await (env.USER_PROJECTS as DurableObjectNamespace<UserProjectIndexDO>).getByName(userId).locateWorkspace(spaceId);
  if (!resolvedProjectId || (projectId !== undefined && projectId !== resolvedProjectId)) throw new InspectorWorkspaceMissing(spaceId);
  const authority = (env.PROJECT_AUTHORITY as DurableObjectNamespace<ProjectAuthorityDO>).getByName(`${userId}:${resolvedProjectId}`);
  const [project, workspaces] = await Promise.all([authority.getProject(), authority.listWorkspaces()]);
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
  await context.bootstrap(identity);
  return { identity, project, workspace, workspaces, placement, authority, context };
}

async function digest(bytes: Uint8Array): Promise<`sha256:${string}`> {
  const hash = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return `sha256:${Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function assertSavedObjectKey(key: string): void {
  if (!key || key.startsWith('/') || key.includes('..') || key.length > 1_024) throw new Error('Saved object key is invalid');
}

async function readObject(env: Env, userId: string, key: string, hash: string): Promise<Uint8Array> {
  assertSavedObjectKey(key);
  const object = await env.DATA.get(`users/${userId}/${key}`);
  if (!object) throw new Error(`Saved object ${key} is unavailable`);
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (await digest(bytes) !== hash) throw new Error(`Saved object ${key} failed content verification`);
  return bytes;
}

async function boundedArtifactBytes(env: Env, userId: string, hash: string, key: Uint8Array, expectedSize: number | undefined, limit: number): Promise<Uint8Array<ArrayBuffer>> {
  if (expectedSize !== undefined && expectedSize > limit) throw new Error(`Resource reads are limited to ${limit / 1024 / 1024} MiB`);
  const parts: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  for await (const part of await readArtifactObject(env, userId, hash, key, expectedSize)) {
    size += part.byteLength;
    if (size > limit) throw new Error(`Resource reads are limited to ${limit / 1024 / 1024} MiB`);
    parts.push(part);
  }
  if (parts.length === 1) return parts[0]!;
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
  return bytes;
}

/** A drive URL with each path segment encoded, so names with ':' or '%' read back as written. */
function driveUrl(mount: string, path: string): string {
  return `drive://${mount}/${path.split('/').map(encodeURIComponent).join('/')}`;
}

/** Reads the same encrypted, content-addressed objects as CloudArtifactObjectStore. */
export class InspectorCloudArtifacts {
  private keyRequest: Promise<Uint8Array> | undefined;
  constructor(private readonly env: Env, private readonly userId: string, private readonly source: InspectorCloudContext) {}

  /** Fetched on first use: upload staging never needs the key, and an unawaited request outlives the call. */
  private get key(): Promise<Uint8Array> {
    this.keyRequest ??= (this.env.CREDENTIALS as DurableObjectNamespace<CredentialVaultDO>).getByName(this.userId).artifactKey(this.userId).then(credentialProtocolBase64.decode);
    return this.keyRequest;
  }

  private objectKey(hash: string): string {
    if (!/^sha256:[a-f0-9]{64}$/u.test(hash)) throw new Error('Artifact hash is invalid');
    return `accounts/${Buffer.from(this.userId).toString('base64url')}/artifacts/sha256/${hash.slice(7)}`;
  }

  private async entries(scope: CanonicalArtifactScope): Promise<ArtifactManifest['entries']> {
    if (scope.manifestHash === null) {
      if (scope.generation !== 0) throw new Error('Committed artifact scope is missing its manifest hash');
      return [];
    }
    const bytes = await readArtifactManifestObject(this.env, this.userId, scope.manifestHash, await deriveArtifactScopeKey(await this.key, scope.id));
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

  /** Encrypts and stores one content-addressed object under the scope key. */
  private async seal(bytes: Uint8Array, scopeKey: Uint8Array): Promise<`sha256:${string}`> {
    const sealed = await encryptArtifactBytes(bytes, scopeKey);
    const hash = await digest(sealed);
    await this.env.DATA.put(`users/${this.userId}/${this.objectKey(hash)}`, sealed);
    return hash;
  }

  private async sealManifest(scope: CanonicalArtifactScope, generation: number, entries: Iterable<ArtifactManifest['entries'][number]>, scopeKey: Uint8Array) {
    const manifest: ArtifactManifest = { version: 1, scopeId: scope.id, generation, entries: [...entries].sort((left, right) => left.path.localeCompare(right.path)) };
    return this.seal(new TextEncoder().encode(JSON.stringify(manifest)), scopeKey);
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

  /** A drive file's stored bytes, at most 16 MiB, and its media type. */
  async bytes(url: string, hash?: string | null): Promise<{ bytes: Uint8Array<ArrayBuffer>; mediaType: string | null }> {
    const resource = parseResourceUri(url);
    if (resource?.kind !== 'drive' || !resource.mount) throw new Error('Inspector artifacts require a canonical drive resource URI');
    const resolved = await this.resolve(resource.url);
    const current = (await this.entries(resolved.scope)).find((candidate) => candidate.path === resolved.path);
    const entry = hash ? { blobHash: hash, mediaType: current?.mediaType ?? null, size: current?.blobHash === hash ? current.size : undefined } : current;
    if (!entry) throw new Error('Artifact does not exist');
    const bytes = await boundedArtifactBytes(this.env, this.userId, entry.blobHash, await deriveArtifactScopeKey(await this.key, resolved.scope.id), entry.size, 16 * 1024 * 1024);
    return { bytes, mediaType: entry.mediaType ?? resourceMediaType(resource.path) };
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
    const [sourceKey, destinationKey] = await Promise.all([deriveArtifactScopeKey(await this.key, source.id), deriveArtifactScopeKey(await this.key, destination.id)]);
    const generation = destination.generation + 1;
    const createdAt = new Date().toISOString();
    const copies: ArtifactCopyRecord[] = [];
    for (const { entry, target } of selected) {
      const bytes = await boundedArtifactBytes(this.env, this.userId, entry.blobHash, sourceKey, entry.size, 32 * 1024 * 1024);
      const hash = await this.seal(bytes, destinationKey);
      destinationByPath.set(target, { path: target, blobHash: hash, size: bytes.byteLength, mediaType: entry.mediaType });
      copies.push({
        id: crypto.randomUUID(), sourceScopeId: source.id, sourceWorkspaceId: source.workspaceId,
        sourceGeneration: source.generation, sourcePath: entry.path, sourceHash: entry.blobHash as `sha256:${string}`,
        destinationScopeId: destination.id, destinationPath: target, destinationHash: hash, destinationGeneration: generation, createdAt,
      });
    }
    const manifestHash = await this.sealManifest(destination, generation, destinationByPath.values(), destinationKey);
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
    const writable = this.writable();
    const resource = parseResourceUri(url);
    if (resource?.kind !== 'drive') throw new Error('Unsupported or unsafe resource URI');
    if (resource.mount !== writable.mount) {
      throw new Error(writable.mount === 'workspace'
        ? 'This workspace can write drive://workspace/<path>; drive://base/ is written from the project session'
        : 'The project session can write drive://base/<path>; drive://workspace/ is written from that workspace’s session');
    }
    return this.put(this.target(resource.url).path, change);
  }

  private async put(path: string, change: ArtifactChange): Promise<InspectorView['artifacts'][number]> {
    const { mount, spaceId } = this.writable();
    const scope = this.scopeOf(await this.source.authority.listArtifactScopes(), spaceId);
    const scopeKey = await deriveArtifactScopeKey(await this.key, scope.id);
    const entries = new Map((await this.entries(scope)).map((entry) => [entry.path, entry]));
    const conflict = [...entries.keys()].find((other) => other.startsWith(`${path}/`) || path.startsWith(`${other}/`));
    if (conflict) throw new Error(`${path} conflicts with artifact ${conflict}`);
    const current = entries.get(path);
    let bytes: Uint8Array;
    let mediaType = current?.mediaType ?? null;
    if ('bytes' in change) {
      bytes = change.bytes;
      if (change.mediaType !== undefined) mediaType = change.mediaType;
    } else {
      if (!current) throw new Error('Artifact does not exist');
      const original = new TextDecoder('utf-8', { fatal: true }).decode(await boundedArtifactBytes(this.env, this.userId, current.blobHash, scopeKey, current.size, 16 * 1024 * 1024));
      bytes = new TextEncoder().encode(applyTextEdits(original, change.edits));
    }
    const entry = { path, blobHash: await this.seal(bytes, scopeKey), size: bytes.byteLength, mediaType };
    entries.set(path, entry);
    const generation = scope.generation + 1;
    const manifestHash = await this.sealManifest(scope, generation, entries.values(), scopeKey);
    await this.source.authority.putArtifactScope({ id: scope.id, workspaceId: scope.workspaceId, generation, manifestHash, expectedGeneration: scope.generation });
    return { url: driveUrl(mount, path), path, hash: entry.blobHash, size: entry.size, mediaType, scope: mount, workspaceId: mount === 'base' ? null : spaceId };
  }

  /** Staged upload objects live under the account prefix until commit or abort removes them. */
  private uploadKey(uploadId: string, part: string): string {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(uploadId)) throw new Error('Upload does not exist');
    return `${this.uploadsPrefix()}${uploadId}/${part}`;
  }

  private uploadsPrefix(): string {
    return `users/${this.userId}/accounts/${Buffer.from(this.userId).toString('base64url')}/artifact-uploads/`;
  }

  private async uploadState(uploadId: string): Promise<ArtifactUploadState | null> {
    const object = await this.env.DATA.get(this.uploadKey(uploadId, 'state'));
    if (!object) return null;
    const state = artifactUploadStateSchema.parse(await object.json());
    if (state.spaceId !== this.source.identity.spaceId || state.generation !== (this.source.placement?.generation ?? 0)) throw new Error('This upload belongs to another workspace');
    return state;
  }

  private async requireUpload(uploadId: string): Promise<ArtifactUploadState> {
    const state = await this.uploadState(uploadId);
    if (!state) throw new Error('Upload does not exist');
    return state;
  }

  /** Reserves `uploads/<fileName>` in this session's writable scope; the file is listed only after commit. */
  async beginUpload(fileName: string, size: number, mediaType: string | null) {
    const name = (fileName.split(/[\\/]/u).at(-1) ?? '').replace(/[\u0000-\u001f\u007f]/gu, '').trim();
    if (!name || name === '.' || name === '..' || name.length > 255) throw new Error('Choose a file with a valid name');
    await this.deleteAbandonedUploads();
    const uploadId = crypto.randomUUID();
    const state: ArtifactUploadState = { spaceId: this.source.identity.spaceId, generation: this.source.placement?.generation ?? 0, path: `uploads/${name}`, size, mediaType, received: 0, last: null };
    await this.env.DATA.put(this.uploadKey(uploadId, 'state'), JSON.stringify(state));
    return { uploadId, url: driveUrl(this.writable().mount, state.path), chunkBytes: ARTIFACT_UPLOAD_CHUNK_BYTES };
  }

  /** Staged uploads untouched for a day were abandoned (a closed tab, a failed send); a new upload removes them. */
  private async deleteAbandonedUploads(): Promise<void> {
    const prefix = this.uploadsPrefix();
    const listed = await this.env.DATA.list({ prefix, limit: 1000 });
    const newest = new Map<string, number>();
    for (const object of listed.objects) {
      const uploadId = object.key.slice(prefix.length).split('/')[0]!;
      newest.set(uploadId, Math.max(newest.get(uploadId) ?? 0, object.uploaded.getTime()));
    }
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const abandoned = new Set([...newest].filter(([, uploaded]) => uploaded < cutoff).map(([uploadId]) => uploadId));
    const keys = listed.objects.filter(object => abandoned.has(object.key.slice(prefix.length).split('/')[0]!)).map(object => object.key);
    if (keys.length) await this.env.DATA.delete(keys);
  }

  /** Stores the chunk at the next offset; resending the last stored chunk is acknowledged without rewriting it. */
  async uploadChunk(uploadId: string, offset: number, sha256: string, data: string) {
    const state = await this.requireUpload(uploadId);
    const bytes = credentialProtocolBase64.decode(data);
    if ((await digest(bytes)).slice(7) !== sha256) throw new Error('Chunk hash mismatch');
    if (state.last?.offset === offset && state.last.sha256 === sha256) return { received: state.received };
    if (offset !== state.received) throw new Error(`Expected the chunk at offset ${state.received}`);
    const expected = Math.min(ARTIFACT_UPLOAD_CHUNK_BYTES, state.size - offset);
    if (expected <= 0 || bytes.byteLength !== expected) throw new Error('Chunk length does not match the upload');
    await this.env.DATA.put(this.uploadKey(uploadId, String(offset)), bytes);
    const received = offset + bytes.byteLength;
    await this.env.DATA.put(this.uploadKey(uploadId, 'state'), JSON.stringify({ ...state, received, last: { offset, sha256 } }));
    return { received };
  }

  async commitUpload(uploadId: string) {
    const state = await this.requireUpload(uploadId);
    if (state.received !== state.size) throw new Error(`Upload is incomplete: ${state.received} of ${state.size} bytes received`);
    const bytes = new Uint8Array(state.size);
    for (let offset = 0; offset < state.size; offset += ARTIFACT_UPLOAD_CHUNK_BYTES) {
      const part = await this.env.DATA.get(this.uploadKey(uploadId, String(offset)));
      const chunk = part ? new Uint8Array(await part.arrayBuffer()) : null;
      if (chunk?.byteLength !== Math.min(ARTIFACT_UPLOAD_CHUNK_BYTES, state.size - offset)) throw new Error(`Upload chunk at offset ${offset} is missing`);
      bytes.set(chunk, offset);
    }
    const artifact = await this.put(state.path, { bytes, mediaType: state.mediaType });
    await this.deleteUpload(uploadId, state);
    return artifact;
  }

  async abortUpload(uploadId: string) {
    const state = await this.uploadState(uploadId);
    if (state) await this.deleteUpload(uploadId, state);
    return { aborted: state !== null };
  }

  private async deleteUpload(uploadId: string, state: ArtifactUploadState) {
    const keys = [this.uploadKey(uploadId, 'state')];
    for (let offset = 0; offset < state.received; offset += ARTIFACT_UPLOAD_CHUNK_BYTES) keys.push(this.uploadKey(uploadId, String(offset)));
    await this.env.DATA.delete(keys);
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
    // Verify both address and decryption before publishing a bearer capability.
    for await (const _part of await readArtifactObject(this.env, this.userId, hash, await deriveArtifactScopeKey(await this.key, scope.id), entry.size)) {
      // Exhaust the authenticated stream without retaining file contents.
    }
    const record = await this.source.authority.createArtifactShare({
      token: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url'),
      scopeId: scope.id, workspaceId: scope.workspaceId, path, hash: hash as `sha256:${string}`,
      size: entry.size, mediaType: entry.mediaType, createdAt: new Date().toISOString(),
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
    const projectKey = credentialProtocolBase64.decode(await (env.CREDENTIALS as DurableObjectNamespace<CredentialVaultDO>).getByName(userId).artifactKey(userId));
    const chunks = await readArtifactObject(env, userId, record.hash, await deriveArtifactScopeKey(projectKey, record.scopeId), record.size);
    // Recheck after the asynchronous storage read so revocation/expiry during delivery cannot issue fresh bytes.
    if (!await authority.getArtifactShare(match[3]!)) return new Response('Link expired or revoked', { status: 404, headers });
    const filename = record.path.split('/').at(-1) ?? 'artifact';
    headers.set('content-type', record.mediaType && /^[\w!#$&^.+-]+\/[\w!#$&^.+-]+(?:;[^\r\n]*)?$/u.test(record.mediaType) ? record.mediaType : 'application/octet-stream');
    headers.set('content-disposition', `attachment; filename="artifact"; filename*=UTF-8''${encodeURIComponent(filename).replace(/['()*]/gu, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)}`);
    headers.set('content-length', String(record.size));
    if (request.method === 'HEAD') {
      for await (const _part of chunks) { /* Verify every part, retaining none. */ }
      if (!await authority.getArtifactShare(match[3]!)) { headers.delete('content-length'); return new Response('Link expired or revoked', { status: 404, headers }); }
      return new Response(null, { headers });
    }
    const iterator = chunks[Symbol.asyncIterator]();
    return new Response(new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await iterator.next();
          if (!await authority.getArtifactShare(match[3]!)) throw new Error('Link expired or revoked');
          if (next.done) controller.close();
          else controller.enqueue(next.value);
        } catch (error) {
          await iterator.return?.();
          controller.error(error);
        }
      },
      async cancel() { await iterator.return?.(); },
    }, { highWaterMark: 0 }), { headers });
  } catch {
    headers.delete('content-length');
    return new Response('Shared artifact is unavailable', { status: 404, headers });
  }
}

type SavedInspectorTranscriptSource = {
  kind: 'legacy';
  sessionId: string;
  ompSessionId: string;
  objectKey: string;
  objectHash: string;
  key: Uint8Array | null;
} | { kind: 'cloud'; sessionId: string; conversationId: string; cursor: number };

type SavedInspectorMetadata = Pick<InspectorView, 'checkpoint' | 'savedTranscript'>;
type SavedInspectorSource = SavedInspectorMetadata & { snapshot: SavedInspectorTranscriptSource | null };

function savedTranscriptIdentity(source: InspectorCloudContext, snapshot: Extract<SavedInspectorTranscriptSource, { kind: 'legacy' }> | null): (string | null)[] {
  return [source.project.id, source.workspace.id, snapshot?.sessionId ?? null, snapshot?.ompSessionId ?? null, snapshot?.objectKey ?? null, snapshot?.objectHash ?? null];
}

/** Discovers a saved snapshot without downloading or projecting its conversation. */
async function savedInspectorSource(env: Env, userId: string, source: InspectorCloudContext): Promise<SavedInspectorSource> {
  const sessions = await source.authority.listCanonicalSessions();
  const canonical = sessions.find((session) => session.workspaceId === source.workspace.id);
  let checkpoint: InspectorView['checkpoint'] = null;
  const placement = source.placement;
  const identity = RuntimeIdentitySchema.parse({ projectId: source.project.id, workspaceId: source.workspace.id });
  const runtime = env.SPACE_AUTHORITY.getByName(`${userId}:${source.workspace.id}`);
  async function cloudSnapshot(conversationId?: string, sessionId?: string): Promise<SavedInspectorSource> {
    const live = RuntimeSnapshotSchema.parse(await (await runtime.runtimeSnapshot(identity)).json());
    const conversation = conversationId ? live.conversations.find(item => item.id === conversationId) : live.conversations.find(item => item.parentId === null);
    if (!conversation) return { checkpoint, savedTranscript: { status: 'none', reason: 'Cloud conversation has not been created.' }, snapshot: null };
    return { checkpoint, savedTranscript: { status: 'available', reason: 'Conversation is owned by the cloud runtime and remains available without a machine.' }, snapshot: { kind: 'cloud', sessionId: sessionId ?? conversation.id, conversationId: conversation.id, cursor: live.cursor } };
  }
  try {
    if (await runtime.hasCloudRuntime()) return await cloudSnapshot();
    if (!canonical && !placement?.manifestKey) return await cloudSnapshot();
    let key: Uint8Array | null = null;
    let sessionId = canonical?.id;
    let ompSessionId = canonical?.ompSessionId;
    let objectKey = canonical?.sessionObjectKey;
    let objectHash = canonical?.sessionObjectHash;
    if (canonical?.sessionFormatVersion === 'omp-checkpoint-1') {
      key = credentialProtocolBase64.decode(await (env.CREDENTIALS as DurableObjectNamespace<CredentialVaultDO>).getByName(userId).artifactKey(userId));
    } else if (canonical?.sessionFormatVersion != null && canonical.sessionFormatVersion !== 'omp-jsonl-1') {
      throw new Error(`Unsupported canonical session format ${canonical.sessionFormatVersion}`);
    }
    if (placement?.manifestKey && placement.manifestHash) {
      key = credentialProtocolBase64.decode(await (env.CREDENTIALS as DurableObjectNamespace<CredentialVaultDO>).getByName(userId).artifactKey(userId));
      const bytes = await decryptArtifactBytes(await readObject(env, userId, placement.manifestKey, placement.manifestHash), key);
      const manifest = parseWorkspaceCheckpoint(JSON.parse(new TextDecoder().decode(bytes)), {
        projectId: source.project.id,
        spaceId: source.workspace.id,
        revision: placement.publishedRevision,
      });
      checkpoint = { sessionId: manifest.agent.sessionId, generation: placement.generation, revision: manifest.revision, lastMachineId: canonical?.machineId ?? null, createdAt: manifest.createdAt };
      sessionId = manifest.agent.sessionId;
      if (manifest.agent.kind === 'cloud') return await cloudSnapshot(manifest.agent.conversationId, manifest.agent.sessionId);
      ompSessionId = manifest.agent.ompSessionId;
      objectKey = spaceOmpCheckpointKey(source.project.id, source.workspace.id, manifest.revision);
      objectHash = manifest.agent.ompCheckpointHash;
    }
    if (!sessionId || !ompSessionId || !objectKey || !objectHash) throw new Error('A canonical session exists, but its saved conversation has not been published.');
    assertSavedObjectKey(objectKey);
    const snapshot = { kind: 'legacy' as const, sessionId, ompSessionId, objectKey, objectHash, key };
    if (!await env.DATA.head(`users/${userId}/${objectKey}`)) {
      // A verified projection can still serve Inspector pages/content after the
      // source is lost. Archival transcript export continues to require it.
      const index = await SavedTranscriptIndex.locate(env.SAVED_TRANSCRIPTS, userId, savedTranscriptIdentity(source, snapshot), key);
      if (!await index.ready()) throw new Error(`Saved object ${objectKey} is unavailable`);
    }
    return {
      checkpoint,
      savedTranscript: { status: 'available', reason: 'Saved conversation is published, not live. Contents are verified when loaded. Separately stored session attachments may be unavailable.' },
      snapshot,
    };
  } catch (error) {
    return { checkpoint, savedTranscript: { status: 'unavailable', reason: error instanceof Error ? error.message : 'The saved conversation could not be read.' }, snapshot: null };
  }
}

export async function readSavedInspectorMetadata(env: Env, userId: string, source: InspectorCloudContext): Promise<SavedInspectorMetadata> {
  const { checkpoint, savedTranscript } = await savedInspectorSource(env, userId, source);
  return { checkpoint, savedTranscript };
}

async function readCheckpointChunk(env: Env, userId: string, key: string, hash: string, size: number, encryptionKey: Uint8Array): Promise<Uint8Array> {
  const sealed = await readObject(env, userId, key, hash);
  if (sealed.byteLength !== size + 29) throw new Error(`Checkpoint chunk ${key} has an unexpected size`);
  const plaintext = await decryptArtifactBytes(sealed, encryptionKey);
  if (plaintext.byteLength !== size) throw new Error(`Checkpoint chunk ${key} has an unexpected size`);
  return plaintext;
}

async function* readSavedSnapshot(env: Env, userId: string, snapshot: Extract<SavedInspectorTranscriptSource, { kind: 'legacy' }>): AsyncGenerator<Uint8Array> {
  const stored = await readObject(env, userId, snapshot.objectKey, snapshot.objectHash);
  if (!snapshot.key) { yield stored; return; }
  if (stored[0] !== CHUNKED_CHECKPOINT_VERSION) { yield await decryptArtifactBytes(stored, snapshot.key); return; }
  const inventory = await decryptArtifactBytes(stored.subarray(1), snapshot.key);
  const manifest = chunkedCheckpointManifestSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(inventory)));
  for (const chunk of manifest.chunks) {
    const chunkKey = `${snapshot.objectKey}.chunks/${chunk.hash.slice(7)}`;
    // Leave ciphertext out of the suspended generator while the caller parses plaintext.
    yield await readCheckpointChunk(env, userId, chunkKey, chunk.hash, chunk.size, snapshot.key);
  }
}

async function legacyCheckpointKey(env: Env, userId: string): Promise<Uint8Array> {
  if (userId !== env.ACCOUNT_ID) throw new Error('Account does not own this checkpoint');
  return credentialProtocolBase64.decode(await (env.CREDENTIALS as DurableObjectNamespace<CredentialVaultDO>).getByName(userId).artifactKey(userId));
}

export async function readSavedInspectorTranscript(env: Env, userId: string, source: InspectorCloudContext): Promise<AsyncIterable<TranscriptEvent>> {
  const { savedTranscript, snapshot } = await savedInspectorSource(env, userId, source);
  if (savedTranscript.status === 'none') return (async function* () {})();
  if (!snapshot) throw new Error(savedTranscript.reason ?? 'The saved conversation could not be read.');
  if (snapshot.kind === 'cloud') {
    const identity = RuntimeIdentitySchema.parse({ projectId: source.project.id, workspaceId: source.workspace.id });
    const response = await env.SPACE_AUTHORITY.getByName(`${userId}:${source.workspace.id}`).runtimeTranscript({ ...identity, conversationId: snapshot.conversationId }, 'ndjson');
    return (async function* () {
      for await (const event of readRuntimeTranscript(response)) yield { ...event, sessionId: snapshot.sessionId, createdAt: new Date(event.createdAt) };
    })();
  }
  return (await openLegacySession(() => readSavedSnapshot(env, userId, snapshot), snapshot.sessionId, snapshot.ompSessionId)).events;
}

async function savedTranscriptIndex(env: Env, userId: string, source: InspectorCloudContext, saved: SavedInspectorSource): Promise<SavedTranscriptIndex> {
  const { savedTranscript, snapshot } = saved;
  if (snapshot?.kind === 'cloud') throw new Error('Cloud conversations use their owning runtime transcript index');
  if (!snapshot && savedTranscript.status !== 'none') throw new Error(savedTranscript.reason ?? 'The saved conversation could not be read.');
  return SavedTranscriptIndex.open(env.SAVED_TRANSCRIPTS, userId,
    savedTranscriptIdentity(source, snapshot),
    snapshot?.key ?? null,
    async () => snapshot ? (await openLegacySession(() => readSavedSnapshot(env, userId, snapshot), snapshot.sessionId, snapshot.ompSessionId)).events : []);
}

export async function readSavedInspectorTranscriptPage(env: Env, userId: string, source: InspectorCloudContext, request: TranscriptPageRequest) {
  const saved = await savedInspectorSource(env, userId, source);
  if (saved.snapshot?.kind === 'cloud') {
    const response = await env.SPACE_AUTHORITY.getByName(`${userId}:${source.workspace.id}`).runtimeSession({
      projectId: source.project.id, workspaceId: source.workspace.id, conversationId: saved.snapshot.conversationId,
      command: { type: 'transcriptPage', request },
    }, { canApprove: false });
    const result = RuntimeSessionResultSchema.parse(await response.json());
    if (!result.transcriptPage) throw new Error('Cloud transcript page is unavailable');
    return result.transcriptPage;
  }
  return (await savedTranscriptIndex(env, userId, source, saved)).page(request);
}

export async function readSavedInspectorTranscriptContent(env: Env, userId: string, source: InspectorCloudContext, request: TranscriptContentRequest) {
  const saved = await savedInspectorSource(env, userId, source);
  if (saved.snapshot?.kind === 'cloud') {
    const response = await env.SPACE_AUTHORITY.getByName(`${userId}:${source.workspace.id}`).runtimeSession({
      projectId: source.project.id, workspaceId: source.workspace.id, conversationId: saved.snapshot.conversationId,
      command: { type: 'transcriptContent', request },
    }, { canApprove: false });
    const result = RuntimeSessionResultSchema.parse(await response.json());
    if (!result.transcriptContent) throw new Error('Cloud transcript content is unavailable');
    return result.transcriptContent;
  }
  return (await savedTranscriptIndex(env, userId, source, saved)).content(request);
}
