import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Miniflare } from 'miniflare';
import { searchWasmModule } from './search-wasm.js';

const directory = await mkdtemp(join(tmpdir(), 'gitspace-cloud-search-'));
let worker: Miniflare | undefined;
try {
  const entrypoint = new URL('./cloud-search-fixture.ts', import.meta.url).pathname;
  const output = join(directory, 'fixture.js');
  const build = Bun.spawn([process.execPath, 'build', entrypoint, '--target=browser', '--conditions=workerd', '--external=cloudflare:workers', '--external=*.wasm', '--outfile', output], { stdout: 'pipe', stderr: 'pipe' });
  const [status, stdout, stderr] = await Promise.all([build.exited, new Response(build.stdout).text(), new Response(build.stderr).text()]);
  if (status !== 0) throw new Error(`Search fixture bundle failed: ${stdout}${stderr}`);
  const contents = await Bun.file(output).text();
  worker = new Miniflare({ modules: [{ type: 'ESModule', path: output, contents }, await searchWasmModule(directory)], modulesRoot: directory, compatibilityDate: '2026-03-02', compatibilityFlags: ['nodejs_compat'], durableObjects: { PROOF: { className: 'CloudSearchProof', useSQLite: true } }, outboundService: () => { throw new Error('Live provider access forbidden'); } });
  const response = await worker.dispatchFetch(`http://proof/${process.argv.includes('--benchmark') ? '?benchmark' : ''}`);
  const result = await response.text();
  if (!response.ok) throw new Error(result);
  console.log(result);
} finally { await worker?.dispose(); await rm(directory, { recursive: true, force: true }); }
