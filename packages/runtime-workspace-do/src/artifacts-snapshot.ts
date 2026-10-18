import git from 'isomorphic-git';
import { Volume, createFsFromVolume } from 'memfs';
import { Result, TaggedError } from 'better-result';
import { RuntimeGitCheckpointSchema } from '@gitspace/protocol-runtime/workspace-controls';
import { z } from 'zod';
import { hasSnapshotConflictMarkers, isCleanSnapshotContent, isSnapshotTextEntry, readSnapshotText } from './artifacts-merge.js';
import { collectBytes, streamBytes } from '@gitspace/protocol-workspace';

export type RuntimeGitCheckpoint = z.infer<typeof RuntimeGitCheckpointSchema>;
export type SnapshotMutation = { path: string; content: Uint8Array | null; mode?: string; oid?: string; type?: 'blob' | 'commit' };
export type WriteSnapshotInput = { repository: string; workspaceId: string; previous: RuntimeGitCheckpoint; mutations: SnapshotMutation[]; /** Edit-history message for the tool change; absent for merges and system snapshots. */ message?: string; signal?: AbortSignal; machine?: RuntimeGitCheckpoint; indexMutations?: SnapshotMutation[]; trackedMutations?: SnapshotMutation[]; conflicts?: string[]; forcePublication?: boolean; /** The result's trees, already in the repository: a machine
 * publication onto an unchanged cloud adopts the machine's trees instead of rebuilding them from mutations. */ adopt?: { worktreeTree: string; indexTree: string; trackedTree: string } };
export interface ArtifactsFetch { (input: string, init?: RequestInit): Promise<Response> }
export class ArtifactsSnapshotError extends TaggedError('ArtifactsSnapshotError')<{ operation: string; message: string; certainty: 'not-published' | 'unknown' }> {}
/** Credentials for Git over HTTPS: Artifacts takes a bearer token; GitHub takes an installation token as Basic
 * `x-access-token:<token>`. Null reads a public remote. */
export type GitHttpAuth = { kind: 'bearer'; token: string } | { kind: 'basic'; username: string; password: string };

/** An origin refused ref discovery; 401/403/404 from a credential-free request mean it needs credentials GitSpace does not hold. */
export class GitDiscoveryError extends Error {
  constructor(readonly status: number) { super(`Git discovery failed (${status})`); }
  get needsCredentials(): boolean { return this.status === 401 || this.status === 403 || this.status === 404; }
}

/** Credentials travel only in headers, on every request of a transfer; never in the remote URL, which must be a
 * plain HTTPS repository root. */
function gitRemote(url: string): URL {
  const remote = new URL(url);
  if (remote.protocol !== 'https:' || remote.username || remote.password || remote.search || remote.hash) throw new Error('Invalid Artifacts Git remote');
  return remote;
}
/** The request headers carrying Git HTTP credentials; none for a public remote. */
export function gitAuthorizationHeaders(auth: GitHttpAuth | null): Record<string, string> {
  if (auth === null) return {};
  if (auth.kind === 'bearer') return { Authorization: `Bearer ${auth.token}` };
  // RFC 7617: the user-pass is UTF-8 octets; btoa encodes one octet per character.
  return { Authorization: `Basic ${btoa(String.fromCharCode(...encoder.encode(`${auth.username}:${auth.password}`)))}` };
}

