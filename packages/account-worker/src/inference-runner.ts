import { attemptEvents, type AttemptRunner } from '@gitspace/runtime-core/inference';
import type { Inference } from '@gitspace/inference-worker/worker';
import { INFERENCE_WORKER_SOURCE, INFERENCE_WORKER_WASM } from './generated/inference-worker.js';
import { WORKER_VERSION } from './tenant-releases.js';

/** The tenant's own compatibility date (`wrangler.jsonc`): the inference worker ships in the same release. */
const COMPATIBILITY_DATE = '2026-08-27';
const wasm = Uint8Array.from(atob(INFERENCE_WORKER_WASM), character => character.charCodeAt(0));

/**
 * Runs a workspace's request attempts in its inference worker (`packages/inference-worker`), loaded from this release
 * by the tenant's Worker Loader as `inference:<workspace>:<release>`: its own isolate, holding each request's body and
 * images instead of the workspace object. It reads images through this workspace's `ImageReader` only.
 */
export function inferenceWorkerRunner(ctx: DurableObjectState, env: Env, workspaceId: string): AttemptRunner {
  const reader = ctx.exports.ImageReader({ props: { workspaceId } });
  const worker = () => env.CODEMODE_LOADER.get(`inference:${workspaceId}:${WORKER_VERSION ?? 'development'}`, () => ({
    compatibilityDate: COMPATIBILITY_DATE, compatibilityFlags: ['nodejs_compat'], mainModule: 'inference.js',
    modules: { 'inference.js': INFERENCE_WORKER_SOURCE, 'xxhash.wasm': { wasm } },
    env: { READER: reader },
  }));
  return async function* (attempt, signal) {
    signal?.throwIfAborted();
    const stream = await worker().getEntrypoint<Inference>('Inference').run(attempt);
    yield* attemptEvents(stream, signal);
  };
}
