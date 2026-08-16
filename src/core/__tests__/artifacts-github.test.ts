/**
 * GitHub LFS blob transport — batch API dialect tested zero-network via
 * injected fetch + token provider. The repo side (pointer format,
 * .gitattributes) is covered in artifacts.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execSync } from 'child_process';
import { artifactPaths, artifactBlobPath, ensureArtifactsRepo, setArtifactsRemote, readArtifactResolving, ensureArtifactsMount, makeLfsPointer } from '../artifacts.js';
import { uploadMissingBlobs, downloadBlob, slugFromRemote, createGithubBlobFetcher, type GithubLfsDeps } from '../artifacts-github.js';

let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'gs-gh-lfs-'));
});
afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

function seedBlob(bytes: Buffer): string {
  const oid = createHash('sha256').update(bytes).digest('hex');
  const { blobsDir } = artifactPaths(projectDir);
  const p = artifactBlobPath(blobsDir, oid);
  mkdirSync(join(blobsDir, oid.slice(0, 2)), { recursive: true });
  writeFileSync(p, bytes);
  return oid;
}

interface Call { url: string; method: string; headers: Record<string, string>; body?: unknown }

/** Scripted LFS server: batch responses keyed by operation; records calls. */
function fakeLfs(opts: {
  /** oids the server already has (upload: no actions) */
  has?: Set<string>;
  /** payload served on download hrefs, keyed by oid */
  serve?: Map<string, Buffer>;
  batchStatus?: number;
}): { deps: GithubLfsDeps; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
    const call: Call = { url, method, headers };
    if (url.endsWith('/info/lfs/objects/batch')) {
      call.body = JSON.parse(String(init?.body));
      calls.push(call);
      if (opts.batchStatus && opts.batchStatus !== 200) return new Response('nope', { status: opts.batchStatus });
      const req = call.body as { operation: string; objects: Array<{ oid: string; size: number }> };
      const objects = req.objects.map(({ oid, size }) => {
        if (req.operation === 'upload') {
          return opts.has?.has(oid)
            ? { oid, size }
            : { oid, size, actions: { upload: { href: `https://lfs.test/up/${oid}`, header: { 'x-up': '1' } }, verify: { href: `https://lfs.test/verify/${oid}` } } };
        }
        return opts.serve?.has(oid)
          ? { oid, size, actions: { download: { href: `https://lfs.test/down/${oid}` } } }
          : { oid, size, error: { code: 404, message: 'not found' } };
      });
      return new Response(JSON.stringify({ transfer: 'basic', objects }), { status: 200 });
    }
    calls.push(call);
    if (url.includes('/up/')) return new Response(null, { status: 200 });
    if (url.includes('/verify/')) return new Response(null, { status: 200 });
    if (url.includes('/down/')) {
      const oid = url.split('/down/')[1]!;
      const bytes = opts.serve?.get(oid);
      return bytes ? new Response(new Uint8Array(bytes), { status: 200 }) : new Response(null, { status: 404 });
    }
    return new Response(null, { status: 500 });
  }) as typeof fetch;
  return { deps: { fetchImpl, tokenProvider: async () => 'tok_test' }, calls };
}

describe('slugFromRemote', () => {
  it('extracts github slugs; rejects other hosts', () => {
    expect(slugFromRemote('https://github.com/acme/proj-artifacts.git')).toBe('acme/proj-artifacts');
    expect(slugFromRemote('git@github.com:acme/proj-artifacts.git')).toBe('acme/proj-artifacts');
    expect(slugFromRemote('https://gitlab.com/acme/x.git')).toBeNull();
    expect(slugFromRemote(null)).toBeNull();
  });
});

