import { env } from 'cloudflare:test';
import { ed25519 } from '@noble/curves/ed25519.js';
import { createHash } from 'node:crypto';
import { artifactObjectKey, credentialProtocolBase64, driveScopeKeyPrefix, TENANT_OBJECT_PART_BYTES } from '@gitspace/protocol';
import { describe, expect, it } from 'vitest';
import worker from '../src/index.js';
import { DriveFiles } from '../src/drive-files.js';
import { TenantStore, tenantObjectKey, tenantStore } from '../src/tenant-store.js';
import { workspaceDrive } from '../src/workspace-drive.js';
import { pattern, streamedSha256 } from './drive-bytes.js';
import { tenantRootPrivateKey } from './setup.js';

const sha256 = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

async function fixture() {
  const userId = env.ACCOUNT_ID;
  await env.CREDENTIALS.getByName(userId).bootstrap({ userId, rootPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(tenantRootPrivateKey)), vaultKey: credentialProtocolBase64.encode(crypto.getRandomValues(new Uint8Array(32))) });
  const projectId = crypto.randomUUID();
  const workspaceId = crypto.randomUUID();
  const authority = env.PROJECT_AUTHORITY.getByName(`${userId}:${projectId}`);
  const project = await authority.bootstrap({ id: projectId, name: 'Drive', repositoryReference: null, baseBranch: 'main', createdBy: 'user' });
  const index = env.USER_PROJECTS.getByName(userId);
  await index.put(await authority.setProjectLifecycle(project.revision, 'active'));
  for (const [id, kind] of [[projectId, 'base'], [workspaceId, 'worktree']] as const) {
    await authority.putWorkspace({ id, projectId, kind, name: kind, branch: 'main', phase: kind === 'base' ? null : 'code', sourceKind: 'base', sourceRef: 'main', sourceCommit: null, lifecycle: 'active', goalId: null, expectedRevision: 0 });
    await index.putWorkspaceLocation(id, projectId);
  }
  return { projectId, workspaceId, drive: workspaceDrive(env, { projectId, workspaceId }) };
}

