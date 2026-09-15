import { afterEach, expect, test } from 'bun:test';
import { S3Client, type GetObjectCommandOutput } from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { publishDistribution } from '../src/release.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

async function fixture(clientBytes = new Uint8Array([1, 2, 3])) {
  const directory = await mkdtemp(join(tmpdir(), 'distribution-publisher-'));
  const files = [
    'host.js', 'host-runtime.js', 'rpc-probe.js', 'omp-launcher.js', 'bin/bun', 'bin/omp',
    'machine/machine.js', 'machine/machine-worker.js', 'machine/machine-native.json', 'machine/native/walgit',
    'machine.manifest.json', 'omp/omp.js', 'omp/omp-adapter.js', 'omp/omp-runtime.json',
    'omp/package.json', 'omp/bun.lock', 'omp.manifest.json',
  ];
  const fileBytes = Buffer.from('fixture');
  const runtime = gzipSync(Buffer.concat(files.map(() => fileBytes)));
  const provenance = Buffer.from('{"source":"fixture"}');
  const manifest = {
    schemaVersion: 1, release: 'publisher-fixture', platform: 'linux-x64', bunVersion: '1.4.0', minimumGlibc: '2.39',
    client: { sha256: createHash('sha256').update(clientBytes).digest('hex'), size: clientBytes.byteLength },
    runtime: {
      sha256: createHash('sha256').update(runtime).digest('hex'), size: runtime.byteLength,
      files: files.map(path => ({ path, sha256: createHash('sha256').update(fileBytes).digest('hex'), size: fileBytes.byteLength,
        mode: ['bin/bun', 'bin/omp', 'machine/native/walgit'].includes(path) ? 0o755 : 0o644 })),
    },
    provenance: { sha256: createHash('sha256').update(provenance).digest('hex'), size: provenance.byteLength },
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const channel = { schemaVersion: 1, release: manifest.release, platform: manifest.platform,
    manifest: { sha256: createHash('sha256').update(manifestBytes).digest('hex'), size: manifestBytes.byteLength } };
  await Promise.all(Object.entries({
    gitspace: clientBytes, 'runtime.bin.gz': runtime, 'provenance.json': provenance, 'manifest.json': manifestBytes,
    'channel.json': JSON.stringify(channel), 'channel.txt': `gitspace-distribution-v1\n${manifest.release}\n${manifest.client.sha256}\n`,
  }).map(([name, bytes]) => writeFile(join(directory, name), bytes)));
  const prefix = `distribution/v1/releases/${manifest.release}/${manifest.platform}/`;
  const objects = new Map<string, Uint8Array<ArrayBuffer>>();
  const uploads = new Map<string, Map<number, Buffer<ArrayBuffer>>>();
  const mutations: string[] = [];
  const state: { intercept?: (request: Request, key: string) => Response | Promise<Response> | undefined } = {};
  const server = Bun.serve({ port: 0, async fetch(request) {
    const url = new URL(request.url);
    const key = decodeURIComponent(url.pathname.slice('/fixture/'.length));
    const override = state.intercept?.(request, key);
    if (override) return override;
    if (request.method === 'GET') {
      const body = objects.get(key);
      return body ? new Response(body) : new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 });
    }
    if (request.method === 'POST' && url.searchParams.has('uploads')) {
      uploads.set(key, new Map());
      return new Response('<InitiateMultipartUploadResult><UploadId>fixture-upload</UploadId></InitiateMultipartUploadResult>', { headers: { 'content-type': 'application/xml' } });
    }
    if (request.method === 'PUT' && url.searchParams.has('partNumber')) {
      const part = Number(url.searchParams.get('partNumber'));
      uploads.get(key)?.set(part, Buffer.from(await request.arrayBuffer()));
      return new Response(null, { headers: { etag: `"part-${part}"` } });
    }
    if (request.method === 'DELETE' && url.searchParams.has('uploadId')) {
      uploads.delete(key);
      return new Response(null, { status: 204 });
    }
    if (request.headers.get('if-none-match') === '*' && objects.has(key)) {
      return new Response('<Error><Code>PreconditionFailed</Code></Error>', { status: 412 });
    }
    if (request.method === 'POST' && url.searchParams.has('uploadId')) {
      const parts = [...(await request.text()).matchAll(/<PartNumber>(\d+)<\/PartNumber>/gu)].map(match => Number(match[1]));
      if (parts.some((part, index) => part !== index + 1)) return new Response('<Error><Code>InvalidPartOrder</Code></Error>', { status: 400 });
      const uploaded = uploads.get(key);
      if (!uploaded || parts.some(part => !uploaded.has(part))) return new Response('<Error><Code>InvalidPart</Code></Error>', { status: 400 });
      objects.set(key, Buffer.concat(parts.map(part => uploaded.get(part)!)));
      uploads.delete(key);
      mutations.push(key);
      return new Response('<CompleteMultipartUploadResult><ETag>"complete"</ETag></CompleteMultipartUploadResult>', { headers: { 'content-type': 'application/xml' } });
    }
    if (request.method === 'PUT') {
      objects.set(key, new Uint8Array(await request.arrayBuffer()));
      mutations.push(key);
      return new Response(null, { headers: { etag: '"complete"' } });
    }
    return new Response(null, { status: 405 });
  } });
  const client = new S3Client({ endpoint: server.url.href, region: 'auto', forcePathStyle: true, maxAttempts: 1,
    credentials: { accessKeyId: 'fixture', secretAccessKey: 'fixture' },
    requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' });
  cleanup.push(async () => { client.destroy(); server.stop(true); await rm(directory, { recursive: true, force: true }); });
  return { directory, client, prefix, objects, uploads, mutations, state, clientBytes, runtime, provenance, manifestBytes };
}

test('resumes a partial release, verifies multipart bytes, and leaves channels untouched', async () => {
  const f = await fixture(new Uint8Array(9 * 1024 * 1024).fill(7));
  f.objects.set(`${f.prefix}provenance.json`, f.provenance);
  const stableKey = 'distribution/v1/stable/linux-x64.json';
  const stable = Buffer.from('{"release":"previous"}');
  f.objects.set(stableKey, stable);
  await publishDistribution(f.directory, false, { client: f.client, bucket: 'fixture' });
  expect(f.objects.get(`${f.prefix}gitspace`)).toEqual(f.clientBytes);
  expect(f.objects.get(`${f.prefix}runtime.bin.gz`)).toEqual(f.runtime);
  expect(f.objects.get(`${f.prefix}manifest.json`)).toEqual(f.manifestBytes);
  expect(f.objects.get(stableKey)).toEqual(stable);
  expect(f.mutations.at(-1)).toBe(`${f.prefix}manifest.json`);
  expect(f.mutations).not.toContain(`${f.prefix}provenance.json`);
  f.mutations.length = 0;
  await publishDistribution(f.directory, false, { client: f.client, bucket: 'fixture' });
  expect(f.mutations).toEqual([]);
});

for (const stage of ['headers', 'body'] as const) {
  test(`cancels a stalled ${stage} response instead of leaving publication pending`, async () => {
    const f = await fixture();
    const controller = new AbortController();
    if (stage === 'body') {
      f.client.middlewareStack.add(next => async args => {
        const result = await next(args);
        const output = result.output as GetObjectCommandOutput;
        if (output.Body) {
          const toWebStream = output.Body.transformToWebStream.bind(output.Body);
          output.Body.transformToWebStream = () => toWebStream().pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, stream) { stream.enqueue(chunk); controller.abort(); },
          }));
        }
        return result;
      }, { step: 'initialize' });
    }
    f.state.intercept = () => {
      if (stage === 'headers') controller.abort();
      return stage === 'headers' ? new Promise<Response>(() => {}) : new Response(new ReadableStream({
        start(stream) { stream.enqueue(new Uint8Array([123])); },
      }));
    };
    await expect(publishDistribution(f.directory, false, { client: f.client, bucket: 'fixture', signal: controller.signal }))
      .rejects.toThrow('deadline exceeded or cancelled');
    expect(f.mutations).toEqual([]);
  }, 1000);
}

