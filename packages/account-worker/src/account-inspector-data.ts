import { posix } from 'node:path';
import {
  artifactManifestSchema, credentialProtocolBase64, decryptArtifactBytes, deriveArtifactScopeKey, encryptArtifactBytes,
  type ArtifactCopyRecord, type ArtifactManifest, type ArtifactShareRecord, type CanonicalArtifactScope, type CloudProjectSummary, type CloudWorkspaceDefinition,
  type InspectorBootstrapView, type InspectorIdentity,
} from '@gitspace/protocol';
import type { TranscriptEvent } from '@gitspace/protocol/transcript';
import { createResourcePreview, parseResourceUri } from '@gitspace/protocol/resource-uri';
import type { CredentialVaultDO } from './application.js';
import type { ProjectAuthorityDO, UserProjectIndexDO } from './project-authority.js';
import type { SpaceAuthorityDO } from './space-authority.js';
import { CHUNKED_CHECKPOINT_VERSION, chunkedCheckpointManifestSchema, parseWorkspaceCheckpoint, spaceOmpCheckpointKey, type SpaceAuthorityRecord } from '@gitspace/protocol-workspace';
import type { SpaceContextDO } from './space-context.js';
import { SavedTranscriptIndex } from './saved-transcript-index.js';
import type { TranscriptContentRequest, TranscriptPageRequest } from '@gitspace/blocks';

export class InspectorWorkspaceMissing extends Error {
  constructor(readonly spaceId: string) { super(`Workspace ${spaceId} does not exist`); }
}
export class InspectorGenerationConflict extends Error {
  constructor(readonly spaceId: string, readonly expected: number, readonly actual: number) { super('Space generation changed'); }
}

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
  const placement = await (env.SPACE_AUTHORITY as DurableObjectNamespace<SpaceAuthorityDO>).getByName(`${userId}:${spaceId}`).get();
  const resolvedProjectId = placement?.projectId ?? projectId
    ?? await (env.USER_PROJECTS as DurableObjectNamespace<UserProjectIndexDO>).getByName(userId).locateWorkspace(spaceId);
  if (!resolvedProjectId || (projectId !== undefined && projectId !== resolvedProjectId)) throw new InspectorWorkspaceMissing(spaceId);
  const authority = (env.PROJECT_AUTHORITY as DurableObjectNamespace<ProjectAuthorityDO>).getByName(`${userId}:${resolvedProjectId}`);
  const [project, workspaces] = await Promise.all([authority.getProject(), authority.listWorkspaces()]);
  const workspace = workspaces.find((candidate) => candidate.id === spaceId);
  if (!project || !workspace || workspace.projectId !== project.id) throw new InspectorWorkspaceMissing(spaceId);
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

/** Reads the same encrypted, content-addressed objects as CloudArtifactObjectStore. */
export class InspectorCloudArtifacts {
  private readonly key: Promise<Uint8Array>;
  constructor(private readonly env: Env, private readonly userId: string, private readonly source: InspectorCloudContext) {
    this.key = (env.CREDENTIALS as DurableObjectNamespace<CredentialVaultDO>).getByName(userId).artifactKey(userId).then(credentialProtocolBase64.decode);
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
    const sealed = await readObject(this.env, this.userId, this.objectKey(scope.manifestHash), scope.manifestHash);
    const bytes = await decryptArtifactBytes(sealed, await deriveArtifactScopeKey(await this.key, scope.id));
    const manifest = artifactManifestSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
    if (manifest.scopeId !== scope.id || manifest.generation !== scope.generation) throw new Error('Artifact manifest does not match its canonical scope and generation');
    if (new Set(manifest.entries.map((entry) => entry.path)).size !== manifest.entries.length) throw new Error('Artifact manifest contains duplicate paths');
    return manifest.entries;
  }