export function validateSnapshotPath(path: string): void {
  if (!path || path.length > 4096 || path.split('/').length > 128 || path.includes('\\') || path.includes('\0') || path.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')) throw new Error('Invalid repository-relative path');
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const zero = '0'.repeat(40);
function packet(text: string): Uint8Array {
  const bytes = encoder.encode(text);
  return encoder.encode((bytes.length + 4).toString(16).padStart(4, '0') + text);
}
function packets(bytes: Uint8Array): string[] {
  const result: string[] = [];
  for (let offset = 0; offset < bytes.length;) {
    const prefix = decoder.decode(bytes.subarray(offset, offset + 4));
    if (!/^[0-9a-f]{4}$/u.test(prefix)) throw new Error('Invalid Git packet header');
    const size = Number.parseInt(prefix, 16);
    offset += 4;
    if (size <= 2) continue;
    if (size < 4 || offset + size - 4 > bytes.length) throw new Error('Truncated Git packet');
    result.push(decoder.decode(bytes.subarray(offset, offset + size - 4)));
    offset += size - 4;
  }
  return result;
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  return bytes;
}

/** Only newly written objects are packed. Existing objects remain on the server. A streamed pack (a transfer from
 * another repository) is sent as it arrives, never held. */
export async function publishSnapshotPack(input: { remote: string; auth: GitHttpAuth; ref: string; previous: string; commit: string; pack: Uint8Array | ReadableStream<Uint8Array>; shallow?: readonly string[]; signal?: AbortSignal; onPublicationState?: (certainty: ArtifactsSnapshotError['certainty']) => void }, request: ArtifactsFetch = fetch): Promise<void> {
  const remote = gitRemote(input.remote);
  const headers = gitAuthorizationHeaders(input.auth);
  const base = remote.href.replace(/\/$/u, '');
  const advertised = await request(`${base}/info/refs?service=git-receive-pack`, { headers, signal: input.signal, redirect: 'manual' });
  if (!advertised.ok) throw new Error(`Git discovery failed (${advertised.status})`);
  let old = zero;
  let capabilities: string[] = [];
  for (const line of packets(new Uint8Array(await advertised.arrayBuffer()))) {
    if (line.startsWith('#')) continue;
    const [reference = '', caps] = line.trimEnd().split('\0');
    if (caps !== undefined) capabilities = caps.split(' ');
    const [oid, ref] = reference.split(' ');
    if (ref === input.ref && oid && /^[0-9a-f]{40}$/u.test(oid)) old = oid;
  }
  if (old === input.commit) { input.onPublicationState?.('unknown'); return; }
  if (old !== zero && old !== input.previous) throw new Error('Snapshot conflict: checkpoint ref has advanced');
  if (!capabilities.includes('report-status')) throw new Error('Git server does not support report-status');
  const shallow = [...new Set(input.shallow)];
  if (shallow.some(oid => !/^[0-9a-f]{40}$/u.test(oid))) throw new Error('Invalid Git shallow boundary');
  const commands = concatBytes([...shallow.map(oid => packet(`shallow ${oid}\n`)), packet(`${old} ${input.commit} ${input.ref}\0report-status\n`), encoder.encode('0000')]);
  const body = input.pack instanceof Uint8Array
    ? concatBytes([commands, input.pack])
    : input.pack.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ start(controller) { controller.enqueue(commands); } }));
  input.signal?.throwIfAborted();
  input.onPublicationState?.('unknown');
  const response = await request(`${base}/git-receive-pack`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/x-git-receive-pack-request', Accept: 'application/x-git-receive-pack-result' }, body, signal: input.signal, redirect: 'manual' });
  if (!response.ok) throw new Error(`Git push failed (${response.status})`);
  const status = packets(new Uint8Array(await response.arrayBuffer())).map(line => line.trimEnd());
  if (status.some(line => line.startsWith(`ng ${input.ref} `)) && !status.includes(`ok ${input.ref}`)) input.onPublicationState?.('not-published');
  if (!status.includes('unpack ok') || !status.includes(`ok ${input.ref}`)) throw new Error(`Git push rejected: ${status.join('; ')}`);
}

/** A ref update whose commit the repository already holds sends a pack with no objects. */
export async function publishRef(input: { remote: string; auth: GitHttpAuth; ref: string; previous: string | null; commit: string }, request: ArtifactsFetch = fetch): Promise<void> {
  const header = new Uint8Array([...encoder.encode('PACK'), 0, 0, 0, 2, 0, 0, 0, 0]);
  const pack = new Uint8Array(header.length + 20);
  pack.set(header); pack.set(new Uint8Array(await crypto.subtle.digest('SHA-1', header)), header.length);
  await publishSnapshotPack({ remote: input.remote, auth: input.auth, ref: input.ref, previous: input.previous ?? zero, commit: input.commit, pack }, request);
}

/** Advertised refs, optionally narrowed by protocol v2 ls-refs; peeled tags use `<tag>^{}`. */
export async function readAdvertisedRefs(input: { remote: string; auth: GitHttpAuth | null; refPrefix?: string }, request: ArtifactsFetch = fetch): Promise<Map<string, string>> {
  return (await readGitAdvertisement(input, request)).refs;
}

/** The v0 advertisement carries the repository's shallow boundaries, including those outside HEAD. */
export async function readShallowCommits(input: { remote: string; auth: GitHttpAuth | null }, request: ArtifactsFetch = fetch): Promise<string[]> {
  return (await readGitAdvertisement(input, request)).shallow;
}

async function readGitDiscovery(remote: URL, headers: Record<string, string>, request: ArtifactsFetch) {
  const signal = AbortSignal.timeout(15_000);
  const advertised = await request(`${remote.href.replace(/\/$/u, '')}/info/refs?service=git-upload-pack`, { headers, signal, redirect: 'manual' });
  if (!advertised.ok) throw new GitDiscoveryError(advertised.status);
  if (!advertised.body) throw new Error('Git discovery returned no advertisement');
  return packets(await collectBytes(streamBytes(advertised.body, signal), 64 * 1024)).filter(line => !line.startsWith('#'));
}

