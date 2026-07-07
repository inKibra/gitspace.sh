/**
 * Managed artifacts tier (Tier 2) client — offline unit tests. Every network
 * edge is a faked fetch injected into the module under test; NOTHING here
 * touches the real gitspace.sh API (or the keychain — auth headers are
 * injected too). Git operations run against real repos in temp dirs, with
 * plain filesystem paths standing in for the worker-proxied git URL.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createHash } from 'crypto';
import { execSync } from 'child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import {
  artifactBlobPath,
  artifactPaths,
  captureArtifacts,
  ensureArtifactsMount,
  getManagedArtifactsProject,
  readArtifactResolving,
  readArtifactsPointerConfig,
  writeArtifactsPointerConfig,
} from '../artifacts.js';
import {
  artifactsBlobUrl,
  checkRemoteBlobs,
  computeMissingBlobOids,
  createManagedTokenClient,
  deriveManagedSlug,
  isGitAuthError,
  listLocalBlobs,
  parseManagedProjectRef,
  setupManagedArtifacts,
  syncManagedArtifacts,
  syncManagedBlobs,
  type ArtifactsToken,
  type FetchLike,
} from '../artifacts-managed.js';

let projectDir: string;
const g = (cwd: string, args: string): string =>
  execSync(`git -C ${JSON.stringify(cwd)} ${args}`, { encoding: 'utf8' }).trim();

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'gs-artifacts-managed-'));
});
afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

const sha256 = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');

function seedBlob(content: string): { oid: string; bytes: Buffer } {
  const bytes = Buffer.from(content);
  const oid = sha256(bytes);
  const { blobsDir } = artifactPaths(projectDir);
  const file = artifactBlobPath(blobsDir, oid);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, bytes);
  return { oid, bytes };
}

// ── faked fetch ─────────────────────────────────────────────────────────────

interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Uint8Array | null;
}

function recordedFetch(handler: (req: RecordedRequest) => Response | Promise<Response>): {
  fetch: FetchLike;
  calls: RecordedRequest[];
} {
  const calls: RecordedRequest[] = [];
  const fetchLike: FetchLike = async (url, init) => {
    const rawBody = init?.body;
    const req: RecordedRequest = {
      url: String(url),
      method: init?.method ?? 'GET',
      headers: { ...(init?.headers as Record<string, string> | undefined) },
      body: rawBody instanceof Uint8Array ? rawBody
        : typeof rawBody === 'string' ? new TextEncoder().encode(rawBody)
        : null,
    };
    calls.push(req);
    return handler(req);
  };
  return { fetch: fetchLike, calls };
}

const testAuth = async (): Promise<Record<string, string>> => ({
  Authorization: 'Bearer session-token',
  'X-Device-Fingerprint': 'fp-test',
});

// ── blob walk + upload-set computation ──────────────────────────────────────

describe('listLocalBlobs', () => {
  it('walks .artifacts-blobs/<aa>/<oid> and skips junk', () => {
    const a = seedBlob('blob-a');
    const b = seedBlob('blob-b');
    const { blobsDir } = artifactPaths(projectDir);
    writeFileSync(join(blobsDir, 'stray.txt'), 'not a shard'); // top-level file
    const shard = a.oid.slice(0, 2);
    writeFileSync(join(blobsDir, shard, 'not-an-oid.tmp'), 'junk'); // non-oid name
    const listed = listLocalBlobs(blobsDir);
    expect(listed.map((x) => x.oid).sort()).toEqual([a.oid, b.oid].sort());
    expect(listed.find((x) => x.oid === a.oid)!.size).toBe(6);
    expect(listLocalBlobs(join(projectDir, 'nope'))).toEqual([]); // absent dir
  });
});

describe('computeMissingBlobOids', () => {
  it('splits present/missing from HEAD responses', async () => {
    const { fetch: f, calls } = recordedFetch((req) =>
      new Response(null, { status: req.url.includes('aaa') ? 200 : 404 }));
    const oids = [`aaa${'0'.repeat(61)}`, `bbb${'0'.repeat(61)}`];
    const r = await computeMissingBlobOids('brad/demo', oids, f);
    expect(r.present).toEqual([oids[0]!]);
    expect(r.missing).toEqual([oids[1]!]);
    expect(calls.every((c) => c.method === 'HEAD')).toBe(true);
    expect(calls[0]!.url).toBe(artifactsBlobUrl('brad/demo', oids[0]!));
  });

  it('throws on non-404 failures', async () => {
    const { fetch: f } = recordedFetch(() => new Response(null, { status: 500 }));
    await expect(computeMissingBlobOids('brad/demo', ['c'.repeat(64)], f)).rejects.toThrow('Blob HEAD failed');
  });
});

describe('syncManagedBlobs', () => {
  it('uploads exactly the blobs the API is missing (HEAD then PUT)', async () => {
    const present = seedBlob('already-there');
    const missing = seedBlob('needs-upload');
    const { fetch: f, calls } = recordedFetch((req) => {
      if (req.method === 'HEAD') {
        return new Response(null, { status: req.url.endsWith(present.oid) ? 200 : 404 });
      }
      expect(req.method).toBe('PUT');
      return new Response(JSON.stringify({ oid: missing.oid, size: missing.bytes.length, existed: false }), { status: 200 });
    });
    const result = await syncManagedBlobs(projectDir, 'brad/demo', f);
    expect(result).toEqual({ total: 2, uploaded: 1, alreadyPresent: 1, failed: 0 });
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(put.url).toBe(artifactsBlobUrl('brad/demo', missing.oid));
    expect(Buffer.from(put.body!).equals(missing.bytes)).toBe(true);
    expect(put.headers['Content-Length']).toBe(String(missing.bytes.length)); // worker 411s without it
  });

  it('counts per-blob failures without throwing', async () => {
    seedBlob('will-fail');
    const { fetch: f } = recordedFetch((req) =>
      new Response(null, { status: req.method === 'HEAD' ? 404 : 500 }));
    const result = await syncManagedBlobs(projectDir, 'brad/demo', f);
    expect(result).toEqual({ total: 1, uploaded: 0, alreadyPresent: 0, failed: 1 });
  });
});

describe('checkRemoteBlobs', () => {
  it('reports presence counts using the injected auth + fetch', async () => {
    seedBlob('one');
    seedBlob('two');
    const { fetch: f, calls } = recordedFetch(() => new Response(null, { status: 404 }));
    const r = await checkRemoteBlobs(projectDir, 'brad/demo', { fetchImpl: f, authHeaders: testAuth });
    expect(r).toEqual({ total: 2, present: 0, missing: 2 });
    expect(calls[0]!.headers.Authorization).toBe('Bearer session-token'); // user session, not the git token
    expect(calls[0]!.headers['X-Device-Fingerprint']).toBe('fp-test');
  });
});

// ── pointer-miss blob fetch hook (readArtifactResolving) ───────────────────

describe('readArtifactResolving pointer-miss hook', () => {
  async function captureBigAndDropBlob(content: string): Promise<{ mount: string; path: string; oid: string; bytes: Buffer }> {
    const ws = join(projectDir, 'workspaces', 'w1');
    mkdirSync(ws, { recursive: true });
    const mount = await ensureArtifactsMount(projectDir, ws, 'w1');
    const bytes = Buffer.from(content);
    await captureArtifacts(projectDir, mount, [{ path: 'demos/big.bin', content: bytes }], { pointerThresholdBytes: 4 });
    const oid = sha256(bytes);
    rmSync(artifactBlobPath(artifactPaths(projectDir).blobsDir, oid)); // simulate machine #2: pointer without blob
    return { mount, path: 'demos/big.bin', oid, bytes };
  }

  it('fetches, verifies, stores, and returns the missing blob', async () => {
    const { mount, path, oid, bytes } = await captureBigAndDropBlob('big-bytes-payload');
    const asked: string[] = [];
    const fetched = await readArtifactResolving(projectDir, mount, path, {
      blobFetcher: async (o) => { asked.push(o); return bytes; },
    });
    expect(asked).toEqual([oid]);
    expect(fetched.equals(bytes)).toBe(true);
    // Blob restored locally — a second read needs no fetcher at all.
    const again = await readArtifactResolving(projectDir, mount, path, { blobFetcher: null });
    expect(again.equals(bytes)).toBe(true);
  });

  it('throws "missing" when the fetcher has nothing (404) or is absent', async () => {
    const { mount, path } = await captureBigAndDropBlob('gone-forever');
    await expect(readArtifactResolving(projectDir, mount, path, { blobFetcher: async () => null }))
      .rejects.toThrow('Artifact blob missing');
    await expect(readArtifactResolving(projectDir, mount, path, { blobFetcher: null }))
      .rejects.toThrow('Artifact blob missing');
  });

  it('rejects fetched bytes whose sha256 does not match the pointer oid', async () => {
    const { mount, path } = await captureBigAndDropBlob('authentic-bytes');
    await expect(readArtifactResolving(projectDir, mount, path, {
      blobFetcher: async () => Buffer.from('tampered-bytes'),
    })).rejects.toThrow('hash mismatch');
  });

  it('reads small files and present blobs without consulting the fetcher', async () => {
    const ws = join(projectDir, 'workspaces', 'w2');
    mkdirSync(ws, { recursive: true });
    const mount = await ensureArtifactsMount(projectDir, ws, 'w2');
    await captureArtifacts(projectDir, mount, [{ path: 'small.txt', content: 'tiny' }]);
    const boom: () => never = () => { throw new Error('fetcher must not run'); };
    const small = await readArtifactResolving(projectDir, mount, 'small.txt', { blobFetcher: boom });
    expect(small.toString()).toBe('tiny');
  });
});

// ── pointer-config { project } round trip ──────────────────────────────────

describe('.gitspace/artifacts.json managed pointer', () => {
  it('round-trips { project: "handle/slug" } and stages in the code repo', async () => {
    const code = join(projectDir, 'code');
    mkdirSync(code, { recursive: true });
    execSync(`git init -q ${JSON.stringify(code)}`);
    await writeArtifactsPointerConfig(code, { project: 'brad/demo' });
    expect(readArtifactsPointerConfig(code)).toEqual({ project: 'brad/demo' });
    expect(g(code, 'diff --cached --name-only')).toBe('.gitspace/artifacts.json');
  });
});

describe('managed project refs', () => {
  it('validates handle/slug and derives worker-legal slugs', () => {
    expect(parseManagedProjectRef('brad/demo')).toEqual({ handle: 'brad', slug: 'demo' });
    expect(() => parseManagedProjectRef('no-slash')).toThrow('Invalid managed artifacts project');
    expect(() => parseManagedProjectRef('a/b/c')).toThrow('Invalid');
    expect(deriveManagedSlug('My Project!!')).toBe('my-project');
    expect(deriveManagedSlug('gitspace.sh')).toBe('gitspace-sh');
  });
});

// ── token client: cache, expiry, refresh-on-401 ────────────────────────────

describe('createManagedTokenClient', () => {
  it('caches fresh tokens and re-mints expired ones', async () => {
    let mints = 0;
    const client = createManagedTokenClient({
      mint: async (): Promise<ArtifactsToken> => ({ token: `tok-${++mints}`, expiresAt: Date.now() + 3600_000 }),
    });
    expect((await client.getToken()).token).toBe('tok-1');
    expect((await client.getToken()).token).toBe('tok-1'); // cached
    expect(mints).toBe(1);

    const expiring = createManagedTokenClient({
      mint: async (): Promise<ArtifactsToken> => ({ token: `tok-${++mints}`, expiresAt: Date.now() - 1 }),
    });
    await expiring.getToken();
    await expiring.getToken(); // expired → minted again
    expect(mints).toBe(3);
  });

  it('authorized fetch re-mints once on 401 and retries with the new token', async () => {
    let mints = 0;
    const { fetch: f, calls } = recordedFetch((req) =>
      new Response(null, { status: req.headers.Authorization === 'Bearer tok-2' ? 200 : 401 }));
    const client = createManagedTokenClient({
      mint: async (): Promise<ArtifactsToken> => ({ token: `tok-${++mints}`, expiresAt: Date.now() + 3600_000 }),
      fetchImpl: f,
    });
    const res = await client.fetch('https://api.example/x');
    expect(res.status).toBe(200);
    expect(mints).toBe(2); // initial mint + 401 re-mint
    expect(calls.map((c) => c.headers.Authorization)).toEqual(['Bearer tok-1', 'Bearer tok-2']);
  });

  it('does not retry non-401 failures', async () => {
    let mints = 0;
    const { fetch: f, calls } = recordedFetch(() => new Response(null, { status: 500 }));
    const client = createManagedTokenClient({
      mint: async (): Promise<ArtifactsToken> => ({ token: `tok-${++mints}` }),
      fetchImpl: f,
    });
    const res = await client.fetch('https://api.example/x');
    expect(res.status).toBe(500);
    expect(mints).toBe(1);
    expect(calls.length).toBe(1);
  });
});

describe('isGitAuthError', () => {
  it('matches git-over-http 401 shapes only', () => {
    expect(isGitAuthError(new Error("fatal: unable to access 'https://x': The requested URL returned error: 401"))).toBe(true);
    expect(isGitAuthError(new Error('Authentication failed for https://x'))).toBe(true);
    expect(isGitAuthError(new Error('Could not resolve host: artifacts.gitspace.sh'))).toBe(false);
  });
});

// ── setup + managed sync, end to end against a local "remote" ──────────────

function makeRemoteWithHistory(): string {
  const remoteDir = join(projectDir, 'managed-remote.git');
  execSync(`git init -q --bare --initial-branch=main ${JSON.stringify(remoteDir)}`);
  const clone = join(projectDir, 'seed-clone');
  execSync(`git clone -q ${JSON.stringify(remoteDir)} ${JSON.stringify(clone)}`);
  writeFileSync(join(clone, 'README.md'), 'remote artifacts history\n');
  g(clone, '-c user.name=t -c user.email=t@t add -A');
  g(clone, '-c user.name=t -c user.email=t@t commit -qm seed');
  g(clone, 'push -q origin main');
  rmSync(clone, { recursive: true, force: true });
  return remoteDir;
}

function workerFetchFor(remoteDir: string): ReturnType<typeof recordedFetch> {
  return recordedFetch((req) => {
    if (req.url.includes('/artifacts/provision')) {
      expect(req.headers.Authorization).toBe('Bearer session-token');
      expect(JSON.parse(new TextDecoder().decode(req.body!))).toEqual({ project: 'brad/demo' });
      return Response.json({ project: 'brad/demo', gitUrl: remoteDir, token: 'cfa_write_1', expiresAt: Date.now() + 3600_000 });
    }
    if (req.url.includes('/artifacts/token')) {
      return Response.json({ project: 'brad/demo', gitUrl: remoteDir, token: 'cfa_write_fresh', expiresAt: Date.now() + 3600_000 });
    }
    if (req.url.includes('/artifacts/blobs/')) {
      if (req.method === 'HEAD') return new Response(null, { status: 404 });
      if (req.method === 'PUT') return Response.json({ existed: false });
    }
    return new Response(null, { status: 404 });
  });
}

describe('setupManagedArtifacts', () => {
  it('provisions, adopts remote history, records marker + pointer + git auth, syncs blobs', async () => {
    const remoteDir = makeRemoteWithHistory();
    const code = join(projectDir, 'base');
    mkdirSync(code, { recursive: true });
    execSync(`git init -q ${JSON.stringify(code)}`);
    const blob = seedBlob('managed blob payload');
    const { fetch: f, calls } = workerFetchFor(remoteDir);

    const result = await setupManagedArtifacts({
      projectDir,
      baseDir: code,
      project: 'brad/demo',
      fetchImpl: f,
      authHeaders: testAuth,
    });

    expect(result).toEqual({ project: 'brad/demo', gitUrl: remoteDir, synced: true });
    // Fresh repo ADOPTED the remote's main (no unrelated local root commit).
    const { repoDir } = artifactPaths(projectDir);
    expect(g(repoDir, 'show main:README.md')).toBe('remote artifacts history');
    // Managed marker → syncArtifacts will take the managed path from now on.
    expect(await getManagedArtifactsProject(projectDir)).toBe('brad/demo');
    // Committed pointer in the code repo.
    expect(readArtifactsPointerConfig(code)).toEqual({ project: 'brad/demo' });
    // Short-lived git token installed as extraheader.
    expect(g(repoDir, `config --get ${JSON.stringify(`http.${remoteDir}.extraheader`)}`)).toBe('Authorization: Bearer cfa_write_1');
    // Blob store synced: HEAD miss then PUT of our blob.
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(put.url).toContain(`/artifacts/blobs/brad/demo/${blob.oid}`);
    expect(Buffer.from(put.body!).equals(blob.bytes)).toBe(true);
  });
});

describe('syncManagedArtifacts', () => {
  it('refreshes an expired git token before syncing and pushes branches + blobs', async () => {
    const remoteDir = makeRemoteWithHistory();
    const code = join(projectDir, 'base');
    mkdirSync(code, { recursive: true });
    execSync(`git init -q ${JSON.stringify(code)}`);
    const { fetch: f } = workerFetchFor(remoteDir);
    await setupManagedArtifacts({ projectDir, baseDir: code, project: 'brad/demo', fetchImpl: f, authHeaders: testAuth, sync: false });

    // Capture on a workspace branch so the sync has something to push.
    const ws = join(projectDir, 'workspaces', 'feat');
    mkdirSync(ws, { recursive: true });
    const mount = await ensureArtifactsMount(projectDir, ws, 'feat');
    await captureArtifacts(projectDir, mount, [{ path: 'notes.md', content: 'hi' }]);

    // Simulate an expired stored token.
    const { repoDir } = artifactPaths(projectDir);
    g(repoDir, `config gitspace.artifactsTokenExpires ${Date.now() - 1000}`);

    const result = await syncManagedArtifacts(projectDir, 'brad/demo', { fetchImpl: f, authHeaders: testAuth });
    expect(result.pushed).toBe(true);
    expect(result.blobs).toEqual({ total: 0, uploaded: 0, alreadyPresent: 0, failed: 0 });
    // Expired token was re-minted via GET /artifacts/token and re-installed.
    expect(g(repoDir, `config --get ${JSON.stringify(`http.${remoteDir}.extraheader`)}`)).toBe('Authorization: Bearer cfa_write_fresh');
    // Branch actually landed on the "managed" remote.
    expect(g(remoteDir, 'branch --list feat')).not.toBe('');
  });
});