  private async resolve(url: string) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'local:') throw new Error('Artifact URL must use local://');
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
    const scope = (await this.source.authority.listArtifactScopes()).find((candidate) => candidate.workspaceId === spaceId);
    if (!scope) throw new Error('Artifact scope does not exist');
    return { scope, path };
  }

  async list(): Promise<InspectorBootstrapView['artifacts']> {
    const scopes = await this.source.authority.listArtifactScopes();
    const selected = scopes.filter((scope) => scope.workspaceId === this.source.workspace.id || scope.workspaceId === this.source.project.id);
    const groups = await Promise.all(selected.map(async (scope) => {
      const base = scope.workspaceId === this.source.project.id;
      return (await this.entries(scope)).map((entry) => ({
        url: `local://${base ? 'base' : 'workspace'}/${entry.path}`, path: entry.path, hash: entry.blobHash,
        size: entry.size, mediaType: entry.mediaType, scope: base ? 'base' as const : 'workspace' as const,
        workspaceId: base ? null : scope.workspaceId,
      }));
    }));
    return groups.flat();
  }

  async read(url: string, hash?: string | null) {
    const resource = parseResourceUri(url);
    if (resource?.kind !== 'local' || !resource.mount) throw new Error('Inspector artifacts require a canonical local resource URI');
    const resolved = await this.resolve(resource.url);
    const current = (await this.entries(resolved.scope)).find((candidate) => candidate.path === resolved.path);
    const entry = hash ? { blobHash: hash, mediaType: current?.mediaType ?? null } : current;
    if (!entry) throw new Error('Artifact does not exist');
    const sealed = await readObject(this.env, this.userId, this.objectKey(entry.blobHash), entry.blobHash);
    const bytes = await decryptArtifactBytes(sealed, await deriveArtifactScopeKey(await this.key, resolved.scope.id));
    return createResourcePreview(url, bytes, entry.mediaType);
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
    const destination = scopes.find((scope) => scope.workspaceId === this.source.project.id) ?? {
      id: `space:${this.source.project.id}`, workspaceId: this.source.project.id, generation: 0, manifestHash: null, updatedAt: new Date().toISOString(),
    };
    if (destination.generation !== expectedProjectGeneration) throw new Error('Project artifacts changed. Refresh and choose destination paths again.');
    const [sourceEntries, destinationEntries] = await Promise.all([this.entries(source), this.entries(destination)]);
    const sourceByPath = new Map(sourceEntries.map((entry) => [entry.path, entry]));
    const destinationByPath = new Map(destinationEntries.map((entry) => [entry.path, entry]));
    const paths = new Set<string>();
    const selected = files.map((file) => {
      const parsed = new URL(file.url);
      if (parsed.protocol !== 'local:' || parsed.hostname !== 'workspace') throw new Error('Only this workspace’s artifacts can be copied');
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
      const sealed = await readObject(this.env, this.userId, this.objectKey(entry.blobHash), entry.blobHash);
      const bytes = await decryptArtifactBytes(sealed, sourceKey);
      if (bytes.byteLength !== entry.size) throw new Error('Artifact size does not match its manifest');
      const copied = await encryptArtifactBytes(bytes, destinationKey);
      const hash = await digest(copied);
      await this.env.DATA.put(`users/${this.userId}/${this.objectKey(hash)}`, copied);
      destinationByPath.set(target, { path: target, blobHash: hash, size: bytes.byteLength, mediaType: entry.mediaType });
      copies.push({
        id: crypto.randomUUID(), sourceScopeId: source.id, sourceWorkspaceId: source.workspaceId,
        sourceGeneration: source.generation, sourcePath: entry.path, sourceHash: entry.blobHash as `sha256:${string}`,
        destinationScopeId: destination.id, destinationPath: target, destinationHash: hash, destinationGeneration: generation, createdAt,
      });
    }
    const manifest: ArtifactManifest = { version: 1, scopeId: destination.id, generation, entries: [...destinationByPath.values()].sort((left, right) => left.path.localeCompare(right.path)) };
    const sealedManifest = await encryptArtifactBytes(new TextEncoder().encode(JSON.stringify(manifest)), destinationKey);
    const manifestHash = await digest(sealedManifest);
    await this.env.DATA.put(`users/${this.userId}/${this.objectKey(manifestHash)}`, sealedManifest);
    await this.source.authority.commitArtifactCopies({ id: destination.id, workspaceId: destination.workspaceId, generation, manifestHash, expectedGeneration: destination.generation }, copies);
    return this.catalog();
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
    const sealed = await readObject(this.env, this.userId, this.objectKey(hash), hash);
    const bytes = await decryptArtifactBytes(sealed, await deriveArtifactScopeKey(await this.key, scope.id));
    if (bytes.byteLength !== entry.size) throw new Error('Artifact size does not match its manifest');
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
    const objectKey = `accounts/${Buffer.from(userId).toString('base64url')}/artifacts/sha256/${record.hash.slice(7)}`;
    const sealed = await readObject(env, userId, objectKey, record.hash);
    const bytes = await decryptArtifactBytes(sealed, await deriveArtifactScopeKey(projectKey, record.scopeId));
    if (bytes.byteLength !== record.size) throw new Error('Shared artifact size mismatch');
    // Recheck after the asynchronous storage read so revocation/expiry during delivery cannot issue fresh bytes.
    if (!await authority.getArtifactShare(match[3]!)) return new Response('Link expired or revoked', { status: 404, headers });
    const filename = record.path.split('/').at(-1) ?? 'artifact';
    headers.set('content-type', record.mediaType && /^[\w!#$&^.+-]+\/[\w!#$&^.+-]+(?:;[^\r\n]*)?$/u.test(record.mediaType) ? record.mediaType : 'application/octet-stream');
    headers.set('content-disposition', `attachment; filename="artifact"; filename*=UTF-8''${encodeURIComponent(filename).replace(/['()*]/gu, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)}`);
    headers.set('content-length', String(bytes.byteLength));
    return new Response(request.method === 'HEAD' ? null : bytes as Uint8Array<ArrayBuffer>, { headers });
  } catch {
    return new Response('Shared artifact is unavailable', { status: 404, headers });
  }
}

/** The persisted OMP v3 leaf branch, using the same message/custom projection as account-omp.
 * Unknown versions or corrupt trees are unavailable, never silently presented as an empty conversation. */
export function savedTranscriptEvents(bytes: Uint8Array, sessionId: string, ompSessionId: string): TranscriptEvent[] {
  const records = new TextDecoder('utf-8', { fatal: true }).decode(bytes).split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line) as Record<string, unknown>);
  if (records[0]?.type === 'title' && records[0].v === 1) records.shift();
  const header = records.shift();
  if (header?.type !== 'session' || header.version !== 3 || header.id !== ompSessionId) throw new Error('Saved session needs an OMP-compatible reader for its format');
  const entries = new Map<string, Record<string, unknown>>();
  let leaf: string | null = null;
  for (const entry of records) {
    if (typeof entry.id !== 'string' || (entry.parentId !== null && typeof entry.parentId !== 'string') || entries.has(entry.id)) throw new Error('Saved session tree is invalid');
    entries.set(entry.id, entry);
    leaf = entry.id;
  }
  const branch: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  while (leaf !== null) {
    const entry = entries.get(leaf);
    if (!entry || seen.has(leaf)) throw new Error('Saved session branch is incomplete');
    seen.add(leaf);
    branch.push(entry);
    leaf = entry.parentId as string | null;
  }
  const events: TranscriptEvent[] = [];
  for (const entry of branch.reverse()) {
    if (entry.type !== 'message' && entry.type !== 'custom') continue;
    if (typeof entry.timestamp !== 'string' || !Number.isFinite(Date.parse(entry.timestamp))) throw new Error('Saved session timestamp is invalid');
    if (entry.type === 'message' && (!entry.message || typeof entry.message !== 'object' || Array.isArray(entry.message))) throw new Error('Saved message is invalid');
    if (entry.type === 'custom' && typeof entry.customType !== 'string') throw new Error('Saved custom event is invalid');
    const payload = entry.type === 'message' ? { message: entry.message }
      : entry.data && typeof entry.data === 'object' && !Array.isArray(entry.data) ? entry.data as Record<string, unknown> : { value: entry.data };
    events.push({ sessionId, ordinal: events.length + 1, kind: entry.type === 'message' ? 'message_end' : entry.customType as string, payload, createdAt: new Date(entry.timestamp) });
  }
  return events;
}

