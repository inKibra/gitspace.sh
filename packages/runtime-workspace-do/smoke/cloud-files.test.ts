import { test, expect } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Miniflare } from 'miniflare';
import { searchWasmModule } from './search-wasm.js';

/** Builds `fixture`, runs its Durable Object `className` on SQLite storage and expects `{ passed: true }`. */
async function runProof(fixture: string, className: string): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'gitspace-cloud-files-'));
  let worker: Miniflare | undefined;
  try {
    const entrypoint = new URL(fixture, import.meta.url).pathname;
    const output = join(directory, 'fixture.js');
    const bundle = Bun.spawn([process.execPath, 'build', entrypoint, '--target=browser', '--conditions=workerd', '--external=*.wasm', '--external=cloudflare:workers', '--outfile', output], { stdout: 'pipe', stderr: 'pipe' });
    const [status, stdout, stderr] = await Promise.all([bundle.exited, new Response(bundle.stdout).text(), new Response(bundle.stderr).text()]);
    if (status !== 0) throw new Error(`Cloud file regression fixture build failed: ${stdout}${stderr}`);
    const contents = await Bun.file(output).text();
    worker = new Miniflare({ modules: [{ type: 'ESModule', path: join(directory, 'fixture.js'), contents }, await searchWasmModule(directory)], modulesRoot: directory, compatibilityDate: '2026-03-02', compatibilityFlags: ['nodejs_compat'], durableObjects: { PROOF: { className, useSQLite: true } }, outboundService: () => { throw new Error('Live provider access forbidden'); } });
    const response = await worker.dispatchFetch('http://proof/');
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toEqual({ passed: true });
  } finally { await worker?.dispose(); await rm(directory, { recursive: true, force: true }); }
}

test('cloud files run in order, replay attempts and hand off between machines', () => runProof('./cloud-files-fixture.ts', 'CloudFilesProof'), 30_000);

test('snapshot history keeps what a sync can still read and drains the rest', () => runProof('./cloud-files-retention-fixture.ts', 'CloudFilesRetentionProof'), 60_000);
