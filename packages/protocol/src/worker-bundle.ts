import { Result, TaggedError } from 'better-result';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { workerBundleSchema, type WorkerBundle } from './deployment.js';

export class WorkerBundleError extends TaggedError('WorkerBundleError')<{ message: string }> {}
export type WorkerModule = { name: string; type: WorkerBundle['modules'][number]['type']; content: Uint8Array<ArrayBuffer> };

export function encodeWorkerBundle(modules: readonly WorkerModule[]): Uint8Array<ArrayBuffer> {
  const bundle = workerBundleSchema.parse({ version: 1, modules: modules.map(module => {
    let binary = '';
    for (let offset = 0; offset < module.content.byteLength; offset += 8192) binary += String.fromCharCode(...module.content.subarray(offset, offset + 8192));
    return { name: module.name, type: module.type, bytes: module.content.byteLength, hash: `sha256:${bytesToHex(sha256(module.content))}`, base64: btoa(binary) };
  }) });
  return new TextEncoder().encode(JSON.stringify(bundle));
}

/** Validate module identity and bytes before any provider upload or rollback. */
export function decodeWorkerBundle(bytes: ArrayBuffer, mainModule: string) {
  return Result.try({ try: () => {
    const bundle = workerBundleSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    const modules: WorkerModule[] = bundle.modules.map(module => {
      const content = Uint8Array.from(atob(module.base64), character => character.charCodeAt(0));
      if (content.byteLength !== module.bytes || `sha256:${bytesToHex(sha256(content))}` !== module.hash) throw new Error(`Worker module integrity mismatch: ${module.name}`);
      if (module.type === 'wasm' && (content[0] !== 0 || content[1] !== 97 || content[2] !== 115 || content[3] !== 109)) throw new Error(`Invalid WASM module: ${module.name}`);
      return { name: module.name, type: module.type, content };
    });
    if (!modules.some(module => module.name === mainModule && module.type === 'esm')) throw new Error('Worker bundle has no declared main module');
    return modules;
  }, catch: error => new WorkerBundleError({ message: error instanceof Error ? error.message : String(error) }) });
}
