import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Miniflare } from 'miniflare';
import { buildWorkerRelease } from './builders.js';
import { workerManifestSchema } from '@gitspace/protocol/deployment';

test('production worker builder writes static Rust WASM as its own module and runs the manifest module graph in workerd', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gitspace-worker-wasm-'));
  let worker: Miniflare | undefined;
  try {
    const source = join(directory, 'packages/account-worker/src');
    await mkdir(source, { recursive: true });
    const matcher = new URL('../../protocol-runtime/src/search.ts', import.meta.url).pathname;
    await writeFile(join(source, 'index.ts'), `import { searchSnapshotFiles } from ${JSON.stringify(matcher)}; export default { fetch(){return Response.json(searchSnapshotFiles([{path:'src/a.ts',content:'αβ\\n'}],{pattern:'\\\\p{Greek}+',path:'.'}));} };`);
    const built = await buildWorkerRelease(directory, 'local-only', join(directory, 'bundle'));
    const manifestBytes = await readFile(built.path);
    expect(built.hash).toBe(`sha256:${createHash('sha256').update(manifestBytes).digest('hex')}`);
    const manifest = workerManifestSchema.parse(JSON.parse(manifestBytes.toString('utf8')));
    expect(manifest.mainModule).toBe('worker.mjs');
    expect(manifest.modules.map(module => module.type)).toEqual(['esm', 'wasm']);
    // Every module is a file beside the manifest whose size and digest the manifest pins.
    const modules = await Promise.all(manifest.modules.map(async module => ({ ...module, content: await readFile(join(dirname(built.path), module.name)) })));
    for (const module of modules) {
      expect(module.content.byteLength).toBe(module.size);
      expect(createHash('sha256').update(module.content).digest('hex')).toBe(module.sha256);
    }
    worker = new Miniflare({ modules: modules.map(module => module.type === 'wasm'
      ? { type: 'CompiledWasm', path: join(directory, module.name), contents: module.content }
      : { type: 'ESModule', path: join(directory, module.name), contents: module.content.toString('utf8') }), modulesRoot: directory, compatibilityDate: '2026-03-02', compatibilityFlags: ['nodejs_compat'], outboundService: () => { throw new Error('Live calls forbidden'); } });
    const response = await worker.dispatchFetch('http://proof/');
    expect(await response.json()).toMatchObject({ text: 'src/a.ts:1:αβ' });
  } finally { await worker?.dispose(); await rm(directory, { recursive: true, force: true }); }
}, 30000);
