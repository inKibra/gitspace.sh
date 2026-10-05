import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { authorized, boundedBody, lfsPointer, lfsRoundTrip, maxBytes, sha256 } from '../live-check/protocol.js';
import type { ArtifactsFetch } from '../src/artifacts-snapshot.js';

const hash = 'a'.repeat(40);
const authorization = {
  authorize: 'create-disposable-fork-and-upload-lfs', namespace: 'fixture', sourceRepository: 'source', forkRepository: 'disposable',
  checkpoint: { checkpointRef: 'refs/gitspace/spaces/source/checkpoints', headCommit: hash, branch: 'main', indexCommit: hash, trackedWorktreeCommit: hash, worktreeCommit: hash, indexTree: hash, worktreeTree: hash },
  probePath: 'README.md', probeSha256: 'b'.repeat(64),
};
const bytes = new TextEncoder().encode('real synthetic LFS payload\n');
const remote = 'https://git.example.invalid/repository.git';
const token = 'SECRET-REPOSITORY-TOKEN';
const identity = { oid: sha256(bytes), size: bytes.byteLength };

function fixture(options: { upload?: string; download?: string; corrupt?: boolean; missingUpload?: boolean; missingDownload?: boolean; objectError?: boolean; identityMismatch?: boolean; redirect?: boolean; crossOriginToken?: boolean; status?: number } = {}) {
  const calls: { url: string; method: string; authorization: string | null; redirect: RequestRedirect | undefined }[] = [];
  let uploaded: Uint8Array<ArrayBuffer> | undefined;
  const request: ArtifactsFetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? 'GET', authorization: new Headers(init?.headers).get('authorization'), redirect: init?.redirect });
    if (url.endsWith('/objects/batch')) {
      if (options.status) return new Response(null, { status: options.status });
      const requestBody = z.object({ operation: z.enum(['upload', 'download']) }).parse(await new Response(init?.body).json());
      const operation = requestBody.operation;
      const action = { href: operation === 'upload' ? options.upload ?? 'https://storage.example.invalid/upload' : options.download ?? 'https://storage.example.invalid/download', header: options.crossOriginToken ? { Authorization: `Bearer ${token}` } : { 'X-Action-Credential': 'scoped-action-secret' } };
      return Response.json({ transfer: 'basic', objects: [{ ...identity, ...(options.identityMismatch ? { oid: '0'.repeat(64) } : {}), ...(options.objectError ? { error: { code: 501, message: 'unsupported' } } : {}), actions: operation === 'upload' ? options.missingUpload ? {} : { upload: action, verify: { href: 'https://storage.example.invalid/verify' } } : options.missingDownload ? {} : { download: action } }] });
    }
    if (options.redirect) return new Response(null, { status: 307, headers: { Location: 'https://attacker.example.invalid/' } });
    if (init?.method === 'PUT') { uploaded = new Uint8Array(await new Response(init.body).arrayBuffer()); return new Response(null, { status: 200 }); }
    if (init?.method === 'POST') return new Response(null, { status: 200 });
    return new Response(options.corrupt ? new TextEncoder().encode('corrupted') : uploaded);
  };
  return { request, calls };
}

describe('live Artifacts authorization remains offline by default', () => {
  test('no opt-in cannot acquire bindings or issue requests even with valid inputs', async () => {
    let acquired = false;
    await expect(authorized(false, authorization, async () => { acquired = true; })).rejects.toThrow('Explicit --authorize-live');
    expect(acquired).toBe(false);
  });
  test('invalid authorization and source-as-fork fail before acquiring bindings', async () => {
    let acquired = false;
    for (const input of [{}, { ...authorization, forkRepository: 'source' }, { ...authorization, probeSha256: '' }, { ...authorization, probePath: '../secret' }]) {
      await expect(authorized(true, input, async () => { acquired = true; })).rejects.toThrow();
    }
    expect(acquired).toBe(false);
  });
});

describe('real LFS payload protocol', () => {
  test('uploads bytes, verifies, downloads and checks SHA256/size without forwarding repository credentials', async () => {
    const server = fixture();
    const result = await lfsRoundTrip(remote, token, bytes, server.request);
    expect(result).toEqual({ ...identity, downloadedSha256: identity.oid, downloadedSize: identity.size, uploaded: true, verified: true });
    expect(lfsPointer(bytes)).toBe(`version https://git-lfs.github.com/spec/v1\noid sha256:${identity.oid}\nsize ${identity.size}\n`);
    expect(server.calls.map(call => [call.method, call.authorization])).toEqual([
      ['POST', `Bearer ${token}`], ['PUT', null], ['POST', null], ['POST', `Bearer ${token}`], ['GET', null],
    ]);
    expect(server.calls.every(call => call.redirect === 'error')).toBe(true);
  });
  test('unsupported LFS fails rather than skipping', async () => {
    await expect(lfsRoundTrip(remote, token, bytes, fixture({ status: 404 }).request)).rejects.toThrow('batch failed (404)');
    await expect(lfsRoundTrip(remote, token, bytes, fixture({ objectError: true }).request)).rejects.toThrow('object rejected (501)');
    await expect(lfsRoundTrip(remote, token, bytes, fixture({ missingUpload: true }).request)).rejects.toThrow('upload action missing');
    await expect(lfsRoundTrip(remote, token, bytes, fixture({ missingDownload: true }).request)).rejects.toThrow('download action missing');
  });
  test('rejects wrong identity and corrupt downloaded payloads', async () => {
    await expect(lfsRoundTrip(remote, token, bytes, fixture({ identityMismatch: true }).request)).rejects.toThrow('identity mismatch');
    await expect(lfsRoundTrip(remote, token, bytes, fixture({ corrupt: true }).request)).rejects.toThrow('digest or size mismatch');
  });
  test('unsafe action URLs and credential forwarding fail before sending payload', async () => {
    for (const upload of ['http://storage.example.invalid/upload', 'https://user:password@storage.example.invalid/upload']) {
      const server = fixture({ upload });
      await expect(lfsRoundTrip(remote, token, bytes, server.request)).rejects.toThrow('Unsafe HTTPS');
      expect(server.calls.map(call => call.method)).toEqual(['POST']);
    }
    const server = fixture({ crossOriginToken: true });
    await expect(lfsRoundTrip(remote, token, bytes, server.request)).rejects.toThrow('cannot cross origins');
    expect(server.calls.map(call => call.method)).toEqual(['POST']);
  });
  test('rejects redirects rather than forwarding credentials', async () => {
    const server = fixture({ redirect: true });
    await expect(lfsRoundTrip(remote, token, bytes, server.request)).rejects.toThrow('redirect rejected');
    expect(server.calls.map(call => call.url)).toEqual([`${remote}/info/lfs/objects/batch`, 'https://storage.example.invalid/upload']);
  });
  test('bounds streaming responses even without content-length', async () => {
    const response = new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(maxBytes)); controller.enqueue(new Uint8Array(1)); controller.close(); } }));
    await expect(boundedBody(response)).rejects.toThrow('byte limit');
  });
});
