#!/usr/bin/env bun
import { GetObjectCommand, PutObjectCommand, S3ServiceException } from '@aws-sdk/client-s3';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { buildWorkerBundle, buildFrontendTree, workerMetadataFromWrangler, workspaceSha } from './builders.js';
import { releaseStorageClient } from './release.js';
import { buildDefaultRelease, publishDefaultRelease, rollbackDefaultRelease, type DefaultReleaseStorage } from './default-release.js';
import { defaultCommitSchema, defaultReleaseSchema, defaultNativeArtifactSchema } from '@gitspace/protocol/default-release';
import { DISTRIBUTION_PLATFORMS } from './distribution.js';

export function defaultReleaseStorage(bucket: string): DefaultReleaseStorage & { close(): void } {
  const client = releaseStorageClient();
  const signal = AbortSignal.timeout(10 * 60_000);
  return {
    async get(Key) {
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(60_000)]);
      try {
        const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key }), { abortSignal: deadline });
        if (!response.Body || !response.ETag) throw new Error(`Release object has no body or ETag: ${Key}`);
        const chunks: Uint8Array[] = [];
        await response.Body.transformToWebStream().pipeTo(new WritableStream<Uint8Array>({ write(chunk) { chunks.push(chunk); } }), { signal: deadline });
        return { bytes: Buffer.concat(chunks), etag: response.ETag };
      } catch (error) {
        if (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 404) return null;
        throw error;
      }
    },
    async put(Key, bytes, expectedEtag) {
      await client.send(new PutObjectCommand({ Bucket: bucket, Key, Body: bytes, ContentType: 'application/octet-stream', ContentLength: bytes.byteLength, ...(expectedEtag === null ? { IfNoneMatch: '*' } : { IfMatch: expectedEtag }) }), { abortSignal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]) });
    },
    close() { client.destroy(); },
  };
}
async function files(root: string, prefix = ''): Promise<{ path: string; bytes: Uint8Array; contentType: string }[]> {
  const result: { path: string; bytes: Uint8Array; contentType: string }[] = [];
  for (const entry of (await readdir(join(root, prefix), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) result.push(...await files(root, path));
    else if (entry.isFile()) { const file = Bun.file(join(root, path)); result.push({ path, bytes: new Uint8Array(await file.arrayBuffer()), contentType: file.type || 'application/octet-stream' }); }
    else throw new Error(`Frontend contains a non-regular path: ${path}`);
  }
  return result;
}
export async function runDefaultRelease(args: string[]): Promise<void> {
  if (args.includes('--help') || args.length === 0) {
    console.log('Usage: bun packages/deployment/src/default-release-cli.ts build --commit <40hex> --image <registry/repository> --native <native-builds-directory> [--root <checkout>] [--out <directory>] [--publish --bucket <R2 bucket>]\n       bun packages/deployment/src/default-release-cli.ts publish --from <saved directory> --commit <40hex> --bucket <R2 bucket>\n       bun packages/deployment/src/default-release-cli.ts rollback --bucket <R2 bucket>\n       bun packages/deployment/src/default-release-cli.ts --fake\nBuild requires a clean checkout at --commit. --native contains darwin-arm64, darwin-x64, linux-arm64 and linux-x64 directories produced by release.ts build on native runners and published with release.ts publish. All four must match --commit. Docker buildx pushes the same-commit OCI image; immutable R2 objects publish only with --publish. Retry with publish --from to reuse exact artifacts without rebuilding. --fake is a local no-network build/publish/rollback smoke.');
    return;
  }
  const option = (name: string) => { const index = args.indexOf(name); return index === -1 ? undefined : args[index + 1]; };
  if (args.includes('--fake')) {
    const objects = new Map<string, { bytes: Uint8Array; etag: string }>();
    let revision = 0;
    const storage: DefaultReleaseStorage = { async get(key) { return objects.get(key) ?? null; }, async put(key, bytes, expected) { const current = objects.get(key); if (expected === null ? !!current : current?.etag !== expected) throw new Error('publication conflict'); objects.set(key, { bytes, etag: String(++revision) }); } };
    for (const commit of ['a'.repeat(40), 'b'.repeat(40)]) {
      const encoder = new TextEncoder();
      const build = await buildDefaultRelease(commit, {
        verifyCommit: async () => commit,
        worker: async () => ({ commit, version: commit, bytes: encoder.encode(`worker:${commit}`), metadata: { mainModule: 'worker.mjs', compatibilityDate: '2026-01-01', compatibilityFlags: [], durableObjects: [], resources: [], migrations: [] } }),
        frontend: async () => ({ commit, files: [{ path: 'index.html', bytes: encoder.encode(commit), contentType: 'text/html' }] }),
        image: async () => ({ commit, image: `registry.example.com/gitspace@sha256:${'c'.repeat(64)}`, provenance: encoder.encode(JSON.stringify({ commit, image: `registry.example.com/gitspace@sha256:${'c'.repeat(64)}` })) }),
      });
      await publishDefaultRelease(build, storage);
    }
    await rollbackDefaultRelease(storage);
    console.log('Fake coherent build, publication, replacement and rollback succeeded (no network).');
    return;
  }
  const bucket = option('--bucket');
  if (args[0] === 'rollback') {
    if (!bucket) throw new Error('--bucket is required');
    const storage = defaultReleaseStorage(bucket);
    try { await rollbackDefaultRelease(storage); } finally { storage.close(); }
    return;
  }
  if (args[0] === 'publish') {
    const directory = option('--from');
    const commit = defaultCommitSchema.parse(option('--commit'));
    if (!directory || !bucket) throw new Error('--from and --bucket are required');
    const manifestKey = `defaults/releases/${commit}/manifest.json`;
    const bytes = await readFile(join(resolve(directory), manifestKey));
    const manifest = defaultReleaseSchema.parse(JSON.parse(bytes.toString('utf8')));
    if (manifest.commit !== commit) throw new Error('Saved default release commit mismatch');
    const objects = new Map<string, Uint8Array>([[manifestKey, bytes]]);
    for (const object of [manifest.worker.bundle, ...manifest.frontend.files, manifest.image.provenance]) objects.set(object.key, await readFile(join(resolve(directory), object.key)));
    const storage = defaultReleaseStorage(bucket);
    try { await publishDefaultRelease({ manifest, objects }, storage); } finally { storage.close(); }
    return;
  }
  if (args[0] !== 'build') throw new Error('Expected build, publish, rollback or --fake');
  const root = resolve(option('--root') ?? resolve(import.meta.dir, '../../..'));
  const commit = option('--commit');
  const imageRepository = option('--image');
  if (!commit || !imageRepository || !/^[a-z0-9][a-z0-9./:_-]*$/u.test(imageRepository) || imageRepository.includes('@')) throw new Error('--commit and registry-qualified --image repository are required');
  if (args.includes('--publish') && !bucket) throw new Error('--bucket is required for publication');
  const nativeDirectory = option('--native');
  if (!nativeDirectory) throw new Error('--native must contain the four same-commit published native platform build directories');
  const machines = await Promise.all(DISTRIBUTION_PLATFORMS.map(async platform => {
    const native = defaultNativeArtifactSchema.parse(JSON.parse(await readFile(join(resolve(nativeDirectory), platform, 'native-default.json'), 'utf8')));
    if (native.platform !== platform || native.commit !== commit) throw new Error(`Native platform ${platform} commit mismatch`);
    return native;
  }));
  const temporary = await mkdtemp(join(tmpdir(), 'gitspace-default-release-'));
  try {
    const built = await buildDefaultRelease(commit, {
      verifyCommit: () => workspaceSha(root),
      machines: async () => machines,
      async worker() {
        const artifact = await buildWorkerBundle(root, commit, join(temporary, 'worker'));
        return { commit, version: commit, bytes: new Uint8Array(await Bun.file(artifact.path).arrayBuffer()), metadata: await workerMetadataFromWrangler(root) };
      },
      async frontend() { const artifact = await buildFrontendTree(root, join(temporary, 'frontend')); return { commit, files: await files(artifact.path) }; },
      async image() {
        const metadataPath = join(temporary, 'image.json');
        const tag = `${imageRepository}:${commit}`;
        const command = Bun.spawn(['docker', 'buildx', 'build', '--platform', 'linux/amd64', '--provenance=mode=max', '--label', `org.opencontainers.image.revision=${commit}`, '--metadata-file', metadataPath, '--tag', tag, '--push', '--file', 'packages/sandbox-worker/Dockerfile', '.'], { cwd: root, stdout: 'inherit', stderr: 'inherit' });
        if (await command.exited !== 0) throw new Error('Same-commit image build failed');
        const metadata = z.object({ 'containerimage.digest': z.string().regex(/^sha256:[a-f0-9]{64}$/u) }).passthrough().parse(JSON.parse(await readFile(metadataPath, 'utf8')));
        const image = `${imageRepository}@${metadata['containerimage.digest']}`;
        return { commit, image, provenance: new TextEncoder().encode(JSON.stringify({ commit, image, builder: 'docker-buildx', metadata })) };
      },
    });
    const out = resolve(option('--out') ?? join(root, '.gitspace/default-release', commit));
    for (const [key, bytes] of built.objects) { const path = join(out, key); await mkdir(join(path, '..'), { recursive: true }); await Bun.write(path, bytes); }
    if (args.includes('--publish')) {
      if (!bucket) throw new Error('--bucket is required');
      const storage = defaultReleaseStorage(bucket);
      try { await publishDefaultRelease(built, storage); } finally { storage.close(); }
    }
    console.log(JSON.stringify({ commit, out, image: built.manifest.image.image, published: args.includes('--publish') }));
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
if (import.meta.main) await runDefaultRelease(process.argv.slice(2));
