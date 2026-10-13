import type { ArtifactsRepositoryReader } from '@gitspace/runtime-workspace-do';

/**
 * Git objects are immutable, so values derived only from object ids never need invalidation. They are cached
 * per isolate in byte-bounded LRUs, and per data center through the Cache API for values that are cheap to store
 * but cost Artifacts reads or CPU to rebuild (trees, file patches, merge bases). Every key includes the
 * repository, so a hit never returns an object the caller's own repository could not have served.
 */

const MiB = 1024 * 1024;
/** Bump when a stored value's shape changes. */
const SHARED_CACHE = 'gitspace-git-objects-v1';
const SHARED_ORIGIN = 'https://git-objects.gitspace.invalid/v1/';
const IMMUTABLE = 'public, max-age=31536000, immutable';
/** Artifacts reads one request keeps in flight. */
const READ_CONCURRENCY = 8;
/** Cache API operations one request may spend, so caching never pushes a large diff past the subrequest cap. */
const SHARED_OPERATIONS = 2_000;

export type TreeEntries = readonly ArtifactsTreeEntry[];
/** One file's `git diff` section and the content bytes each side compared, so a cached patch costs the same read budget. */
export interface CachedPatch {
  patch: string;
  additions: number | null;
  deletions: number | null;
  binary: boolean;
  sizes: [number | null, number | null];
}

/** Least-recently-used entries leave once the estimated retained bytes exceed the budget. */
class ByteLru<V> {
  private readonly entries = new Map<string, { value: V; bytes: number }>();
  private used = 0;
  constructor(private readonly budget: number, readonly maxEntry: number) {}

  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V, bytes: number): void {
    if (bytes > this.maxEntry) return;
    const previous = this.entries.get(key);
    if (previous) {
      this.entries.delete(key);
      this.used -= previous.bytes;
    }
    this.entries.set(key, { value, bytes });
    this.used += bytes;
    for (const [oldest, entry] of this.entries) {
      if (this.used <= this.budget) break;
      this.entries.delete(oldest);
      this.used -= entry.bytes;
    }
  }
}

// About 14 MiB per isolate in total, well inside a 128 MB isolate that also serves 8 MiB reads.
const trees = new ByteLru<TreeEntries>(4 * MiB, MiB);
const blobs = new ByteLru<Uint8Array>(6 * MiB, MiB);
const patches = new ByteLru<CachedPatch>(4 * MiB, MiB);
const ids = new ByteLru<string>(256 * 1024, 1024);

const treeBytes = (entries: TreeEntries) => entries.reduce((total, entry) => total + 2 * entry.name.length + 200, 64);
const idBytes = (id: string) => 2 * id.length + 160;

class Gate {
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  constructor(private readonly limit: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active < this.limit) this.active++;
    else await new Promise<void>(resolve => this.waiting.push(resolve));
    try { return await task(); }
    finally {
      // A finishing task hands its slot straight to the next waiter.
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}

/** One request's reads of one repository: a single Artifacts handle, objects shared through the caches. */
export class GitObjects {
  private readonly pendingTrees = new Map<string, Promise<TreeEntries>>();
  private readonly gate = new Gate(READ_CONCURRENCY);
  private readonly writes: Promise<unknown>[] = [];
  private shared: Promise<Cache | null> | null = null;
  private sharedOperations = 0;

  constructor(private readonly reader: ArtifactsRepositoryReader, readonly repository: string) {}

  /** A tree's immediate entries; concurrent requests for one tree share a read. */
  tree(oid: string): Promise<TreeEntries> {
    let pending = this.pendingTrees.get(oid);
    if (!pending) {
      pending = this.remember(trees, 'tree', oid, treeBytes, async () => {
        const entries = await this.gate.run(() => this.reader.readTree(oid));
        if (!entries) throw new Error(`Missing snapshot tree ${oid}`);
        return entries;
      });
      this.pendingTrees.set(oid, pending);
    }
    return pending;
  }

  async commitTree(commit: string): Promise<string> {
    const key = `${this.repository}:commit:${commit}`;
    const known = ids.get(key);
    if (known !== undefined) return known;
    const metadata = await this.gate.run(() => this.reader.readCommit(commit));
    if (!metadata) throw new Error(`Committed source ${commit} is missing from the cloud repository`);
    ids.set(key, metadata.treeHash, idBytes(key));
    return metadata.treeHash;
  }

  /** Raw blob bytes. `admit` sees the size before any content is materialized and throws to refuse it. */
  async blob(oid: string, admit: (size: number) => void): Promise<Uint8Array | null> {
    const key = `${this.repository}:blob:${oid}`;
    const cached = blobs.get(key);
    if (cached) {
      admit(cached.byteLength);
      return cached;
    }
    const blob = await this.gate.run(() => this.reader.readBlob(oid));
    if (!blob) return null;
    admit(blob.size);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    blobs.set(key, bytes, bytes.byteLength + 64);
    return bytes;
  }

  /** A file patch keyed by both sides' blob ids, modes and path; `cached` reports whether `compute` was skipped. */
  async patch(key: string, compute: () => Promise<CachedPatch>): Promise<{ value: CachedPatch; cached: boolean }> {
    let cached = true;
    const value = await this.remember(patches, 'patch', key, patch => 2 * patch.patch.length + 128, () => {
      cached = false;
      return compute();
    });
    return { value, cached };
  }

  /** The merge base of two commits, which their ids alone determine. */
  mergeBase(head: string, tip: string, compute: () => Promise<string>): Promise<string> {
    return this.remember(ids, 'merge-base', `${head}:${tip}`, idBytes, compute);
  }

  /** History reads for `compareCloudHistory` through this request's handle. */
  history() {
    return {
      readCommit: (_repository: string, commit: string) => this.reader.readCommit(commit),
      log: (_repository: string, commit: string, limit = 50) => this.reader.log(commit, limit),
    };
  }

  /** Waits for cache writes, then releases the repository handle. */
  async close(): Promise<void> {
    await Promise.allSettled(this.writes);
    await this.reader.close();
  }

  private async remember<V>(memory: ByteLru<V>, kind: string, id: string, size: (value: V) => number, compute: () => Promise<V>): Promise<V> {
    const key = `${this.repository}:${kind}:${id}`;
    const known = memory.get(key);
    if (known !== undefined) return known;
    const cache = this.sharedOperations + 2 <= SHARED_OPERATIONS ? await this.sharedCache() : null;
    const url = cache ? `${SHARED_ORIGIN}${kind}/${await sha256(key)}` : null;
    if (cache && url) {
      this.sharedOperations++;
      const stored = await cache.match(url).then(response => response?.json<V>()).catch(() => undefined);
      if (stored !== undefined && stored !== null) {
        memory.set(key, stored, size(stored));
        return stored;
      }
    }
    const value = await compute();
    const bytes = size(value);
    memory.set(key, value, bytes);
    if (cache && url && bytes <= memory.maxEntry) {
      this.sharedOperations++;
      this.writes.push(cache.put(url, new Response(JSON.stringify(value), { headers: { 'cache-control': IMMUTABLE, 'content-type': 'application/json' } })).catch(() => undefined));
    }
    return value;
  }

  /** Opened per request: Cache objects are I/O bound to the request that opened them. */
  private sharedCache(): Promise<Cache | null> {
    this.shared ??= typeof caches === 'undefined' ? Promise.resolve(null) : Promise.resolve().then(() => caches.open(SHARED_CACHE)).catch(() => null);
    return this.shared;
  }
}

async function sha256(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
}
