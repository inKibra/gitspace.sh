import { posix } from 'node:path';
import {
  artifactManifestSchema, credentialProtocolBase64, decryptArtifactBytes, deriveArtifactScopeKey,
  spaceCheckpointManifestSchema, spaceOmpCheckpointKey,
  type ArtifactManifest, type CanonicalArtifactScope, type CloudProjectSummary, type CloudWorkspaceDefinition,
  type InspectorBootstrapView, type InspectorIdentity,
} from '@gitspace/protocol';
import type { CredentialVaultDO } from './index.js';
import type { ProjectAuthorityDO, UserProjectIndexDO } from './project-authority.js';
import type { SpaceAuthorityDO, SpaceAuthorityRecord } from './space-authority.js';
import { InspectorStateError, type SpaceContextDO } from './space-context.js';

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

async function digest(bytes: Uint8Array<ArrayBuffer>): Promise<`sha256:${string}`> {
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return `sha256:${Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

async function readObject(env: Env, userId: string, key: string, hash: string): Promise<Uint8Array> {
  if (!key || key.startsWith('/') || key.includes('..') || key.length > 1_024) throw new Error('Saved object key is invalid');
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

  async read(url: string) {
    const resolved = await this.resolve(url);
    const entry = (await this.entries(resolved.scope)).find((candidate) => candidate.path === resolved.path);
    if (!entry) throw new Error('Artifact does not exist');
    const sealed = await readObject(this.env, this.userId, this.objectKey(entry.blobHash), entry.blobHash);
    const bytes = await decryptArtifactBytes(sealed, await deriveArtifactScopeKey(await this.key, resolved.scope.id));
    let text: string | null = null;
    if (bytes.byteLength <= 2 * 1024 * 1024) {
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { /* Binary artifact. */ }
    }
    return { url, mediaType: entry.mediaType, base64: Buffer.from(bytes).toString('base64'), text };
  }
}

/** The persisted OMP v3 leaf branch, using the same message/custom projection as account-omp.
 * Unknown versions or corrupt trees are unavailable, never silently presented as an empty conversation. */
export function savedTranscriptEvents(bytes: Uint8Array, sessionId: string, ompSessionId: string): InspectorBootstrapView['savedTranscript']['events'] {
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
  const events: Array<InspectorBootstrapView['savedTranscript']['events'][number]> = [];
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

export async function readSavedInspectorTranscript(env: Env, userId: string, source: InspectorCloudContext): Promise<Pick<InspectorBootstrapView, 'checkpoint' | 'savedTranscript'>> {
  const sessions = await source.authority.listCanonicalSessions();
  const canonical = sessions.find((session) => session.workspaceId === source.workspace.id);
  let checkpoint: InspectorBootstrapView['checkpoint'] = null;
  const placement = source.placement;
  if (!canonical && !placement?.manifestKey) return { checkpoint, savedTranscript: { status: 'none', reason: 'No saved session has been published for this workspace.', events: [] } };
  try {
    const key = credentialProtocolBase64.decode(await (env.CREDENTIALS as DurableObjectNamespace<CredentialVaultDO>).getByName(userId).artifactKey(userId));
    let sessionId = canonical?.id;
    let ompSessionId = canonical?.ompSessionId;
    let objectKey = canonical?.sessionObjectKey;
    let objectHash = canonical?.sessionObjectHash;
    let encrypted = false;
    if (placement?.manifestKey && placement.manifestHash) {
      const bytes = await decryptArtifactBytes(await readObject(env, userId, placement.manifestKey, placement.manifestHash), key);
      const manifest = spaceCheckpointManifestSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
      if (manifest.projectId !== source.project.id || manifest.spaceId !== source.workspace.id || manifest.revision !== placement.checkpointRevision) throw new InspectorStateError('Saved checkpoint identity does not match the workspace');
      checkpoint = { sessionId: manifest.agent.sessionId, generation: placement.generation, revision: manifest.revision, lastMachineId: canonical?.machineId ?? null, createdAt: manifest.createdAt };
      sessionId = manifest.agent.sessionId;
      ompSessionId = manifest.agent.ompSessionId;
      objectKey = spaceOmpCheckpointKey(source.project.id, source.workspace.id, manifest.revision);
      objectHash = manifest.agent.ompCheckpointHash;
      encrypted = true;
    }
    if (!sessionId || !ompSessionId || !objectKey || !objectHash) throw new Error('A canonical session exists, but its saved conversation has not been published.');
    // Canonical session snapshots are published through the raw CheckpointBlobStore;
    // lifecycle checkpoint objects use EncryptedCheckpointBlobStore.
    const stored = await readObject(env, userId, objectKey, objectHash);
    const bytes = encrypted ? await decryptArtifactBytes(stored, key) : stored;
    return { checkpoint, savedTranscript: { status: 'available', reason: 'Saved conversation, not a live session. Separately stored session attachments may be unavailable.', events: savedTranscriptEvents(bytes, sessionId, ompSessionId) } };
  } catch (error) {
    return { checkpoint, savedTranscript: { status: 'unavailable', reason: error instanceof Error ? error.message : 'The saved conversation could not be read.', events: [] } };
  }
}
