import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { nativeAbiSchema, type NativeAbi } from '@gitspace/protocol/deployment';
import type { PortableFile, PortableManifest } from '@gitspace/protocol/machine-release';
import { currentDistributionPlatform, versionAtLeast } from './distribution.js';
import { createExecutableArtifactManifest, nativeHostAbi } from './executable-manifest.js';
import { compileMachineBundles } from './machine-compile.js';
import { packageMachineNativeRuntime, type NativeSource, type PlatformNatives } from './native-build.js';

/** Where a portable release keeps a machine generation's files. */
const MACHINE_FILES = 'machine/';

/** The native ABI a generation of `pins` needs here: on Linux the newest glibc its tools name (2.17 when they are
 * static); on macOS this host's own version, as a release built on it records. */
function pinnedNativeAbi(pins: PlatformNatives): NativeAbi {
  if (process.platform !== 'linux') return nativeHostAbi();
  let minimumVersion = '2.17';
  for (const pin of [pins.rg, pins['git-lfs']]) if (pin.abi.os === 'linux' && pin.abi.glibc && versionAtLeast(pin.abi.glibc, minimumVersion)) minimumVersion = pin.abi.glibc;
  return nativeAbiSchema.parse({ platform: 'linux', arch: process.arch, minimumVersion });
}

/**
 * Builds this host's machine generation from a portable release in `output`, a new empty directory: the release's
 * machine files (`file` answers each one's bytes, checked against the manifest), this platform's pinned natives
 * (`archive` answers each pinned upstream archive), its machine process and worker compiled for this Bun, and the
 * generation's manifest beside it (`executableManifestPath`). A release for another Bun is refused: its JavaScript and
 * bytecode are built for its own.
 */
export async function assembleMachineGeneration(options: { manifest: PortableManifest; file(file: PortableFile): Promise<Uint8Array>; archive: NativeSource['archive']; output: string }) {
  const { manifest, output } = options;
  if (manifest.bunVersion !== Bun.version) throw new Error(`This release runs on Bun ${manifest.bunVersion}; this machine runs Bun ${Bun.version}`);
  const pins = manifest.natives[currentDistributionPlatform()];
  for (const file of manifest.files) {
    if (!file.path.startsWith(MACHINE_FILES)) continue;
    const bytes = await options.file(file);
    if (bytes.byteLength !== file.size) throw new Error(`Portable file ${file.path} is ${bytes.byteLength} bytes, not ${file.size}`);
    const path = join(output, file.path.slice(MACHINE_FILES.length));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes, { flag: 'wx' });
  }
  const native = await packageMachineNativeRuntime(output, { pins, archive: options.archive }, pinnedNativeAbi(pins));
  await compileMachineBundles(output);
  return createExecutableArtifactManifest(output, 'machine', native.abi);
}