describe('workspace drive', () => {
  it('stores a stream larger than one part as one object as it arrives, and lists, reads and serves it by range', async () => {
    const { workspaceId, drive } = await fixture();
    const size = 40 * 1024 * 1024 + 12;
    const digest = createHash('sha256');
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent === size) return controller.close();
        // Pieces that never line up with a part.
        const piece = pattern(sent, Math.min(3 * 1024 * 1024 + 1, size - sent));
        digest.update(piece);
        sent += piece.byteLength;
        controller.enqueue(piece);
      },
    }, { highWaterMark: 0 });
    const path = 'browser/captures/0a7c/frames.bin';
    const written = await drive.write(path, 'application/octet-stream', body);
    const blobHash = `sha256:${digest.digest('hex')}`;
    expect(written).toEqual({ path, size, blobHash });
    expect(await drive.list('browser/captures/')).toEqual([{ path, size, mediaType: 'application/octet-stream', blobHash }]);
    expect(await drive.list('browser/downloads/')).toEqual([]);
    // One object, named by its upload: its digest was known only after its last byte.
    const scope = `space:${workspaceId}`;
    expect((await env.DATA.list({ prefix: tenantObjectKey(env.ACCOUNT_ID, `${driveScopeKeyPrefix(env.ACCOUNT_ID, scope)}upload/`) })).objects.map(object => object.size)).toEqual([size]);
    expect(await env.DATA.head(tenantObjectKey(env.ACCOUNT_ID, artifactObjectKey(env.ACCOUNT_ID, scope, blobHash)))).toBeNull();

    const boundary = TENANT_OBJECT_PART_BYTES;
    expect(await drive.read(path, { offset: boundary - 6, length: 12 })).toEqual(pattern(boundary - 6, 12));
    await expect(drive.read(path)).rejects.toThrow('by range');
    expect(await drive.read('browser/captures/missing.bin')).toBeNull();

    const url = await drive.url(path);
    expect(url.startsWith(`${env.ACCOUNT_URL}/files/`)).toBe(true);
    const ranged = await worker.fetch(new Request(url, { headers: { range: `bytes=${boundary - 6}-${boundary + 5}` } }), env);
    expect(Object.fromEntries(['content-range', 'content-length', 'etag', 'accept-ranges'].map(name => [name, ranged.headers.get(name)]))).toEqual({
      'content-range': `bytes ${boundary - 6}-${boundary + 5}/${size}`, 'content-length': '12', etag: `"${blobHash}"`, 'accept-ranges': 'bytes',
    });
    expect([ranged.status, new Uint8Array(await ranged.arrayBuffer())]).toEqual([206, pattern(boundary - 6, 12)]);
    expect(new Uint8Array(await (await worker.fetch(new Request(url, { headers: { range: 'bytes=-5' } }), env)).arrayBuffer())).toEqual(pattern(size - 5, 5));
    expect((await worker.fetch(new Request(url, { headers: { range: `bytes=${size}-` } }), env)).status).toBe(416);
    const whole = await worker.fetch(new Request(url), env);
    expect([whole.status, whole.headers.get('content-length')]).toEqual([200, String(size)]);
    expect(await streamedSha256(whole.body!)).toBe(blobHash);
  }, 120_000);

  it('stores a stream that fits one part whole under its digest', async () => {
    const { workspaceId, drive } = await fixture();
    const pieces = [new TextEncoder().encode('date,amount\n'), new TextEncoder().encode('1,2\n3,4\n')];
    const bytes = new Uint8Array([...pieces[0]!, ...pieces[1]!]);
    const body = new ReadableStream<Uint8Array>({ pull(controller) { const piece = pieces.shift(); if (piece) controller.enqueue(piece); else controller.close(); } }, { highWaterMark: 0 });
    const path = 'browser/downloads/2026-10-24/report.csv';
    expect(await drive.write(path, 'text/csv', body)).toEqual({ path, size: bytes.byteLength, blobHash: sha256(bytes) });
    expect(await drive.read(path)).toEqual(bytes);
    expect(await env.DATA.head(tenantObjectKey(env.ACCOUNT_ID, artifactObjectKey(env.ACCOUNT_ID, `space:${workspaceId}`, sha256(bytes))))).not.toBeNull();
  });

  it('resumes an upload across requests in whole parts as they stream in; a retried part and a retried finish change nothing', async () => {
    const { workspaceId, drive } = await fixture();
    const send = (upload: Parameters<typeof drive.append>[0], bytes: Uint8Array<ArrayBuffer>, size = bytes.byteLength) => drive.append(upload, new Blob([bytes]).stream(), size);
    // R2's smallest part, so the test stays small.
    const part = 5 * 1024 * 1024;
    const size = 2 * part + 9;
    const begun = new DriveFiles(tenantStore(env), env.ACCOUNT_ID).begin(`space:${workspaceId}`, { partBytes: part });
    await send(begun, pattern(0, part));
    // The first part's acknowledgement was lost: it is sent again from the same upload.
    const first = await send(begun, pattern(0, part));
    const second = await send(first, pattern(part, part));
    // A part that ends before its declared size is refused, and the upload stays where it was.
    await expect(send(second, pattern(2 * part, 8), 9)).rejects.toThrow('shorter than its declared size');
    const last = await send(second, pattern(2 * part, 9));
    await expect(send(last, pattern(size, 1))).rejects.toThrow('Only the last part');
    const path = 'browser/captures/1b2d/video.webm';
    const finished = await drive.finish(last, path, 'video/webm');
    expect(finished).toEqual({ path, size, blobHash: sha256(pattern(0, size)) });
    expect(await drive.finish(last, path, 'video/webm')).toEqual(finished);
    expect(await drive.read(path, { offset: part - 3, length: 6 })).toEqual(pattern(part - 3, 6));
    // Compared by digest: a deep equality of megabytes exhausts the test runtime's memory.
    expect(sha256((await drive.read(path))!)).toBe(sha256(pattern(0, size)));

    // An upload of one short part is a whole file under its digest.
    const note = new TextEncoder().encode('one short part');
    const whole = await drive.finish(await send(await drive.upload(), note), 'browser/captures/1b2d/note.txt', 'text/plain');
    expect(whole).toEqual({ path: 'browser/captures/1b2d/note.txt', size: note.byteLength, blobHash: sha256(note) });
    expect(await drive.read('browser/captures/1b2d/note.txt')).toEqual(note);
  }, 60_000);

  it('completes a multipart drive file in a workspace scope although R2 returns no metadata from complete', async () => {
    const { workspaceId } = await fixture();
    // Deployed R2 answers `complete` with an object missing its custom metadata (workers-sdk#5936); the local one does
    // not, so the test bucket drops it.
    const withoutCompletedMetadata = (upload: R2MultipartUpload) => new Proxy(upload, {
      get(target, property) {
        if (property === 'complete') return async (parts: R2UploadedPart[]) => new Proxy(await target.complete(parts), { get: (object, key) => key === 'customMetadata' ? {} : Reflect.get(object, key) });
        const value: unknown = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const bucket = new Proxy(env.DATA, {
      get(target, property) {
        if (property === 'resumeMultipartUpload') return (key: string, uploadId: string) => withoutCompletedMetadata(target.resumeMultipartUpload(key, uploadId));
        const value: unknown = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const scope = `space:${workspaceId}`;
    const files = new DriveFiles(new TenantStore(bucket, env.ACCOUNT_ID, async name => new Uint8Array(await env.CREDENTIALS.getByName(env.ACCOUNT_ID).scopeKey(name))), env.ACCOUNT_ID);
    const part = 5 * 1024 * 1024;
    const size = part + 9;
    const blobHash = sha256(pattern(0, size));
    // Declared first (an Inspector upload) and streamed (a capture): both complete as one object.
    const declared = await files.append(await files.append(files.begin(scope, { declared: { sha256: blobHash, size }, partBytes: part }), pattern(0, part)), pattern(part, 9));
    expect(await files.finish(declared)).toEqual({ blobHash, size });
    const streamed = await files.append(await files.append(files.begin(scope, { partBytes: part }), pattern(0, part)), pattern(part, 9));
    const file = await files.finish(streamed);
    expect(file).toMatchObject({ blobHash, size });
    const reader = new DriveFiles(tenantStore(env), env.ACCOUNT_ID);
    for (const ref of [{ blobHash }, file]) expect(await reader.head(scope, ref)).toEqual({ scope, sha256: blobHash, size });
  }, 60_000);
});