async function readGitAdvertisement(input: { remote: string; auth: GitHttpAuth | null; refPrefix?: string }, request: ArtifactsFetch) {
  const remote = gitRemote(input.remote);
  if (input.refPrefix !== undefined && (!input.refPrefix || /[\0\r\n]/u.test(input.refPrefix))) throw new Error('Invalid Git ref prefix');
  const base = remote.href.replace(/\/$/u, '');
  const headers = gitAuthorizationHeaders(input.auth);
  if (input.refPrefix !== undefined) headers['Git-Protocol'] = 'version=2';
  const signal = AbortSignal.timeout(15_000);
  let lines = await readGitDiscovery(remote, headers, request);
  const version2 = lines[0]?.trimEnd() === 'version 2';
  if (version2) {
    if (!lines.some(line => line.trimEnd().split('=')[0] === 'ls-refs')) throw new Error('Git server does not support ls-refs');
    const parts = [packet('command=ls-refs\n'), encoder.encode('0001'), packet('peel\n')];
    if (input.refPrefix !== undefined) parts.push(packet(`ref-prefix ${input.refPrefix}\n`));
    parts.push(encoder.encode('0000'));
    const response = await request(`${base}/git-upload-pack`, {
      method: 'POST', headers: { ...headers, 'Git-Protocol': 'version=2', 'Content-Type': 'application/x-git-upload-pack-request', Accept: 'application/x-git-upload-pack-result' },
      body: concatBytes(parts), signal, redirect: 'manual',
    });
    if (!response.ok) throw new GitDiscoveryError(response.status);
    if (!response.body) throw new Error('Git discovery returned no advertisement');
    lines = packets(await collectBytes(streamBytes(response.body, signal), 64 * 1024));
  }
  // A v0-only origin returns its advertisement directly. It must fit the same bound;
  // neither a refused v2 negotiation nor an oversized response triggers an unbounded retry.
  const refs = new Map<string, string>();
  const shallow: string[] = [];
  for (const line of lines) {
    const boundary = /^shallow ([0-9a-f]{40})\n?$/u.exec(line);
    if (boundary) { shallow.push(boundary[1]!); continue; }
    const [oid, ref, ...attributes] = (line.trimEnd().split('\0')[0] ?? '').split(' ');
    if (!oid || !ref || !/^[0-9a-f]{40}$/u.test(oid) || (input.refPrefix !== undefined && !ref.startsWith(input.refPrefix))) continue;
    refs.set(ref, oid);
    if (version2) {
      const peeled = attributes.find(attribute => attribute.startsWith('peeled:'))?.slice('peeled:'.length);
      if (peeled && /^[0-9a-f]{40}$/u.test(peeled)) refs.set(`${ref}^{}`, peeled);
    }
  }
  return { refs, shallow };
}

const PACK_SIGNATURE = encoder.encode('PACK');

/** A response body read packet by packet as it arrives, buffering only what the next packet needs. */
class PacketReader {
  private buffered: Uint8Array = new Uint8Array(0);
  constructor(private readonly chunks: AsyncGenerator<Uint8Array>) {}

  /** The next `size` bytes without consuming them, or null when the body ends first. */
  async peek(size: number): Promise<Uint8Array | null> {
    while (this.buffered.length < size) {
      const next = await this.chunks.next();
      if (next.done) return null;
      this.buffered = this.buffered.length ? concatBytes([this.buffered, next.value]) : next.value;
    }
    return this.buffered.subarray(0, size);
  }

  /** The next packet's declared length (0 flush, 1 delimiter, 2 response end) and its payload. */
  async packet(): Promise<{ size: number; payload: Uint8Array }> {
    const prefix = await this.peek(4);
    if (prefix === null || !/^[0-9a-f]{4}$/u.test(decoder.decode(prefix))) throw new Error('Git fetch did not return a complete pack');
    const size = Number.parseInt(decoder.decode(prefix), 16);
    if (size === 3) throw new Error('Git fetch did not return a complete pack');
    const end = Math.max(size, 4);
    if (await this.peek(end) === null) throw new Error('Git fetch did not return a complete pack');
    const payload = this.buffered.subarray(4, end);
    this.buffered = this.buffered.subarray(end);
    return { size, payload };
  }

  /** Buffered bytes, then the body's chunks as they arrive; null at its end. A v0 pack is not packetized. */
  async raw(): Promise<Uint8Array | null> {
    if (this.buffered.length) {
      const chunk = this.buffered;
      this.buffered = new Uint8Array(0);
      return chunk;
    }
    const next = await this.chunks.next();
    return next.done ? null : next.value;
  }
}

/** v2 carries shallow-info separately and always sidebands its packfile. We send done,
 * so acknowledgments are omitted; no URI, wanted-ref, or sideband-all section was requested. */
