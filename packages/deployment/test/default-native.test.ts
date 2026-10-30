import { expect, test } from 'bun:test';
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
test('native publication refuses a platform label inconsistent with executable ABI', () => {
  expect(() => createDefaultNativeArtifact(commit, 'release-1', 'darwin-arm64', manifest)).toThrow('platform');
});
