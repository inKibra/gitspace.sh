import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Miniflare } from 'miniflare';
import { buildWorkerBundle } from './builders.js';
import { decodeWorkerBundle } from '@gitspace/protocol/worker-bundle';
import { workerBundleSchema } from '@gitspace/protocol/deployment';

test('production worker builder packages static Rust WASM and runs the uploaded module graph in workerd', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gitspace-worker-wasm-'));
  let worker: Miniflare | undefined;
  try {
    const source = join(directory, 'packages/account-worker/src');
    await mkdir(source, { recursive: true });
    const matcher = new URL('../../protocol-runtime/src/search.ts', import.meta.url).pathname;
    await writeFile(join(source, 'index.ts'), `import { searchSnapshotFiles } from ${JSON.stringify(matcher)}; export default { fetch(){return Response.json(searchSnapshotFiles([{path:'src/a.ts',content:'αβ\\n'}],{pattern:'\\\\p{Greek}+',path:'.'}));} };`);
    const built = await buildWorkerBundle(directory, 'local-only', join(directory, 'bundle'));
    const bytes = await Bun.file(built.path).arrayBuffer();
    const artifact = workerBundleSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
    expect(artifact.modules.some(module => module.type === 'wasm')).toBe(true);
    const decoded = decodeWorkerBundle(bytes, 'worker.mjs');
    if (decoded.isErr()) throw decoded.error;
    worker = new Miniflare({ modules: decoded.value.map(module => module.type === 'wasm'
      ? { type: 'CompiledWasm', path: join(directory, module.name), contents: module.content }
      : { type: 'ESModule', path: join(directory, module.name), contents: new TextDecoder().decode(module.content) }), modulesRoot: directory, compatibilityDate: '2026-03-02', compatibilityFlags: ['nodejs_compat'], outboundService: () => { throw new Error('Live calls forbidden'); } });
    const response = await worker.dispatchFetch('http://proof/');
    expect(await response.json()).toMatchObject({ text: 'src/a.ts:1:αβ' });
    const wasm = artifact.modules.find(module => module.type === 'wasm');
    if (!wasm) throw new Error('Missing static wasm module');
    wasm.base64 = btoa('corrupted wasm');
    expect(decodeWorkerBundle(new TextEncoder().encode(JSON.stringify(artifact)).buffer, 'worker.mjs').isErr()).toBe(true);
  } finally { await worker?.dispose(); await rm(directory, { recursive: true, force: true }); }
}, 30000);