async function readVersion2Preamble(reader: PacketReader, boundaries: Set<string>): Promise<void> {
  let section: 'header' | 'shallow-info' = 'header';
  for (;;) {
    const { size, payload } = await reader.packet();
    if (size === 1 && section === 'shallow-info') { section = 'header'; continue; }
    if (size < 5) throw new Error('Incomplete Git v2 fetch response');
    const line = decoder.decode(payload);
    if (section === 'shallow-info') {
      const boundary = /^(shallow|unshallow) ([0-9a-f]{40})\n?$/u.exec(line);
      if (!boundary) throw new Error('Invalid Git shallow-info');
      if (boundary[1] === 'shallow') boundaries.add(boundary[2]!);
      else if (!boundaries.delete(boundary[2]!)) throw new Error('Unexpected Git unshallow boundary');
      continue;
    }
    if (line === 'packfile\n') return;
    if (line !== 'shallow-info\n') throw new Error('Unexpected Git v2 fetch section');
    section = 'shallow-info';
  }
}

/** No side-band or multi_ack: only shallow metadata, its flush, and plain ACK/NAK packets can precede the raw pack. */
async function readVersion0Preamble(reader: PacketReader, boundaries: Set<string>, haves: Set<string>): Promise<void> {
  let acknowledgments = 0;
  for (;;) {
    const next = await reader.peek(4);
    if (next !== null && PACK_SIGNATURE.every((byte, index) => next[index] === byte)) break;
    const { size, payload } = await reader.packet();
    if (size === 0) continue;
    if (size < 8 || size > 55) throw new Error('Git fetch did not return a complete pack');
    const line = decoder.decode(payload);
    const boundary = /^(shallow|unshallow) ([0-9a-f]{40})\n?$/u.exec(line);
    if (boundary) {
      if (boundary[1] === 'shallow') boundaries.add(boundary[2]!);
      else boundaries.delete(boundary[2]!);
    } else if (++acknowledgments > haves.size + 1 || (line !== 'NAK\n' && (!/^ACK [0-9a-f]{40}\n$/u.test(line) || !haves.has(line.slice(4, -1))))) {
      throw new Error('Git fetch did not return a complete pack');
    }
  }
  if (acknowledgments === 0) throw new Error('Git fetch did not return a complete pack');
}

/** The pack bytes alone, demultiplexed from the v2 sideband or passed through from v0, as they arrive. A pack that
 * does not start with its signature or ends before its header fails the stream, and with it any push reading it. */
function packStream(reader: PacketReader, chunks: AsyncGenerator<Uint8Array>, version2: boolean): ReadableStream<Uint8Array> {
  let received = 0;
  const next = async (): Promise<Uint8Array | null> => {
    if (!version2) return reader.raw();
    for (;;) {
      const { size, payload } = await reader.packet();
      if (size === 0) {
        // The flush ends the packfile section; only a response-end packet may follow it.
        if (await reader.peek(1) !== null && ((await reader.packet()).size !== 2 || await reader.peek(1) !== null)) throw new Error('Incomplete Git v2 fetch response');
        return null;
      }
      if (size < 5) throw new Error('Incomplete Git v2 fetch response');
      if (payload[0] === 1) return payload.subarray(1);
      if (payload[0] === 3) throw new Error(`Git fetch failed: ${decoder.decode(payload.subarray(1))}`);
      if (payload[0] !== 2) throw new Error('Invalid Git pack sideband');
    }
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        for (;;) {
          const chunk = await next();
          if (chunk === null) {
            if (received < 12) throw new Error('Git fetch did not return a complete pack');
            controller.close();
            return;
          }
          for (let index = 0; received + index < PACK_SIGNATURE.length && index < chunk.length; index++) {
            if (chunk[index] !== PACK_SIGNATURE[received + index]) throw new Error('Git fetch did not return a complete pack');
          }
          received += chunk.length;
          if (!chunk.length) continue;
          controller.enqueue(chunk);
          return;
        }
      } catch (error) {
        await chunks.return(undefined);
        throw error;
      }
    },
    async cancel() { await chunks.return(undefined); },
  });
}

/** Requests the reachable graph of `commit` without thin packs. Destination shallow boundaries qualify its haves; the
 * source's shallow boundaries precede its pack, so they are known before the first pack byte is forwarded. */
