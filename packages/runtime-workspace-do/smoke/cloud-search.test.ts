import { test, expect } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Miniflare } from 'miniflare';
import { searchWasmModule } from './search-wasm.js';

test('code search indexes changed blobs off the request path and matches the JS reference in workerd SQLite', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gitspace-code-search-'));
  let worker: Miniflare | undefined;
  try {
    const entrypoint = new URL('./cloud-search-fixture.ts', import.meta.url).pathname;
    const output = join(directory, 'fixture.js');
    const bundle = Bun.spawn([process.execPath, 'build', entrypoint, '--target=browser', '--conditions=workerd', '--external=*.wasm', '--external=cloudflare:workers', '--outfile', output], { stdout: 'pipe', stderr: 'pipe' });
    const [status, stdout, stderr] = await Promise.all([bundle.exited, new Response(bundle.stdout).text(), new Response(bundle.stderr).text()]);
    if (status !== 0) throw new Error(`Code search fixture build failed: ${stdout}${stderr}`);
    worker = new Miniflare({ modules: [{ type: 'ESModule', path: output, contents: await Bun.file(output).text() }, await searchWasmModule(directory)], modulesRoot: directory, compatibilityDate: '2026-03-02', compatibilityFlags: ['nodejs_compat'], durableObjects: { PROOF: { className: 'CodeSearchProof', useSQLite: true } }, outboundService: () => { throw new Error('Live provider access forbidden'); } });
    const response = await worker.dispatchFetch('http://proof/');
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toMatchObject({ passed: true });
  } finally { await worker?.dispose(); await rm(directory, { recursive: true, force: true }); }
}, 60_000);
