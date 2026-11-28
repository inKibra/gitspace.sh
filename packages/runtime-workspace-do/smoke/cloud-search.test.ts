import { test, expect } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Miniflare } from 'miniflare';
import { searchWasmModule } from './search-wasm.js';

/** Builds the code search fixture and asks its object for `path`. */
async function codeSearchProof(path: string): Promise<unknown> {
  const directory = await mkdtemp(join(tmpdir(), 'gitspace-code-search-'));
  let worker: Miniflare | undefined;
  try {
    const entrypoint = new URL('./cloud-search-fixture.ts', import.meta.url).pathname;
    const output = join(directory, 'fixture.js');
    const bundle = Bun.spawn([process.execPath, 'build', entrypoint, '--target=browser', '--conditions=workerd', '--external=*.wasm', '--external=cloudflare:workers', '--outfile', output], { stdout: 'pipe', stderr: 'pipe' });
    const [status, stdout, stderr] = await Promise.all([bundle.exited, new Response(bundle.stdout).text(), new Response(bundle.stderr).text()]);
    if (status !== 0) throw new Error(`Code search fixture build failed: ${stdout}${stderr}`);
    worker = new Miniflare({ modules: [{ type: 'ESModule', path: output, contents: await Bun.file(output).text() }, await searchWasmModule(directory)], modulesRoot: directory, compatibilityDate: '2026-03-02', compatibilityFlags: ['nodejs_compat'], durableObjects: { PROOF: { className: 'CodeSearchProof', useSQLite: true } }, outboundService: () => { throw new Error('Live provider access forbidden'); } });
    const response = await worker.dispatchFetch(`http://proof/${path}`);
    const text = await response.text();
    if (!response.ok) throw new Error(text);
    return JSON.parse(text);
  } finally { await worker?.dispose(); await rm(directory, { recursive: true, force: true }); }
}

test('code search indexes changed blobs off the request path and matches the JS reference in workerd SQLite', async () => {
  expect(await codeSearchProof('')).toMatchObject({ passed: true });
}, 60_000);

test('code search indexes a large repository in steps within the step budget, answering requests between them', async () => {
  expect(await codeSearchProof('?bounded')).toMatchObject({ passed: true });
}, 120_000);