async function openCommitPack(input: { remote: string; auth: GitHttpAuth | null; commit: string; haves: readonly string[]; shallow: readonly string[]; signal: AbortSignal }, request: ArtifactsFetch): Promise<{ shallow: string[]; pack: ReadableStream<Uint8Array> }> {
  const remote = gitRemote(input.remote);
  if (!/^[0-9a-f]{40}$/u.test(input.commit)) throw new Error('Invalid Git commit');
  const haves = new Set(input.haves);
  const shallow = new Set(input.shallow);
  if (haves.size > 32 || [...haves, ...shallow].some(oid => !/^[0-9a-f]{40}$/u.test(oid))) throw new Error('Invalid Git negotiation commits');
  const discovery = await readGitDiscovery(remote, { ...gitAuthorizationHeaders(input.auth), 'Git-Protocol': 'version=2' }, request);
  const version2 = discovery[0]?.trimEnd() === 'version 2';
  const boundaries = new Set(shallow);
  if (version2) {
    const capability = discovery.find(line => line.trimEnd().split('=')[0] === 'fetch');
    if (!capability) throw new Error('Git server does not support fetch');
    const features = capability.trimEnd().split('=')[1]?.split(' ') ?? [];
    if (shallow.size && !features.includes('shallow')) throw new Error('Git server does not support shallow fetch');
  } else {
    // A v0-only origin must fit the existing discovery bound; never retry unbounded.
    for (const line of discovery) {
      const boundary = /^shallow ([0-9a-f]{40})\n?$/u.exec(line);
      if (boundary) boundaries.add(boundary[1]!);
    }
  }
  const parts = version2
    ? [packet('command=fetch\n'), encoder.encode('0001'), packet('no-progress\n'), packet(`want ${input.commit}\n`), ...[...shallow].map(oid => packet(`shallow ${oid}\n`)), ...[...haves].map(oid => packet(`have ${oid}\n`)), packet('done\n'), encoder.encode('0000')]
    : [packet(`want ${input.commit}${boundaries.size ? ' shallow' : ''}\n`), ...[...shallow].map(oid => packet(`shallow ${oid}\n`)), encoder.encode('0000'), ...[...haves].map(oid => packet(`have ${oid}\n`)), packet('done\n')];
  const response = await request(`${remote.href.replace(/\/$/u, '')}/git-upload-pack`, {
    method: 'POST', headers: { ...gitAuthorizationHeaders(input.auth), ...(version2 ? { 'Git-Protocol': 'version=2' } : {}), 'Content-Type': 'application/x-git-upload-pack-request', Accept: 'application/x-git-upload-pack-result' },
    body: concatBytes(parts), signal: input.signal, redirect: 'manual',
  });
  if (!response.ok) throw new Error(`Git fetch failed (${response.status})`);
  if (!response.body) throw new Error('Git fetch returned no pack');
  const chunks = streamBytes(response.body, input.signal);
  const reader = new PacketReader(chunks);
  try {
    if (version2) await readVersion2Preamble(reader, boundaries);
    else await readVersion0Preamble(reader, boundaries, haves);
  } catch (error) {
    await chunks.return(undefined);
    throw error;
  }
  return { shallow: [...boundaries], pack: packStream(reader, chunks, version2) };
}

/** Wall time for one streamed transfer: no pack is held, so a repository's size bounds only how long it takes. */
const TRANSFER_TIMEOUT_MS = 10 * 60_000;

/** Copies the graph of `commit` into a destination ref, streaming the source's upload-pack response straight into the
 * destination's receive-pack request: no pack is held in memory, so a history larger than a Worker's memory still
 * transfers. The ref moves only from `previous` (null: absent). Source shallow boundaries travel with the pack so a
 * copy never invents complete ancestry. No credentials follow redirects, and an interrupted download fails the push
 * (receive-pack verifies the pack before moving the ref), so it has no destination-side effect. */
export async function transferCommit(input: { source: { remote: string; auth: GitHttpAuth | null }; destination: { remote: string; auth: GitHttpAuth }; ref: string; previous: string | null; commit: string; haves?: readonly string[]; shallow?: readonly string[] }, request: ArtifactsFetch = fetch): Promise<void> {
  const signal = AbortSignal.timeout(TRANSFER_TIMEOUT_MS);
  const opened = await openCommitPack({ ...input.source, commit: input.commit, haves: input.haves ?? [], shallow: input.shallow ?? [], signal }, request);
  try {
    await publishSnapshotPack({ ...input.destination, ref: input.ref, previous: input.previous ?? zero, commit: input.commit, pack: opened.pack, shallow: opened.shallow, signal }, request);
  } finally {
    // A push that never read the pack (its ref already held the commit, or discovery failed) releases the source.
    await opened.pack.cancel().catch(() => undefined);
  }
}

