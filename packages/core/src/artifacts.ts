import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import {
  artifactManifestSchema,
  deriveArtifactScopeKey,
  type ArtifactManifest,
  createRelayAuthorization,
  decryptArtifactBytes,
  encryptArtifactBytes,
} from '@gitspace/protocol';
import { and, eq, inArray } from 'drizzle-orm';
import { Result, TaggedError, type Result as ResultType } from 'better-result';
import type { GitSpaceDatabase } from './database.js';
import { artifactBlobs, artifactEntries, artifactScopes, type ArtifactEntry, type ArtifactScope } from './schema.js';

const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/u;

export interface ArtifactObjectStore {
  put(hash: `sha256:${string}`, sealed: Uint8Array): Promise<void>;
  get(hash: `sha256:${string}`): Promise<Uint8Array | null>;
}

export class RelayArtifactObjectStore implements ArtifactObjectStore {
  constructor(
    private readonly baseUrl: string,
    private readonly signingPrivateKey: Uint8Array,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async put(hash: `sha256:${string}`, sealed: Uint8Array): Promise<void> {
    const target = `/artifacts/${hash.slice('sha256:'.length)}`;
    const response = await this.fetcher(new URL(target, this.baseUrl), {
      method: 'PUT',
      headers: {
        authorization: createRelayAuthorization(this.signingPrivateKey, target),
        'content-length': String(sealed.byteLength),
        'content-type': 'application/vnd.gitspace.encrypted',
        'x-gitspace-encryption': 'aes-256-gcm-v1',
      },
      body: ownedBuffer(sealed),
    });
    if (!response.ok) throw new Error(`Relay artifact upload failed with ${response.status}: ${await response.text()}`);
  }

  async get(hash: `sha256:${string}`): Promise<Uint8Array | null> {
    const target = `/artifacts/${hash.slice('sha256:'.length)}`;
    const response = await this.fetcher(new URL(target, this.baseUrl), {
      headers: { authorization: createRelayAuthorization(this.signingPrivateKey, target) },
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Relay artifact download failed with ${response.status}: ${await response.text()}`);
    return new Uint8Array(await response.arrayBuffer());
  }
}

export class FileArtifactObjectStore implements ArtifactObjectStore {
  constructor(private readonly root: string) {}

  async put(hash: `sha256:${string}`, sealed: Uint8Array): Promise<void> {
    await atomicWrite(join(this.root, hash.slice('sha256:'.length)), sealed);
  }

  async get(hash: `sha256:${string}`): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await readFile(join(this.root, hash.slice('sha256:'.length))));
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null;
      throw error;
    }
  }
}

export class MemoryArtifactObjectStore implements ArtifactObjectStore {
  readonly objects = new Map<string, Uint8Array>();
  readonly reads: string[] = [];

  async put(hash: `sha256:${string}`, sealed: Uint8Array): Promise<void> {
    this.objects.set(hash, sealed.slice());
  }

  async get(hash: `sha256:${string}`): Promise<Uint8Array | null> {
    this.reads.push(hash);
    return this.objects.get(hash)?.slice() ?? null;
  }
}

export type ArtifactCapability =
  | { kind: 'project'; projectId: string; currentWorkspaceId?: string }
  | { kind: 'workspace'; projectId: string; workspaceId: string };

export interface LocalArtifactEntry {
  url: string;
  path: string;
  size: number;
  mediaType: string | null;
  hash: string;
  scope: 'base' | 'workspace';
  workspaceId: string | null;
}

interface ResolvedArtifactPath {
  scope: ArtifactScope;
  path: string;
  writable: boolean;
  displayRoot: string;
}


export class ArtifactAccessDenied extends TaggedError('ArtifactAccessDenied')<{
  url: string;
  message: string;
}> {}
export class ArtifactNotFound extends TaggedError('ArtifactNotFound')<{
  url: string;
  message: string;
}> {}
export class ArtifactConflict extends TaggedError('ArtifactConflict')<{
  scopeId: string;
  message: string;
}> {}
export class ArtifactStorageError extends TaggedError('ArtifactStorageError')<{
  operation: string;
  message: string;
}> {}
export type ArtifactError = ArtifactAccessDenied | ArtifactNotFound | ArtifactConflict | ArtifactStorageError;

function ownedBuffer(bytes: Uint8Array): ArrayBuffer {
  const owned = new Uint8Array(bytes.byteLength);
  owned.set(bytes);
  return owned.buffer;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

async function digest(bytes: Uint8Array): Promise<`sha256:${string}`> {
  const buffer = await crypto.subtle.digest('SHA-256', ownedBuffer(bytes));
  const hex = Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `sha256:${hex}`;
}

async function atomicWrite(path: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, bytes);
  await rename(temporary, path);
}

function storageError(operation: string, error: unknown): ArtifactStorageError {
  return new ArtifactStorageError({
    operation,
    message: error instanceof Error ? error.message : String(error),
  });
}

function normalizedArtifactPath(pathname: string): string | null {
  const decoded = decodeURIComponent(pathname).replace(/^\/+/, '');
  if (!decoded) return '';
  const normalized = posix.normalize(decoded);
  if (normalized === '..' || normalized.startsWith('../') || posix.isAbsolute(normalized)) return null;
  return normalized;
}

export class LocalArtifactResolver {
  constructor(
    private readonly database: GitSpaceDatabase,
    private readonly store: ArtifactObjectStore,
    private readonly cacheRoot: string,
    private readonly projectKey: Uint8Array,
  ) {
    if (projectKey.byteLength !== 32) throw new RangeError('Project artifact key must be 32 bytes');
  }

  async write(
    capability: ArtifactCapability,
    url: string,
    bytes: Uint8Array,
    mediaType?: string,
  ): Promise<ResultType<LocalArtifactEntry, ArtifactError>> {
    const resolved = this.resolve(capability, url);
    if (resolved.status === 'error') return resolved;
    if (!resolved.value.path) {
      return Result.err(new ArtifactAccessDenied({ url, message: 'Artifact writes require a file path' }));
    }
    if (!resolved.value.writable) {
      return Result.err(new ArtifactAccessDenied({ url, message: 'Capability cannot write this artifact scope' }));
    }
    try {
      const existing = this.database.orm.select().from(artifactEntries).where(and(
        eq(artifactEntries.scopeId, resolved.value.scope.id),
        eq(artifactEntries.path, resolved.value.path),
      )).get();
      if (existing && existing.size === bytes.byteLength && existing.mediaType === (mediaType ?? null)) {
        const blob = this.database.orm.select().from(artifactBlobs).where(eq(artifactBlobs.hash, existing.blobHash)).get();
        if (blob?.cachePath) {
          try {
            const cached = new Uint8Array(await readFile(blob.cachePath));
            if (equalBytes(cached, bytes)) return Result.ok(this.toLocalEntry(resolved.value, existing));
          } catch (error) {
            if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
          }
        }
      }
      const key = await deriveArtifactScopeKey(this.projectKey, resolved.value.scope.id);
      const sealed = await encryptArtifactBytes(bytes, key);
      const hash = await digest(sealed);
      const cachePath = this.cachePath(hash);
      await atomicWrite(cachePath, bytes);
      await atomicWrite(this.sealedPath(hash), sealed);
      const now = new Date().toISOString();
      this.database.orm.transaction((tx) => {
        tx.insert(artifactBlobs).values({
          hash,
          size: bytes.byteLength,
          cachePath,
          state: 'dirty',
          lastAccessedAt: now,
          createdAt: now,
        }).onConflictDoUpdate({
          target: artifactBlobs.hash,
          set: { cachePath, state: 'dirty', lastAccessedAt: now },
        }).run();
        tx.insert(artifactEntries).values({
          scopeId: resolved.value.scope.id,
          path: resolved.value.path,
          blobHash: hash,
          size: bytes.byteLength,
          mediaType: mediaType ?? null,
          generation: resolved.value.scope.generation + 1,
          updatedAt: now,
        }).onConflictDoUpdate({
          target: [artifactEntries.scopeId, artifactEntries.path],
          set: {
            blobHash: hash,
            size: bytes.byteLength,
            mediaType: mediaType ?? null,
            generation: resolved.value.scope.generation + 1,
            updatedAt: now,
          },
        }).run();
        tx.update(artifactScopes).set({ dirty: true, updatedAt: now })
          .where(eq(artifactScopes.id, resolved.value.scope.id)).run();
      });
      return Result.ok(this.toLocalEntry(resolved.value, {
        scopeId: resolved.value.scope.id,
        path: resolved.value.path,
        blobHash: hash,
        size: bytes.byteLength,
        mediaType: mediaType ?? null,
        generation: resolved.value.scope.generation + 1,
        updatedAt: now,
      }));
    } catch (error) {
      return Result.err(storageError('write', error));
    }
  }

  remove(capability: ArtifactCapability, url: string): ResultType<void, ArtifactError> {
    const resolved = this.resolve(capability, url);
    if (resolved.status === 'error') return resolved;
    if (!resolved.value.path || !resolved.value.writable) {
      return Result.err(new ArtifactAccessDenied({ url, message: 'Capability cannot remove this artifact path' }));
    }
    const now = new Date().toISOString();
    const removed = this.database.orm.transaction((tx) => {
      const entry = tx.delete(artifactEntries).where(and(
        eq(artifactEntries.scopeId, resolved.value.scope.id),
        eq(artifactEntries.path, resolved.value.path),
      )).returning({ path: artifactEntries.path }).get();
      if (!entry) return false;
      tx.update(artifactScopes).set({ dirty: true, updatedAt: now })
        .where(eq(artifactScopes.id, resolved.value.scope.id)).run();
      return true;
    });
    return removed
      ? Result.ok(undefined)
      : Result.err(new ArtifactNotFound({ url, message: `Artifact ${url} does not exist` }));
  }

  async read(capability: ArtifactCapability, url: string): Promise<ResultType<Uint8Array, ArtifactError>> {
    const resolved = this.resolve(capability, url);
    if (resolved.status === 'error') return resolved;
    const entry = this.database.orm.select().from(artifactEntries).where(and(
      eq(artifactEntries.scopeId, resolved.value.scope.id),
      eq(artifactEntries.path, resolved.value.path),
    )).get();
    if (!entry) return Result.err(new ArtifactNotFound({ url, message: `Artifact ${url} does not exist` }));
    try {
      const blob = this.database.orm.select().from(artifactBlobs).where(eq(artifactBlobs.hash, entry.blobHash)).get();
      if (blob?.cachePath) {
        try {
          const bytes = new Uint8Array(await readFile(blob.cachePath));
          this.touchBlob(entry.blobHash);
          return Result.ok(bytes);
        } catch (error) {
          if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
        }
      }
      if (!HASH_PATTERN.test(entry.blobHash)) throw new Error(`Invalid artifact hash ${entry.blobHash}`);
      const sealed = await this.store.get(entry.blobHash as `sha256:${string}`);
      if (!sealed) return Result.err(new ArtifactNotFound({ url, message: `Remote artifact ${entry.blobHash} does not exist` }));
      if (await digest(sealed) !== entry.blobHash) throw new Error(`Remote artifact ${entry.blobHash} failed content verification`);
      const bytes = await decryptArtifactBytes(sealed, await deriveArtifactScopeKey(this.projectKey, resolved.value.scope.id));
      const cachePath = this.cachePath(entry.blobHash);
      await atomicWrite(cachePath, bytes);
      const now = new Date().toISOString();
      this.database.orm.insert(artifactBlobs).values({
        hash: entry.blobHash,
        size: bytes.byteLength,
        cachePath,
        state: 'cached',
        lastAccessedAt: now,
        createdAt: now,
      }).onConflictDoUpdate({
        target: artifactBlobs.hash,
        set: { cachePath, state: 'cached', lastAccessedAt: now },
      }).run();
      return Result.ok(bytes);
    } catch (error) {
      if (error instanceof ArtifactNotFound) return Result.err(error);
      return Result.err(storageError('read', error));
    }
  }

  list(capability: ArtifactCapability, url: string): ResultType<LocalArtifactEntry[], ArtifactError> {
    const resolved = this.resolve(capability, url);
    if (resolved.status === 'error') return resolved;
    const prefix = resolved.value.path ? `${resolved.value.path.replace(/\/$/u, '')}/` : '';
    const rows = this.database.orm.select().from(artifactEntries)
      .where(eq(artifactEntries.scopeId, resolved.value.scope.id))
      .orderBy(artifactEntries.path)
      .all()
      .filter((entry) => entry.path === resolved.value.path || entry.path.startsWith(prefix));
    return Result.ok(rows.map((entry) => this.toLocalEntry(resolved.value, entry)));
  }

  async commit(
    capability: ArtifactCapability,
    scopeUrl: string,
    expectedGeneration?: number,
  ): Promise<ResultType<ArtifactScope, ArtifactError>> {
    const resolved = this.resolve(capability, scopeUrl);
    if (resolved.status === 'error') return resolved;
    if (resolved.value.path) {
      return Result.err(new ArtifactAccessDenied({ url: scopeUrl, message: 'Commit target must be an artifact scope root' }));
    }
    if (!resolved.value.writable) {
      return Result.err(new ArtifactAccessDenied({ url: scopeUrl, message: 'Capability cannot commit this artifact scope' }));
    }
    const scope = resolved.value.scope;
    if (expectedGeneration !== undefined && resolved.value.scope.generation !== expectedGeneration) {
      return Result.err(new ArtifactConflict({
        scopeId: resolved.value.scope.id,
        message: `Expected artifact generation ${expectedGeneration}, received ${resolved.value.scope.generation}`,
      }));
    }
    if (!scope.dirty) return Result.ok(scope);
    const entries = this.database.orm.select().from(artifactEntries)
      .where(eq(artifactEntries.scopeId, scope.id)).orderBy(artifactEntries.path).all();
    const hashes = [...new Set(entries.map((entry) => entry.blobHash))];
    try {
      if (hashes.length > 0) {
        const blobs = this.database.orm.select().from(artifactBlobs).where(inArray(artifactBlobs.hash, hashes)).all();
        const byHash = new Map(blobs.map((blob) => [blob.hash, blob]));
        for (const hash of hashes) {
          const blob = byHash.get(hash);
          if (!blob) throw new Error(`Artifact blob ${hash} is missing from the local journal`);
          if (blob.state !== 'dirty') continue;
          const sealed = new Uint8Array(await readFile(this.sealedPath(hash)));
          await this.store.put(hash as `sha256:${string}`, sealed);
        }
      }
      const nextGeneration = scope.generation + 1;
      const manifest: ArtifactManifest = {
        version: 1,
        scopeId: scope.id,
        generation: nextGeneration,
        entries: entries.map((entry) => ({
          path: entry.path,
          blobHash: entry.blobHash,
          size: entry.size,
          mediaType: entry.mediaType,
        })),
      };
      const sealedManifest = await encryptArtifactBytes(
        new TextEncoder().encode(JSON.stringify(manifest)),
        await deriveArtifactScopeKey(this.projectKey, scope.id),
      );
      const manifestHash = await digest(sealedManifest);
      await this.store.put(manifestHash, sealedManifest);
      const now = new Date().toISOString();
      const committed = this.database.orm.transaction((tx) => {
        const changed = tx.update(artifactScopes).set({
          generation: nextGeneration,
          manifestHash,
          dirty: false,
          updatedAt: now,
        }).where(and(
          eq(artifactScopes.id, scope.id),
          eq(artifactScopes.generation, scope.generation),
        )).returning().get();
        if (!changed) return null;
        tx.update(artifactEntries).set({ generation: nextGeneration, updatedAt: now })
          .where(eq(artifactEntries.scopeId, scope.id)).run();
        if (hashes.length > 0) {
          tx.update(artifactBlobs).set({ state: 'cached', lastAccessedAt: now })
            .where(inArray(artifactBlobs.hash, hashes)).run();
        }
        return changed;
      });
      return committed
        ? Result.ok(committed)
        : Result.err(new ArtifactConflict({ scopeId: scope.id, message: 'Artifact scope changed before commit' }));
    } catch (error) {
      return Result.err(storageError('commit', error));
    }
  }

  async restoreScope(scope: ArtifactScope): Promise<ResultType<ArtifactScope, ArtifactError>> {
    try {
      if (!this.database.getSpace(scope.spaceId)) throw new Error(`Artifact space ${scope.spaceId} does not exist`);
      const entries = await this.scopeManifestEntries(scope);
      const now = new Date().toISOString();
      const restored = this.database.orm.transaction((tx) => {
        const current = tx.select().from(artifactScopes).where(eq(artifactScopes.spaceId, scope.spaceId)).get();
        if (current && (current.dirty || current.generation > scope.generation
          || (current.id !== scope.id && (current.generation !== 0 || current.manifestHash !== null))
          || (current.id === scope.id && current.generation === scope.generation && current.manifestHash !== scope.manifestHash))) {
          throw new ArtifactConflict({ scopeId: scope.id, message: 'Canonical artifact restore would overwrite divergent local state' });
        }
        const owner = tx.select().from(artifactScopes).where(eq(artifactScopes.id, scope.id)).get();
        if (owner && owner.spaceId !== scope.spaceId) {
          throw new ArtifactConflict({ scopeId: scope.id, message: 'Canonical artifact scope belongs to another space' });
        }
        if (current && current.id !== scope.id) {
          tx.delete(artifactScopes).where(eq(artifactScopes.id, current.id)).run();
        }
        tx.insert(artifactScopes).values(scope).onConflictDoUpdate({
          target: artifactScopes.id,
          set: { generation: scope.generation, manifestHash: scope.manifestHash, dirty: false, updatedAt: scope.updatedAt },
        }).run();
        tx.delete(artifactEntries).where(eq(artifactEntries.scopeId, scope.id)).run();
        for (const entry of entries) {
          tx.insert(artifactEntries).values({
            ...entry, scopeId: scope.id, generation: scope.generation, updatedAt: scope.updatedAt,
          }).run();
          tx.insert(artifactBlobs).values({
            hash: entry.blobHash, size: entry.size, cachePath: null, state: 'remote', lastAccessedAt: now, createdAt: now,
          }).onConflictDoNothing().run();
        }
        return tx.select().from(artifactScopes).where(eq(artifactScopes.id, scope.id)).get()!;
      });
      return Result.ok(restored);
    } catch (error) {
      return Result.err(error instanceof ArtifactConflict ? error : storageError('restore scope', error));
    }
  }

  async verifyScope(scope: ArtifactScope): Promise<ResultType<void, ArtifactError>> {
    try {
      const entries = await this.scopeManifestEntries(scope);
      for (const hash of new Set(entries.map((entry) => entry.blobHash))) {
        const sealed = await this.store.get(hash as `sha256:${string}`);
        if (!sealed) throw new Error(`Artifact blob ${hash} does not exist`);
        if (await digest(sealed) !== hash) throw new Error(`Artifact blob ${hash} failed content verification`);
      }
      return Result.ok(undefined);
    } catch (error) {
      return Result.err(storageError('verify scope', error));
    }
  }

  async materialize(
    capability: ArtifactCapability,
    url: string,
    destination: string,
    contentHashes?: Map<string, string>,
  ): Promise<ResultType<{ root: string; files: string[] }, ArtifactError>> {
    const listed = this.list(capability, url);
    if (listed.status === 'error') return listed;
    const rootPath = new URL(url).pathname.replace(/^\/+/, '').replace(/\/$/u, '');
    const files: string[] = [];
    for (const entry of listed.value) {
      const relative = rootPath && entry.path.startsWith(`${rootPath}/`)
        ? entry.path.slice(rootPath.length + 1)
        : entry.path;
      const target = join(destination, ...relative.split('/'));
      const bytes = await this.read(capability, entry.url);
      if (bytes.status === 'error') return bytes;
      await atomicWrite(target, bytes.value);
      if (contentHashes) contentHashes.set(relative, await digest(bytes.value));
      files.push(target);
    }
    return Result.ok({ root: destination, files });
  }

  async evictCachedBytes(): Promise<void> {
    await rm(this.cacheRoot, { recursive: true, force: true });
    await mkdir(this.cacheRoot, { recursive: true });
    this.database.orm.update(artifactBlobs).set({ cachePath: null, state: 'remote' }).run();
  }

  private resolve(capability: ArtifactCapability, url: string): ResultType<ResolvedArtifactPath, ArtifactError> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return Result.err(new ArtifactAccessDenied({ url, message: 'Artifact URL is invalid' }));
    }
    if (parsed.protocol !== 'local:') {
      return Result.err(new ArtifactAccessDenied({ url, message: 'Artifact URL must use local://' }));
    }
    let spaceId = capability.projectId;
    let kind: 'base' | 'workspace';
    let path = normalizedArtifactPath(parsed.pathname);
    if (path === null) return Result.err(new ArtifactAccessDenied({ url, message: 'Artifact path escapes its scope' }));
    if (parsed.hostname === 'base') {
      kind = 'base';
    } else if (parsed.hostname === 'workspace') {
      kind = 'workspace';
      spaceId = capability.kind === 'workspace' ? capability.workspaceId : capability.currentWorkspaceId ?? '';
      if (!spaceId) return Result.err(new ArtifactAccessDenied({ url, message: 'No current workspace is selected' }));
    } else if (parsed.hostname === 'workspaces') {
      if (capability.kind !== 'project') {
        return Result.err(new ArtifactAccessDenied({ url, message: 'Workspace capabilities cannot enumerate sibling workspaces' }));
      }
      const [candidate, ...rest] = path.split('/');
      if (!candidate) return Result.err(new ArtifactAccessDenied({ url, message: 'Workspace id is required' }));
      spaceId = candidate;
      path = rest.join('/');
      kind = 'workspace';
    } else {
      return Result.err(new ArtifactAccessDenied({ url, message: 'Artifact root must be base, workspace, or workspaces/<id>' }));
    }
    const space = this.database.getSpace(spaceId);
    if (!space || space.projectId !== capability.projectId || (kind === 'base' ? space.kind !== 'base' : space.kind !== 'worktree')) {
      return Result.err(new ArtifactNotFound({ url, message: 'Artifact scope does not exist' }));
    }
    const scope = this.database.orm.select().from(artifactScopes).where(eq(artifactScopes.spaceId, spaceId)).get();
    if (!scope) return Result.err(new ArtifactNotFound({ url, message: 'Artifact scope does not exist' }));
    const writable = kind === 'base'
      ? capability.kind === 'project'
      : capability.kind === 'workspace'
        ? spaceId === capability.workspaceId
        : spaceId === capability.currentWorkspaceId;
    const displayRoot = kind === 'base'
      ? 'local://base'
      : capability.kind === 'workspace' || spaceId === capability.currentWorkspaceId
        ? 'local://workspace'
        : `local://workspaces/${spaceId}`;
    return Result.ok({ scope, path, writable, displayRoot });
  }

  private toLocalEntry(resolved: ResolvedArtifactPath, entry: ArtifactEntry): LocalArtifactEntry {
    const space = this.database.getSpace(resolved.scope.spaceId);
    const isBase = space?.kind === 'base';
    return {
      url: `${resolved.displayRoot}/${entry.path}`,
      path: entry.path,
      size: entry.size,
      mediaType: entry.mediaType,
      hash: entry.blobHash,
      scope: isBase ? 'base' : 'workspace',
      workspaceId: isBase ? null : resolved.scope.spaceId,
    };
  }

  private cachePath(hash: string): string {
    return join(this.cacheRoot, 'plain', hash.slice('sha256:'.length));
  }

  private sealedPath(hash: string): string {
    return join(this.cacheRoot, 'sealed', hash.slice('sha256:'.length));
  }

  private touchBlob(hash: string): void {
    this.database.orm.update(artifactBlobs).set({ lastAccessedAt: new Date().toISOString() })
      .where(eq(artifactBlobs.hash, hash)).run();
  }

  private async scopeManifestEntries(scope: ArtifactScope): Promise<ArtifactManifest['entries']> {
    if (scope.dirty || !Number.isSafeInteger(scope.generation) || scope.generation < 0) {
      throw new Error('Canonical artifact scope must have a clean, nonnegative generation');
    }
    if (scope.manifestHash === null) {
      if (scope.generation !== 0) throw new Error('Committed artifact scope is missing its manifest hash');
      return [];
    }
    if (!HASH_PATTERN.test(scope.manifestHash)) throw new Error(`Invalid artifact manifest hash ${scope.manifestHash}`);
    const sealed = await this.store.get(scope.manifestHash as `sha256:${string}`);
    if (!sealed) throw new Error(`Artifact manifest ${scope.manifestHash} does not exist`);
    if (await digest(sealed) !== scope.manifestHash) throw new Error(`Artifact manifest ${scope.manifestHash} failed content verification`);
    const bytes = await decryptArtifactBytes(sealed, await deriveArtifactScopeKey(this.projectKey, scope.id));
    const manifest = artifactManifestSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
    if (manifest.scopeId !== scope.id || manifest.generation !== scope.generation) {
      throw new Error('Artifact manifest does not match its canonical scope and generation');
    }
    if (new Set(manifest.entries.map((entry) => entry.path)).size !== manifest.entries.length) {
      throw new Error('Artifact manifest contains duplicate paths');
    }
    return manifest.entries;
  }

}
