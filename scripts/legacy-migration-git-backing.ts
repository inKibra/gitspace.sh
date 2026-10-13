import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';

// This owning adapter is local rehearsal infrastructure, never a production binding.
// Every ref and object operation uses native Git; no in-memory ref/object substitutes.
const repositoryName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u);
const objectId = z.string().regex(/^[a-f0-9]{40}$/u);
const createOptions = z.object({ readOnly: z.boolean().optional(), description: z.string().optional(), setDefaultBranch: z.string().optional() });
const metadataSchema = z.object({ id: z.string(), name: repositoryName, description: z.string().nullable(), defaultBranch: z.string(), createdAt: z.string(), updatedAt: z.string(), lastPushAt: z.string().nullable(), source: z.string().nullable(), readOnly: z.boolean() });
type Metadata = z.infer<typeof metadataSchema>;
type Token = { id: string; plaintext: string; scope: 'read' | 'write'; createdAt: string; expiresAt: string };
function failure(code: string, message: string): Error & { code: string } { return Object.assign(new Error(message), { name: 'ArtifactsError', code }); }

async function command(args: string[], options: { input?: Uint8Array<ArrayBuffer>; env?: Record<string, string> } = {}) {
  const child = Bun.spawn(['git', ...args], { stdin: options.input ? new Blob([options.input]) : 'ignore', stdout: 'pipe', stderr: 'pipe', env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1', ...options.env } });
  const [code, bytes] = await Promise.all([child.exited, new Response(child.stdout).arrayBuffer(), new Response(child.stderr).arrayBuffer()]);
  if (code !== 0) throw failure('INTERNAL_ERROR', `Isolated Git operation failed (${code}); source diagnostics are not returned over RPC`);
  return new Uint8Array(bytes);
}
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/** A serialized native cat-file stream avoids one process per file during full graph validation. */
class ObjectReader {
  private readonly process;
  private readonly reader;
  private pending: Uint8Array = new Uint8Array(0);
  private queue: Promise<unknown> = Promise.resolve();
  constructor(path: string) {
    this.process = Bun.spawn(['git', `--git-dir=${path}`, 'cat-file', '--batch'], { stdin: 'pipe', stdout: 'pipe', stderr: 'ignore' });
    this.reader = this.process.stdout.getReader();
  }
  private async take(length: number): Promise<Uint8Array<ArrayBuffer>> {
    const output = new Uint8Array(length);
    let offset = 0;
    while (offset < length) {
      if (!this.pending.length) {
        const next = await this.reader.read();
        if (next.done) throw failure('INTERNAL_ERROR', 'Git object reader stopped');
        this.pending = next.value;
      }
      const count = Math.min(length - offset, this.pending.length);
      output.set(this.pending.subarray(0, count), offset);
      this.pending = this.pending.subarray(count);
      offset += count;
    }
    return output;
  }
  read(spec: string): Promise<{ oid: string; type: string; bytes: Uint8Array<ArrayBuffer> } | null> {
    if (/[\r\n\0]/u.test(spec)) throw failure('INVALID_INPUT', 'Invalid object lookup');
    const result = this.queue.then(async () => {
      this.process.stdin.write(`${spec}\n`);
      await this.process.stdin.flush();
      let header = '';
      for (;;) { const byte = (await this.take(1))[0]!; if (byte === 10) break; header += String.fromCharCode(byte); }
      if (header.endsWith(' missing')) return null;
      const match = /^([0-9a-f]{40}) (blob|tree|commit|tag) ([0-9]+)$/u.exec(header);
      if (!match) throw failure('INTERNAL_ERROR', 'Invalid Git object response');
      const size = Number(match[3]);
      if (!Number.isSafeInteger(size)) throw failure('INTERNAL_ERROR', 'Invalid Git object length');
      const bytes = await this.take(size);
      if ((await this.take(1))[0] !== 10) throw failure('INTERNAL_ERROR', 'Invalid Git object delimiter');
      return { oid: match[1]!, type: match[2]!, bytes };
    });
    this.queue = result.catch(() => {});
    return result;
  }
  async close() { await this.queue; this.process.stdin.end(); await this.process.exited; }
}

function commitMetadata(hash: string, bytes: Uint8Array) {
  const raw = text(bytes), split = raw.indexOf('\n\n');
  const headers = raw.slice(0, split).split('\n');
  const value = (name: string) => headers.find(line => line.startsWith(`${name} `))?.slice(name.length + 1);
  const identity = (name: string) => {
    const match = /^(.*) <([^>]*)> (-?[0-9]+) [+-][0-9]{4}$/u.exec(value(name) ?? '');
    if (!match) throw failure('INTERNAL_ERROR', `Invalid commit ${name}`);
    return { name: match[1]!, email: match[2]!, timestamp: Number(match[3]) };
  };
  const author = identity('author'), committer = identity('committer');
  return { hash, treeHash: objectId.parse(value('tree')), message: raw.slice(split + 2).replace(/\n$/u, ''), author: { name: author.name, email: author.email }, committer: { name: committer.name, email: committer.email }, parents: headers.filter(line => line.startsWith('parent ')).map(line => objectId.parse(line.slice(7))), authoredAt: author.timestamp, committedAt: committer.timestamp };
}
function treeEntries(bytes: Uint8Array) {
  const entries: Array<{ name: string; mode: string; hash: string; type: 'tree' | 'blob' | 'exec' | 'gitlink' | 'symlink' }> = [];
  let offset = 0;
  while (offset < bytes.length) {
    const space = bytes.indexOf(32, offset), nul = bytes.indexOf(0, space);
    if (space < offset || nul < space || nul + 21 > bytes.length) throw failure('INTERNAL_ERROR', 'Invalid native Git tree');
    const mode = text(bytes.subarray(offset, space));
    const type = mode === '40000' ? 'tree' : mode === '160000' ? 'gitlink' : mode === '120000' ? 'symlink' : mode === '100755' ? 'exec' : 'blob';
    entries.push({ name: text(bytes.subarray(space + 1, nul)), mode, hash: Buffer.from(bytes.subarray(nul + 1, nul + 21)).toString('hex'), type });
    offset = nul + 21;
  }
  return entries;
}

export interface LegacyMigrationGitBacking {
  root: string;
  origin: string;
  url: string;
  controlToken: string;
  fetch(request: Request): Promise<Response>;
  repositoryPath(name: string): string;
  importRepository(name: string, sourceBarePath: string): Promise<Metadata & { remote: string }>;
  pushCheckpoint(input: { repositoryPath: string; remote: string; plaintext: string; checkpointRef: string; commit: string }): Promise<void>;
  close(): Promise<void>;
}

export async function startLegacyMigrationGitBacking(input: { root: string; origin?: string; port?: number }): Promise<LegacyMigrationGitBacking> {
  const root = resolve(input.root);
  const origin = new URL(input.origin ?? 'https://legacy-migration-git.invalid').origin;
  if (new URL(origin).hostname !== 'legacy-migration-git.invalid') throw new Error('Rehearsal origin must be the reserved legacy-migration-git.invalid hostname');
  await mkdir(root, { mode: 0o700 }); // Refuse an existing root: never serve or mutate source repositories.
  const controlToken = randomBytes(32).toString('hex');
  const readers = new Map<string, ObjectReader>();
  const tokens = new Map<string, Map<string, Token>>();
  const path = (name: string) => join(root, `${repositoryName.parse(name)}.git`);
  const metadataPath = (name: string) => join(path(name), 'gitspace-rehearsal.json');
  async function metadata(name: string): Promise<Metadata> {
    try { return metadataSchema.parse(JSON.parse(await readFile(metadataPath(name), 'utf8'))); }
    catch (error) { if (typeof error === 'object' && error && 'code' in error && error.code === 'ENOENT') throw failure('NOT_FOUND', 'Repository not found'); throw error; }
  }
  const remote = (name: string) => `${origin}/${repositoryName.parse(name)}.git`;
  const info = async (name: string) => ({ ...await metadata(name), remote: remote(name) });
  async function save(value: Metadata) { await writeFile(metadataPath(value.name), JSON.stringify(value), { mode: 0o600 }); }
  async function issueToken(name: string, scope: 'read' | 'write' = 'write', ttl = 86400) {
    await metadata(name);
    if (!Number.isSafeInteger(ttl) || ttl < 60 || ttl > 31536000) throw failure('INVALID_TTL', 'Invalid token lifetime');
    const token: Token = { id: randomUUID(), plaintext: randomBytes(32).toString('hex'), scope, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + ttl * 1000).toISOString() };
    let all = tokens.get(name); if (!all) { all = new Map(); tokens.set(name, all); } all.set(token.id, token);
    return { id: token.id, plaintext: token.plaintext, scope, expiresAt: token.expiresAt };
  }
  function reader(name: string) { let current = readers.get(name); if (!current) { current = new ObjectReader(path(name)); readers.set(name, current); } return current; }
  async function create(name: string, options: z.infer<typeof createOptions> = {}, source?: string) {
    repositoryName.parse(name);
    try { await mkdir(path(name), { mode: 0o700 }); }
    catch (error) { if (typeof error === 'object' && error && 'code' in error && error.code === 'EEXIST') throw failure('ALREADY_EXISTS', 'Repository already exists'); throw error; }
    if (source) await command(['clone', '--mirror', '--no-local', pathToFileURL(resolve(source)).href, path(name)]);
    else await command(['init', '--bare', `--initial-branch=${options.setDefaultBranch ?? 'main'}`, path(name)]);
    await command([`--git-dir=${path(name)}`, 'config', 'http.receivepack', 'true']);
    await command([`--git-dir=${path(name)}`, 'config', 'receive.shallowUpdate', 'true']);
    const defaultBranch = text(await command([`--git-dir=${path(name)}`, 'symbolic-ref', '--short', 'HEAD'])).trim();
    const now = new Date().toISOString();
    await save({ id: randomUUID(), name, description: options.description ?? null, defaultBranch, createdAt: now, updatedAt: now, lastPushAt: source ? now : null, source: source ? 'isolated-local-export' : null, readOnly: options.readOnly ?? false });
    const token = await issueToken(name);
    return { ...await info(name), token: token.plaintext };
  }
  async function readCommit(name: string, oid: string) { const object = await reader(name).read(objectId.parse(oid)); return object?.type === 'commit' ? commitMetadata(object.oid, object.bytes) : null; }
  async function rpc(name: string | null, operation: string, args: unknown[]) {
    if (name !== null) await metadata(name);
    if (operation === 'create' && name === null) return create(repositoryName.parse(args[0]), createOptions.parse(args[1] ?? {}));
    if (operation === 'list' && name === null) {
      const options = z.object({ cursor: z.string().optional(), limit: z.number().int().min(1).max(200).optional() }).parse(args[0] ?? {});
      const names = (await readdir(root)).filter(entry => entry.endsWith('.git')).map(entry => entry.slice(0, -4)).sort();
      const offset = options.cursor === undefined ? 0 : z.coerce.number().int().nonnegative().parse(options.cursor), limit = options.limit ?? 50;
      return { repos: await Promise.all(names.slice(offset, offset + limit).map(metadata)), total: names.length, ...(offset + limit < names.length ? { cursor: String(offset + limit) } : {}) };
    }
    if (operation === 'delete' && name === null) {
      const target = repositoryName.parse(args[0]);
      try { await metadata(target); } catch (error) { if (error instanceof Error && 'code' in error && error.code === 'NOT_FOUND') return false; throw error; }
      await readers.get(target)?.close(); readers.delete(target); tokens.delete(target); await rm(path(target), { recursive: true }); return true;
    }
    if (name === null) throw failure('INVALID_INPUT', `Unsupported isolated namespace operation ${operation}`);
    switch (operation) {
      case 'info': return info(name);
      case 'createToken': return issueToken(name, z.enum(['read', 'write']).parse(args[0] ?? 'write'), z.number().parse(args[1] ?? 86400));
      case 'revokeToken': { const id = z.string().min(1).parse(args[0]); const all = tokens.get(name); const found = [...(all?.values() ?? [])].find(token => token.id === id || token.plaintext === id); return found ? all!.delete(found.id) : false; }
      case 'listTokens': { const all = [...(tokens.get(name)?.values() ?? [])]; return { tokens: all.map(({ id, scope, createdAt, expiresAt }) => ({ id, scope, createdAt, expiresAt, state: Date.parse(expiresAt) > Date.now() ? 'active' : 'expired' })), total: all.length }; }
      case 'readCommit': return readCommit(name, objectId.parse(args[0]));
      case 'readTree': { const object = await reader(name).read(objectId.parse(args[0])); if (!object) return null; if (object.type !== 'tree') throw failure('INVALID_INPUT', 'Not a tree'); return treeEntries(object.bytes); }
      case 'readBlob': { const object = await reader(name).read(objectId.parse(args[0])); return object?.type === 'blob' ? new Blob([object.bytes]) : null; }
      case 'readFile': {
        const options = z.object({ ref: z.string().min(1), path: z.string().min(1) }).parse(args[0]);
        if (options.ref.startsWith('-') || /[\r\n\0:]/u.test(options.ref) || options.path.startsWith('/') || options.path.split('/').some(part => part === '..')) throw failure('INVALID_INPUT', 'Invalid file lookup');
        const object = await reader(name).read(`${options.ref}:${options.path}`);
        return object?.type === 'blob' ? new Blob([object.bytes]) : null;
      }
      case 'log': {
        const options = z.object({ ref: z.string().min(1).optional(), limit: z.number().int().nonnegative().optional(), offset: z.number().int().nonnegative().optional() }).parse(args[0] ?? {});
        const ref = options.ref ?? 'HEAD'; if (ref.startsWith('-') || /[\r\n\0]/u.test(ref)) throw failure('INVALID_INPUT', 'Invalid log ref');
        const object = await reader(name).read(`${ref}^{commit}`);
        if (!object) return [];
        if (object.type !== 'commit') throw failure('INVALID_INPUT', 'History ref is not a commit');
        const oids = text(await command([`--git-dir=${path(name)}`, 'rev-list', '--first-parent', `--max-count=${Math.min(options.limit ?? 50, 1000)}`, `--skip=${options.offset ?? 0}`, object.oid])).trim();
        return oids ? Promise.all(oids.split('\n').map(oid => readCommit(name, oid))) : [];
      }
      case 'fork': {
        const target = repositoryName.parse(args[0]);
        const options = z.object({ description: z.string().optional(), readOnly: z.boolean().optional(), defaultBranchOnly: z.boolean().optional() }).parse(args[1] ?? {});
        if (options.defaultBranchOnly !== false) throw failure('INVALID_INPUT', 'Rehearsal requires an explicit all-refs fork');
        return create(target, options, path(name));
      }
      default: throw failure('INVALID_INPUT', `Unsupported isolated repository operation ${operation}`);
    }
  }
  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/rpc') {
        if (request.headers.get('authorization') !== `Bearer ${controlToken}`) return new Response('Unauthorized', { status: 401 });
        const input = z.object({ repository: repositoryName.nullable(), operation: z.string(), args: z.array(z.unknown()) }).parse(await request.json());
        const result = await rpc(input.repository, input.operation, input.args);
        if (result instanceof Blob) return new Response(result, { headers: { 'content-type': 'application/octet-stream', 'x-gitspace-result': 'blob' } });
        return Response.json(result);
      }
      const match = /^\/([A-Za-z0-9][A-Za-z0-9._-]*)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/u.exec(url.pathname);
      if (!match) return new Response('Not found', { status: 404 });
      const name = match[1]!, meta = await metadata(name);
      const service = match[2] === 'info/refs' ? url.searchParams.get('service') : match[2];
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack') return new Response('Unsupported Git service', { status: 400 });
      const token = [...(tokens.get(name)?.values() ?? [])].find(value => request.headers.get('authorization') === `Bearer ${value.plaintext}`);
      if (!token || Date.parse(token.expiresAt) <= Date.now() || (service === 'git-receive-pack' && (token.scope !== 'write' || meta.readOnly))) return new Response('Unauthorized', { status: 401 });
      const body = request.method === 'POST' ? new Uint8Array(await request.arrayBuffer()) : undefined;
      const output = await command(['http-backend'], { input: body, env: { GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: '1', PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1), REQUEST_METHOD: request.method, CONTENT_TYPE: request.headers.get('content-type') ?? '', CONTENT_LENGTH: String(body?.byteLength ?? 0), REMOTE_USER: 'isolated-rehearsal', HTTP_GIT_PROTOCOL: request.headers.get('git-protocol') ?? '', SERVER_PROTOCOL: 'HTTP/1.1' } });
      const separator = Buffer.from(output).indexOf('\r\n\r\n');
      if (separator < 0) throw failure('INTERNAL_ERROR', 'Invalid Git CGI response');
      const headers = new Headers(); let status = 200;
      for (const line of text(output.subarray(0, separator)).split('\r\n')) { const colon = line.indexOf(':'); if (colon < 1) continue; const key = line.slice(0, colon), value = line.slice(colon + 1).trim(); if (key.toLowerCase() === 'status') status = Number(value.split(' ')[0]); else headers.append(key, value); }
      if (request.method === 'POST' && service === 'git-receive-pack' && status === 200) { const now = new Date().toISOString(); await save({ ...meta, updatedAt: now, lastPushAt: now }); }
      return new Response(output.subarray(separator + 4), { status, headers });
    } catch (error) { return Response.json({ name: 'ArtifactsError', code: error instanceof Error && 'code' in error ? error.code : 'INTERNAL_ERROR', message: error instanceof Error ? error.message : String(error) }, { status: 500 }); }
  }
  const server = Bun.serve({ hostname: '127.0.0.1', port: input.port ?? 0, fetch: handle });
  const url = server.url.origin;
  return {
    root, origin, url, controlToken, fetch: handle,
    repositoryPath: path,
    importRepository: (name: string, sourceBarePath: string) => create(name, {}, sourceBarePath),
    async pushCheckpoint(input: { repositoryPath: string; remote: string; plaintext: string; checkpointRef: string; commit: string }) {
      const target = new URL(input.remote);
      if (target.origin !== origin || !/^\/[A-Za-z0-9][A-Za-z0-9._-]*\.git$/u.test(target.pathname) || target.search || target.hash) throw new Error('Refusing non-isolated Git target');
      if (!input.checkpointRef.startsWith('refs/gitspace/')) throw new Error('Expected checkpoint ref');
      await command(['check-ref-format', input.checkpointRef]); objectId.parse(input.commit);
      const local = `${url}${target.pathname}`;
      await command(['-C', resolve(input.repositoryPath), 'push', '--no-verify', local, `${input.commit}:${input.checkpointRef}`], { env: { GIT_CONFIG_COUNT: '3', GIT_CONFIG_KEY_0: `http.${local}.extraHeader`, GIT_CONFIG_VALUE_0: `Authorization: Bearer ${input.plaintext}`, GIT_CONFIG_KEY_1: 'credential.helper', GIT_CONFIG_VALUE_1: '', GIT_CONFIG_KEY_2: 'http.followRedirects', GIT_CONFIG_VALUE_2: 'false' } });
    },
    async close() { server.stop(true); await Promise.all([...readers.values()].map(value => value.close())); },
  };
}