/** Deterministic root objects make interrupted initialization safely replayable. */
export async function initializeArtifactsRepository(repo: Pick<ArtifactsRepo, 'info' | 'createToken' | 'revokeToken'>, input: { branch: string; workspaceId?: string }, request: ArtifactsFetch = fetch) {
  const fs = createFsFromVolume(new Volume());
  const dir = '/initial';
  await git.init({ fs, dir, defaultBranch: input.branch });
  const tree = await git.writeTree({ fs, dir, tree: [] });
  const identity = { name: 'GitSpace', email: 'checkpoint@gitspace.invalid', timestamp: 0, timezoneOffset: 0 };
  const unborn = input.workspaceId !== undefined;
  const indexCommit = await git.writeCommit({ fs, dir, commit: { tree, parent: [], author: identity, committer: identity, message: unborn ? 'GitSpace unborn index snapshot\n' : 'Initialize project\n' } });
  const trackedWorktreeCommit = unborn ? await git.writeCommit({ fs, dir, commit: { tree, parent: [indexCommit], author: identity, committer: identity, message: 'GitSpace unborn tracked worktree snapshot\n' } }) : indexCommit;
  const worktreeCommit = unborn ? await git.writeCommit({ fs, dir, commit: { tree, parent: [trackedWorktreeCommit], author: identity, committer: identity, message: 'GitSpace unborn worktree snapshot\n' } }) : indexCommit;
  const checkpointRef = unborn ? `refs/gitspace/spaces/${input.workspaceId}/checkpoints` : `refs/heads/${input.branch}`;
  const packed = await git.packObjects({ fs, dir, oids: [...new Set([tree, indexCommit, trackedWorktreeCommit, worktreeCommit])] });
  if (!packed.packfile) throw new Error('Git pack writer returned no pack');
  const info = await repo.info();
  const token = await repo.createToken('write', 60);
  try { await publishSnapshotPack({ remote: info.remote, auth: { kind: 'bearer', token: token.plaintext }, ref: checkpointRef, previous: zero, commit: worktreeCommit, pack: packed.packfile }, request); }
  finally { await repo.revokeToken(token.id); }
  return { indexCommit, trackedWorktreeCommit, worktreeCommit, tree };
}

