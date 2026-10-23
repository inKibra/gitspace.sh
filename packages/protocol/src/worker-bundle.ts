import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { workerManifestSchema, type WorkerManifest } from './deployment.js';

export type WorkerModule = { name: string; type: WorkerManifest['modules'][number]['type']; content: Uint8Array<ArrayBuffer> };

/** The manifest pinning each module's size and digest; `mainModule` names the entry ESM module. */
export function createWorkerManifest(mainModule: string, modules: readonly WorkerModule[]): WorkerManifest {
  return workerManifestSchema.parse({
    version: 2,
    mainModule,
    modules: modules.map(module => ({ name: module.name, type: module.type, size: module.content.byteLength, sha256: bytesToHex(sha256(module.content)) })),
  });
}
