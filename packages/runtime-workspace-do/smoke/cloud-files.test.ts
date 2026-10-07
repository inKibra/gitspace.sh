import { test, expect } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Miniflare } from 'miniflare';
import { searchWasmModule } from './search-wasm.js';

for (const scenario of ['baseline', 'cache-index', 'committed-index']) test(`cloud files ${scenario} preserve durable writer fences and replay across recovery and machine handoff`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gitspace-cloud-files-'));
  let worker: Miniflare | undefined;
  try {
    const entrypoint = new URL('./cloud-files-fixture.ts', import.meta.url).pathname;
    const output = join(directory, 'fixture.js');
    const bundle = Bun.spawn([process.execPath, 'build', entrypoint, '--target=browser', '--conditions=workerd', '--external=*.wasm', '--external=cloudflare:workers', '--outfile', output], { stdout: 'pipe', stderr: 'pipe' });
    const [status, stdout, stderr] = await Promise.all([bundle.exited, new Response(bundle.stdout).text(), new Response(bundle.stderr).text()]);
    if (status !== 0) throw new Error(`Cloud file regression fixture build failed: ${stdout}${stderr}`);
    const contents = await Bun.file(output).text();
    worker = new Miniflare({ modules: [{ type: 'ESModule', path: join(directory, 'fixture.js'), contents }, await searchWasmModule(directory)], modulesRoot: directory, compatibilityDate: '2026-03-02', compatibilityFlags: ['nodejs_compat'], durableObjects: { PROOF: { className: 'CloudFilesProof', useSQLite: true } }, outboundService: () => { throw new Error('Live provider access forbidden'); } });
    const response = await worker.dispatchFetch(`http://proof/?scenario=${scenario}`);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toEqual({ passed: true });
  } finally { await worker?.dispose(); await rm(directory, { recursive: true, force: true }); }
}, 30_000);