export async function writeArtifactsSnapshot(repo: Pick<ArtifactsRepo, 'readCommit' | 'readTree' | 'readBlob' | 'info' | 'createToken' | 'revokeToken'>, input: WriteSnapshotInput, request: ArtifactsFetch = fetch): Promise<Result<RuntimeGitCheckpoint, ArtifactsSnapshotError>> {
  let certainty: ArtifactsSnapshotError['certainty'] = 'not-published';
  return Result.tryPromise({ try: async () => {
    input.signal?.throwIfAborted();
    const previous = RuntimeGitCheckpointSchema.parse(input.previous);
    if (!/^[A-Za-z0-9_-]+$/u.test(input.workspaceId)) throw new Error('Invalid workspace ID');
    const mutations = input.mutations;
    for (const layer of [mutations, input.indexMutations ?? [], input.trackedMutations ?? []]) {
      // Native reconciliation derives object references from a repository, not an interactive edit batch.
      if (layer.length > (input.machine ? 200_000 : 256)) throw new Error('Snapshot mutation budget exceeded');
      let bytes = 0;
      const paths = new Map<string, SnapshotMutation>();
      for (const mutation of layer) {
        validateSnapshotPath(mutation.path);
        if (mutation.content && mutation.content.byteLength > 32_000_000) throw new Error(`Artifacts cannot store ${JSON.stringify(mutation.path)} as a ${mutation.content.byteLength}-byte Git blob (limit: 32000000 bytes). No snapshot was published. Use Git LFS explicitly on a machine before committing this file; GitSpace does not convert files or rewrite history automatically.`);
        bytes += mutation.content?.byteLength ?? 0;
        if (paths.has(mutation.path)) throw new Error('Duplicate snapshot mutation');
        paths.set(mutation.path, mutation);
      }
      if (bytes > 32 * 1024 * 1024) throw new Error('Snapshot mutation budget exceeded');
      for (const mutation of layer) {
        const parts = mutation.path.split('/');
        for (let count = 1; count < parts.length; count++) {
          const ancestor = paths.get(parts.slice(0, count).join('/'));
          if (ancestor && (ancestor.content !== null || ancestor.oid) && (mutation.content !== null || mutation.oid)) throw new Error('Overlapping snapshot mutations');
        }
      }
    }
    const parent = await repo.readCommit(previous.worktreeCommit);
    if (!parent || parent.treeHash !== previous.worktreeTree) throw new Error('Previous snapshot is missing or inconsistent');
    const fs = createFsFromVolume(new Volume());
    const dir = '/snapshot';
    await git.init({ fs, dir });
    const oids = new Set<string>();
    const trees = new Map<string, ArtifactsTreeEntry[]>();
    let hydratedEntries = 0;
    const markerConflicts = new Set(input.conflicts ?? previous.conflicts ?? []);
    const rescanConflicts = input.machine !== undefined && (input.forcePublication === true || input.conflicts === undefined);
    const loadTree = async (oid: string): Promise<ArtifactsTreeEntry[]> => {
      const cached = trees.get(oid);
      if (cached) return cached;
      input.signal?.throwIfAborted();
      if (!input.machine && trees.size >= 256) throw new Error('Snapshot tree hydration budget exceeded');
      const entries = await repo.readTree(oid);
      if (!entries) throw new Error(`Missing tree ${oid}`);
      hydratedEntries += entries.length;
      if (hydratedEntries > 200_000) throw new Error('Snapshot tree entry budget exceeded');
      trees.set(oid, entries);
      return entries;
    };
    const editTree = async (oid: string | undefined, edits: SnapshotMutation[], tracked: boolean, prefix = ''): Promise<string> => {
      const entries = new Map((oid ? await loadTree(oid) : []).map(entry => [entry.name, { mode: entry.mode, path: entry.name, oid: entry.hash, type: entry.type === 'tree' ? 'tree' as const : entry.type === 'gitlink' ? 'commit' as const : 'blob' as const }]));
      const groups = new Map<string, SnapshotMutation[]>();
      for (const edit of edits) {
        const name = edit.path.split('/')[0]!;
        const group = groups.get(name) ?? []; group.push(edit); groups.set(name, group);
      }
      for (const [name, group] of groups) {
        const existing = entries.get(name);
        const direct = group.find(edit => edit.path === name);
        if (direct) {
          const path = prefix + direct.path;
          if (!input.machine && !direct.oid && path !== 'HEAD') {
            if (direct.content !== null && isSnapshotTextEntry({ type: direct.type ?? 'blob', mode: direct.mode ?? existing?.mode ?? '100644' }) && !isCleanSnapshotContent(direct.content)) markerConflicts.add(path);
            else markerConflicts.delete(path);
          }
          if (direct.content === null && !direct.oid) {
            entries.delete(name);
            const descendants = group.filter(edit => edit !== direct);
            if (descendants.length) {
              const child = await editTree(undefined, descendants.map(edit => ({ ...edit, path: edit.path.slice(name.length + 1) })), tracked, `${prefix}${name}/`);
              if (child !== '4b825dc642cb6eb9a060e54bf8d69288fbee4904') entries.set(name, { mode: '40000', path: name, oid: child, type: 'tree' });
            }
            continue;
          }
          if (tracked && !existing) continue;
          if (existing?.type === 'tree' && !group.some(edit => edit !== direct && edit.content === null && !edit.oid)) throw new Error('Cannot replace a directory with file content');
          const blob = direct.oid ?? await git.writeBlob({ fs, dir, blob: direct.content! });
          if (!direct.oid) oids.add(blob);
          entries.set(name, { mode: direct.mode ?? existing?.mode ?? '100644', path: name, oid: blob, type: direct.type ?? 'blob' });
        } else {
          if (existing && existing.type !== 'tree') throw new Error('Cannot traverse a file, symlink, or gitlink');
          if (tracked && !existing) continue;
          const child = await editTree(existing?.oid, group.map(edit => ({ ...edit, path: edit.path.slice(name.length + 1) })), tracked, `${prefix}${name}/`);
          const empty = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
          if (child === empty) entries.delete(name);
          else entries.set(name, { mode: '40000', path: name, oid: child, type: 'tree' });
        }
      }
      const tree = await git.writeTree({ fs, dir, tree: [...entries.values()] });
      if (tree !== oid) oids.add(tree);
      if (rescanConflicts) trees.set(tree, [...entries.values()].map(entry => ({ name: entry.path, hash: entry.oid, mode: entry.mode, type: entry.type === 'commit' ? 'gitlink' : entry.type })));
      return tree;
    };
    const worktreeTree = input.adopt?.worktreeTree ?? await editTree(previous.worktreeTree, mutations, false);
    // Initial/recovery publications and missing inventories require the merged
    // worktree itself, not seeded conflict flags, to establish current markers.
    if (rescanConflicts) {
      markerConflicts.clear();
      if (input.conflicts?.includes('HEAD')) markerConflicts.add('HEAD');
      const scan = async (tree: string, prefix: string, ancestors: Set<string>): Promise<void> => {
        if (ancestors.has(tree) || ancestors.size > 128) throw new Error('Invalid snapshot tree depth');
        ancestors.add(tree);
        try {
          for (const entry of await loadTree(tree)) {
            const path = prefix + entry.name;
            if (entry.type === 'tree') { await scan(entry.hash, `${path}/`, ancestors); continue; }
            if (path === 'HEAD' || !isSnapshotTextEntry({ type: entry.type === 'gitlink' ? 'commit' : 'blob', mode: entry.mode })) continue;
            input.signal?.throwIfAborted();
            const blob = oids.has(entry.hash)
              ? new Blob([Uint8Array.from((await git.readBlob({ fs, dir, oid: entry.hash })).blob)])
              : await repo.readBlob(entry.hash);
            if (!blob) throw new Error(`Missing snapshot blob ${entry.hash}`);
            const content = await readSnapshotText(blob);
            if (content !== null && hasSnapshotConflictMarkers(content)) markerConflicts.add(path);
          }
        } finally { ancestors.delete(tree); }
      };
      await scan(worktreeTree, '', new Set());
    }
    const conflicts = [...markerConflicts].sort();
    const conflictsChanged = JSON.stringify(conflicts ?? []) !== JSON.stringify(previous.conflicts ?? []);
    if (worktreeTree === previous.worktreeTree && !input.machine && !input.forcePublication && !conflictsChanged) return previous;
    const trackedParent = await repo.readCommit(previous.trackedWorktreeCommit);
    if (!trackedParent) throw new Error('Previous tracked snapshot is missing');
    const trackedTree = input.adopt?.trackedTree ?? await editTree(trackedParent.treeHash, input.trackedMutations ?? mutations, input.trackedMutations === undefined);
    const identity = { name: 'GitSpace Checkpoint', email: 'checkpoint@gitspace.invalid', timestamp: parent.committedAt + 1, timezoneOffset: 0 };
    // A tool change is authored by the agent; GitSpace stays the committer of every checkpoint.
    const author = input.message === undefined ? identity : { ...identity, name: 'GitSpace Agent', email: 'agent@gitspace.invalid' };
    const indexTree = input.adopt?.indexTree ?? (input.indexMutations ? await editTree(previous.indexTree, input.indexMutations, false) : previous.indexTree);
    if (!input.forcePublication && input.machine && worktreeTree === previous.worktreeTree && trackedTree === trackedParent.treeHash && indexTree === previous.indexTree && input.machine.headCommit === previous.headCommit && input.machine.branch === previous.branch && JSON.stringify(input.machine.lfs) === JSON.stringify(previous.lfs) && !conflictsChanged) return previous;
    const indexCommit = input.machine && indexTree === input.machine.indexTree ? input.machine.indexCommit : indexTree === previous.indexTree ? previous.indexCommit : await git.writeCommit({ fs, dir, commit: { tree: indexTree, parent: [previous.indexCommit, ...(input.machine ? [input.machine.indexCommit] : [])], author: identity, committer: identity, message: 'GitSpace merged index snapshot\n' } });
    if (indexCommit !== previous.indexCommit && indexCommit !== input.machine?.indexCommit) oids.add(indexCommit);
    const trackedWorktreeCommit = await git.writeCommit({ fs, dir, commit: { tree: trackedTree, parent: [previous.trackedWorktreeCommit], author, committer: identity, message: input.message ?? 'GitSpace cloud tracked worktree snapshot\n' } });
    oids.add(trackedWorktreeCommit);
    const worktreeCommit = await git.writeCommit({ fs, dir, commit: { tree: worktreeTree, parent: [...new Set([previous.worktreeCommit, trackedWorktreeCommit, indexCommit, ...(input.machine ? [input.machine.worktreeCommit] : [])])], author, committer: identity, message: input.message ?? 'GitSpace cloud worktree snapshot\n' } });
    oids.add(worktreeCommit);
    const packed = await git.packObjects({ fs, dir, oids: [...oids] });
    if (!packed.packfile) throw new Error('Git pack writer returned no pack');
    // A migrated workspace keeps its separate runtime ref: the immutable legacy
    // checkpoints/<generation> refs prohibit creating their parent as a Git ref.
    // First-machine imports still promote a machine ref to the cloud-owned ref.
    const workspaceRefs = [`refs/gitspace/spaces/${input.workspaceId}/checkpoints`, `refs/gitspace/spaces/${input.workspaceId}/runtime/checkpoints`];
    const checkpointRef = workspaceRefs.includes(previous.checkpointRef) ? previous.checkpointRef : workspaceRefs[0]!;
    const info = await repo.info();
    const token = await repo.createToken('write', 60);
    try { await publishSnapshotPack({ remote: info.remote, auth: { kind: 'bearer', token: token.plaintext }, ref: checkpointRef, previous: previous.worktreeCommit, commit: worktreeCommit, pack: packed.packfile, signal: input.signal, onPublicationState: state => { certainty = state; } }, request); }
    finally { await repo.revokeToken(token.id); }
    return RuntimeGitCheckpointSchema.parse({ ...(input.machine ?? previous), checkpointRef, indexCommit, indexTree, trackedWorktreeCommit, worktreeCommit, worktreeTree, conflicts });
  }, catch: error => new ArtifactsSnapshotError({ operation: 'writeSnapshot', certainty, message: error instanceof Error ? error.message : String(error) }) });
}