describe('uploadMissingBlobs', () => {
  it('uploads only blobs the server lacks, with auth + verify round trip', async () => {
    const a = seedBlob(Buffer.from('blob-a'));
    const b = seedBlob(Buffer.from('blob-b'));
    const { deps, calls } = fakeLfs({ has: new Set([a]) });

    const uploaded = await uploadMissingBlobs(projectDir, 'acme/proj-artifacts', deps);
    expect(uploaded).toBe(1);

    const batch = calls.find((c) => c.url.endsWith('/batch'))!;
    expect(batch.url).toBe('https://github.com/acme/proj-artifacts.git/info/lfs/objects/batch');
    expect(batch.headers.Authorization).toBe(`Basic ${Buffer.from('x-access-token:tok_test').toString('base64')}`);
    expect((batch.body as { operation: string }).operation).toBe('upload');

    const put = calls.find((c) => c.method === 'PUT')!;
    expect(put.url).toBe(`https://lfs.test/up/${b}`);
    expect(put.headers['x-up']).toBe('1'); // action headers forwarded
    expect(calls.some((c) => c.url === `https://lfs.test/verify/${b}`)).toBe(true);
    expect(calls.some((c) => c.url === `https://lfs.test/up/${a}`)).toBe(false);
  });

  it('returns 0 with an empty store and surfaces batch failures', async () => {
    expect(await uploadMissingBlobs(projectDir, 'acme/p', fakeLfs({}).deps)).toBe(0);
    seedBlob(Buffer.from('x'));
    await expect(uploadMissingBlobs(projectDir, 'acme/p', fakeLfs({ batchStatus: 401 }).deps)).rejects.toThrow('batch upload failed');
  });
});

describe('downloadBlob + resolving reads', () => {
  it('downloads, sha256-verifies, and stores; rejects corrupted payloads', async () => {
    const bytes = Buffer.from('the real bytes');
    const oid = createHash('sha256').update(bytes).digest('hex');
    const good = fakeLfs({ serve: new Map([[oid, bytes]]) });
    expect(await downloadBlob(projectDir, 'acme/p', oid, bytes.length, good.deps)).toBe(true);
    const { blobsDir } = artifactPaths(projectDir);
    expect(readFileSync(artifactBlobPath(blobsDir, oid)).equals(bytes)).toBe(true);

    // corrupted: server returns different bytes for the oid
    const badOid = createHash('sha256').update('expected').digest('hex');
    const bad = fakeLfs({ serve: new Map([[badOid, Buffer.from('tampered')]]) });
    expect(await downloadBlob(projectDir, 'acme/p', badOid, 8, bad.deps)).toBe(false);
    expect(existsSync(artifactBlobPath(blobsDir, badOid))).toBe(false);
  });

  it('createGithubBlobFetcher resolves pointer-miss reads through LFS (github remotes only)', async () => {
    await ensureArtifactsRepo(projectDir);
    await setArtifactsRemote(projectDir, 'https://github.com/acme/proj-artifacts.git');
    const base = join(projectDir, 'base');
    mkdirSync(base, { recursive: true });
    const mount = await ensureArtifactsMount(projectDir, base, 'main');

    // Commit a pointer WITHOUT its blob (simulates a second machine adopting).
    const bytes = Buffer.from('shared artifact payload');
    const oid = createHash('sha256').update(bytes).digest('hex');
    writeFileSync(join(mount, 'evidence.bin'), makeLfsPointer(oid, bytes.length));
    execSync(`git -C ${JSON.stringify(mount)} add evidence.bin && git -C ${JSON.stringify(mount)} -c user.name=t -c user.email=t@t commit -qm ptr`);

    const { deps } = fakeLfs({ serve: new Map([[oid, bytes]]) });
    const fetcher = await createGithubBlobFetcher(projectDir, deps);
    expect(fetcher).not.toBeNull();
    const resolved = await readArtifactResolving(projectDir, mount, 'evidence.bin', { blobFetcher: fetcher });
    expect(resolved.equals(bytes)).toBe(true);
    // blob now cached locally — offline reads work
    const again = await readArtifactResolving(projectDir, mount, 'evidence.bin', { blobFetcher: null });
    expect(again.equals(bytes)).toBe(true);
  });

  it('fetcher is null for non-github remotes', async () => {
    await ensureArtifactsRepo(projectDir);
    await setArtifactsRemote(projectDir, 'https://gitlab.com/acme/x.git');
    expect(await createGithubBlobFetcher(projectDir, fakeLfs({}).deps)).toBeNull();
  });
});