interface SavedInspectorTranscriptSource {
  sessionId: string;
  ompSessionId: string;
  objectKey: string;
  objectHash: string;
  key: Uint8Array | null;
}

type SavedInspectorMetadata = Pick<InspectorBootstrapView, 'checkpoint' | 'savedTranscript'>;

/** Discovers a saved snapshot without downloading or projecting its conversation. */
async function savedInspectorSource(env: Env, userId: string, source: InspectorCloudContext): Promise<SavedInspectorMetadata & { snapshot: SavedInspectorTranscriptSource | null }> {
  const sessions = await source.authority.listCanonicalSessions();
  const canonical = sessions.find((session) => session.workspaceId === source.workspace.id);
  let checkpoint: InspectorBootstrapView['checkpoint'] = null;
  const placement = source.placement;
  if (!canonical && !placement?.manifestKey) return { checkpoint, savedTranscript: { status: 'none', reason: 'No saved session has been published for this workspace.' }, snapshot: null };
  try {
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
      ompSessionId = manifest.agent.ompSessionId;
      objectKey = spaceOmpCheckpointKey(source.project.id, source.workspace.id, manifest.revision);
      objectHash = manifest.agent.ompCheckpointHash;
    }
    if (!sessionId || !ompSessionId || !objectKey || !objectHash) throw new Error('A canonical session exists, but its saved conversation has not been published.');
    assertSavedObjectKey(objectKey);
    if (!await env.DATA.head(`users/${userId}/${objectKey}`)) throw new Error(`Saved object ${objectKey} is unavailable`);
    return {
      checkpoint,
      savedTranscript: { status: 'available', reason: 'Saved conversation is published, not live. Contents are verified when loaded. Separately stored session attachments may be unavailable.' },
      snapshot: { sessionId, ompSessionId, objectKey, objectHash, key },
    };
  } catch (error) {
    return { checkpoint, savedTranscript: { status: 'unavailable', reason: error instanceof Error ? error.message : 'The saved conversation could not be read.' }, snapshot: null };
  }
}

