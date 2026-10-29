// Declares the generated inference worker module (`bun ../inference-worker/src/write.ts`); the module is built per
// release and for tests, never committed.
/** The inference worker as one ES module, with pi-ai and GitSpace's models layer bundled in. */
export declare const INFERENCE_WORKER_SOURCE: string;
/** The XXH64 WebAssembly the module imports as `./xxhash.wasm`, base64. */
export declare const INFERENCE_WORKER_WASM: string;
