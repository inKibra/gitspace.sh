import { expect, test } from 'bun:test';
import { defaultMachineRelease, defaultMachineObject } from '@gitspace/protocol/default-release';
import { defaultObject } from '../src/default-release.js';
import { createDefaultNativeArtifact } from '../src/default-native.js';

const commit = 'a'.repeat(40);
const bytes = new TextEncoder().encode('machine source');
const hash = `sha256:${defaultObject('ignored', bytes).sha256}`;
const manifest = {
  version: 1, target: 'machine', inferenceVersion: 1, entrypoint: 'machine.js',
  compatibility: { platform: 'linux', arch: 'x64', bunVersion: '1.4.0', protocolVersion: 1, nativeAbi: { platform: 'linux', arch: 'x64', minimumVersion: '2.35' } },
  treeHash: hash, files: [{ path: 'machine.js', hash, size: bytes.byteLength, mode: 420, chunks: [{ key: `objects/sha256/${hash.slice(7)}`, hash, size: bytes.byteLength }] }], omp: null,
};
test('native default bridge serves only authenticated manifest/chunks for the reported platform', async () => {
  const native = createDefaultNativeArtifact(commit, 'release-1', 'linux-x64', manifest);
  const objects = new Map<string, Uint8Array>([[native.artifact.key, new TextEncoder().encode(JSON.stringify(manifest))], [native.chunks[0]!.key, bytes]]);
  const reader = { async get(key: string) { const bytes = objects.get(key); return bytes ? { bytes, etag: 'fixture' } : null; } };
  const release = { commit, machines: [native] };
  expect(await defaultMachineRelease(reader, release, { platform: 'linux-x64' })).toMatchObject({ sha: `${commit}-linux-x64`, artifact: { key: native.artifact.key, hash: `sha256:${native.artifact.sha256}` } });
  expect(await defaultMachineObject(reader, release, native.chunks[0]!.key)).toEqual(bytes);
  await expect(defaultMachineObject(reader, release, 'tenants/other/secret')).rejects.toThrow('not part');
  await expect(defaultMachineRelease(reader, release, { platform: 'darwin-arm64' })).rejects.toThrow('platform');
  objects.set(native.artifact.key, new TextEncoder().encode('tampered'));
  await expect(defaultMachineRelease(reader, release, { platform: 'linux-x64' })).rejects.toThrow('integrity');
});
test('native publication refuses a platform label inconsistent with executable ABI', () => {
  expect(() => createDefaultNativeArtifact(commit, 'release-1', 'darwin-arm64', manifest)).toThrow('platform');
});