export async function readSavedInspectorMetadata(env: Env, userId: string, source: InspectorCloudContext): Promise<SavedInspectorMetadata> {
  const { checkpoint, savedTranscript } = await savedInspectorSource(env, userId, source);
  return { checkpoint, savedTranscript };
}

async function readSavedSnapshot(env: Env, userId: string, snapshot: SavedInspectorTranscriptSource): Promise<Uint8Array> {
  const stored = await readObject(env, userId, snapshot.objectKey, snapshot.objectHash);
  if (!snapshot.key) return stored;
  if (stored[0] !== CHUNKED_CHECKPOINT_VERSION) return decryptArtifactBytes(stored, snapshot.key);
  const inventory = await decryptArtifactBytes(stored.subarray(1), snapshot.key);
  const manifest = chunkedCheckpointManifestSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(inventory)));
  const bytes = new Uint8Array(manifest.size);
  let offset = 0;
  for (const chunk of manifest.chunks) {
    const chunkKey = `${snapshot.objectKey}.chunks/${chunk.hash.slice(7)}`;
    const sealed = await readObject(env, userId, chunkKey, chunk.hash);
    const plaintext = await decryptArtifactBytes(sealed, snapshot.key);
    if (plaintext.byteLength !== chunk.size) throw new Error(`Checkpoint chunk ${chunkKey} has an unexpected size`);
    bytes.set(plaintext, offset);
    offset += plaintext.byteLength;
  }
  return bytes;
}

export async function readSavedInspectorTranscript(env: Env, userId: string, source: InspectorCloudContext): Promise<TranscriptEvent[]> {
  const { savedTranscript, snapshot } = await savedInspectorSource(env, userId, source);
  if (savedTranscript.status === 'none') return [];
  if (!snapshot) throw new Error(savedTranscript.reason ?? 'The saved conversation could not be read.');
  const bytes = await readSavedSnapshot(env, userId, snapshot);
  return savedTranscriptEvents(bytes, snapshot.sessionId, snapshot.ompSessionId);
}

async function savedTranscriptIndex(env: Env, userId: string, source: InspectorCloudContext): Promise<SavedTranscriptIndex> {
  const { savedTranscript, snapshot } = await savedInspectorSource(env, userId, source);
  if (!snapshot && savedTranscript.status !== 'none') throw new Error(savedTranscript.reason ?? 'The saved conversation could not be read.');
  return SavedTranscriptIndex.open(env.DATA, userId,
    [source.project.id, source.workspace.id, snapshot?.sessionId ?? null, snapshot?.ompSessionId ?? null, snapshot?.objectKey ?? null, snapshot?.objectHash ?? null],
    snapshot?.key ?? null,
    async () => {
      if (!snapshot) return [];
      const bytes = await readSavedSnapshot(env, userId, snapshot);
      return savedTranscriptEvents(bytes, snapshot.sessionId, snapshot.ompSessionId);
    });
}

export async function readSavedInspectorTranscriptPage(env: Env, userId: string, source: InspectorCloudContext, request: TranscriptPageRequest) {
  return (await savedTranscriptIndex(env, userId, source)).page(request);
}

export async function readSavedInspectorTranscriptContent(env: Env, userId: string, source: InspectorCloudContext, request: TranscriptContentRequest) {
  return (await savedTranscriptIndex(env, userId, source)).content(request);
}