test('aborts an unfinished multipart upload after cancellation, without committing a manifest', async () => {
  const f = await fixture(new Uint8Array(9 * 1024 * 1024).fill(7));
  const controller = new AbortController();
  let stalled = false;
  f.state.intercept = request => {
    if (new URL(request.url).searchParams.has('partNumber')) {
      stalled = true;
      controller.abort();
      return new Promise<Response>(() => {});
    }
  };
  await expect(publishDistribution(f.directory, false, { client: f.client, bucket: 'fixture', signal: controller.signal }))
    .rejects.toThrow('deadline exceeded or cancelled');
  expect(stalled).toBe(true);
  expect(f.uploads.size).toBe(0);
  expect(f.objects.has(`${f.prefix}manifest.json`)).toBe(false);
  expect(f.mutations).toEqual([]);
}, 2000);

test('rejects mismatched retained objects rather than overwriting or publishing them', async () => {
  const f = await fixture();
  f.objects.set(`${f.prefix}gitspace`, new Uint8Array([9, 9, 9]));
  await expect(publishDistribution(f.directory, false, { client: f.client, bucket: 'fixture' })).rejects.toThrow('integrity mismatch');
  expect(f.objects.get(`${f.prefix}gitspace`)).toEqual(new Uint8Array([9, 9, 9]));
  expect(f.objects.has(`${f.prefix}manifest.json`)).toBe(false);
  expect(f.mutations).toEqual([]);
});
