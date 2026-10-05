import { parseGitLfsPointer, type GitLfsObject } from '@gitspace/protocol-workspace';
type CanonicalRepository = Pick<ArtifactsRepo, 'info' | 'createToken' | 'revokeToken' | 'readCommit' | 'readTree' | 'readBlob'> & { [Symbol.dispose]?(): void };

/** Discover heads/tags through Git transport, then walk immutable commit IDs via the binding. */
export async function canonicalLfsObjects(binding: { get(name: string): Promise<CanonicalRepository> }, repositories: readonly string[], fetcher: typeof fetch = fetch): Promise<GitLfsObject[]> {
  const objects = new Map<string, GitLfsObject>();
  for (const name of repositories) {
    const repo = await binding.get(name);
    try {
      const remote = new URL((await repo.info()).remote);
      if (remote.protocol !== 'https:' || remote.username || remote.password || remote.search || remote.hash) throw new Error('Invalid canonical Git remote');
      const token = await repo.createToken('read', 60);
      let refs: Map<string, string>;
      try {
        const response = await fetcher(`${remote.href.replace(/\/$/u, '')}/info/refs?service=git-upload-pack`, { redirect: 'error', signal: AbortSignal.timeout(30_000), headers: { Authorization: `Bearer ${token.plaintext}`, Accept: 'application/x-git-upload-pack-advertisement' } });
        if (!response.ok) throw new Error('Canonical Git discovery unavailable');
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.length > 16 * 1024 * 1024) throw new Error('Canonical Git advertisement too large');
        refs = parseCanonicalRefs(bytes);
      } finally { if (!await repo.revokeToken(token.id)) throw new Error('Canonical Git token revocation failed'); }
      const pending = [...refs].filter(([ref]) => !ref.endsWith('^{}')).map(([ref, oid]) => refs.get(`${ref}^{}`) ?? oid);
      const commits = new Set<string>(); const trees = new Set<string>(); const blobs = new Set<string>();
      while (pending.length) {
        const oid = pending.pop()!;
        if (commits.has(oid)) continue;
        commits.add(oid);
        const commit = await repo.readCommit(oid);
        if (!commit) throw new Error('Canonical branch/tag commit unavailable');
        pending.push(...commit.parents);
        const pendingTrees = [commit.treeHash];
        while (pendingTrees.length) {
          const tree = pendingTrees.pop()!;
          if (trees.has(tree)) continue;
          trees.add(tree);
          const entries = await repo.readTree(tree);
          if (!entries) throw new Error('Canonical Git tree unavailable');
          for (const entry of entries) {
            if (entry.type === 'tree') { pendingTrees.push(entry.hash); continue; }
            if (entry.type === 'gitlink' || blobs.has(entry.hash)) continue;
            blobs.add(entry.hash);
            const blob = await repo.readBlob(entry.hash);
            if (!blob) throw new Error('Canonical Git blob unavailable');
            if (blob.size > 1024) continue;
            const object = parseGitLfsPointer(new Uint8Array(await blob.arrayBuffer()));
            if (object) {
              const previous = objects.get(object.oid);
              if (previous && previous.size !== object.size) throw new Error('Canonical LFS identity conflict');
              objects.set(object.oid, object);
            }
          }
        }
      }
    } finally { repo[Symbol.dispose]?.(); }
  }
  return [...objects.values()];
}

export function parseCanonicalRefs(bytes: Uint8Array): Map<string, string> {
  const decoder = new TextDecoder('utf-8', { fatal: true }); const refs = new Map<string, string>(); let service = false;
  for (let offset = 0; offset < bytes.length;) {
    const prefix = decoder.decode(bytes.subarray(offset, offset + 4));
    if (!/^[0-9a-f]{4}$/u.test(prefix)) throw new Error('Invalid Git discovery packet');
    const size = Number.parseInt(prefix, 16); offset += 4;
    if (size === 0) continue;
    if (size < 4 || offset + size - 4 > bytes.length) throw new Error('Truncated Git discovery');
    const line = decoder.decode(bytes.subarray(offset, offset + size - 4)); offset += size - 4;
    if (line === '# service=git-upload-pack\n') { service = true; continue; }
    const ref = /^([0-9a-f]{40}) ([^\0\n]+)(?:\0[^\n]*)?\n?$/u.exec(line);
    if (!ref) throw new Error('Invalid Git discovery advertisement');
    if (ref[2]!.startsWith('refs/heads/') || ref[2]!.startsWith('refs/tags/')) refs.set(ref[2]!, ref[1]!);
  }
  if (!service) throw new Error('Missing Git discovery service');
  return refs;
}
