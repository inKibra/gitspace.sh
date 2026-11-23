import { test, expect } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Miniflare } from 'miniflare';
import { searchWasmModule } from './search-wasm.js';

/** Builds the history search fixture and asks its object for `path`. */
async function historySearchProof(path: string): Promise<unknown> {
  const directory = await mkdtemp(join(tmpdir(), 'gitspace-history-search-'));
  let worker: Miniflare | undefined;
  try {
    const built = await Bun.build({ entrypoints: [new URL('./history-search-fixture.ts', import.meta.url).pathname], target: 'browser', conditions: ['workerd'], external: ['cloudflare:workers', '*.wasm'], plugins: [{ name: 'workerd-async-hooks', setup(build) { build.onResolve({ filter: /^node:async_hooks$/u }, args => ({ path: args.path, external: true })); } }] });
    if (!built.success) throw new AggregateError(built.logs, 'History search fixture build failed');
    const contents = await built.outputs[0]!.text();
    worker = new Miniflare({ modules: [{ type: 'ESModule', path: join(directory, 'fixture.js'), contents }, await searchWasmModule(directory)], modulesRoot: directory, compatibilityDate: '2026-03-02', compatibilityFlags: ['nodejs_compat'], durableObjects: { PROOF: { className: 'HistorySearchProof', useSQLite: true } }, outboundService: () => { throw new Error('Live provider access forbidden'); } });
    const response = await worker.dispatchFetch(`http://proof/${path}`);
    const text = await response.text();
    if (!response.ok) throw new Error(text);
    return JSON.parse(text);
  } finally { await worker?.dispose(); await rm(directory, { recursive: true, force: true }); }
}

test('history search indexes old history from bounded resumable steps and new events as they are written, in workerd SQLite', async () => {
  expect(await historySearchProof('')).toMatchObject({ passed: true });
}, 120_000);

// HISTORY_SEARCH_BENCHMARK=1 bun test smoke/history-search.test.ts: a 40,000-event transcript indexed with the default
// limits, printed.
test.skipIf(!process.env.HISTORY_SEARCH_BENCHMARK)('history search benchmark', async () => {
  const result = await historySearchProof('?benchmark');
  console.log(JSON.stringify(result, null, 2));
  expect(result).toMatchObject({ passed: true });
}, 900_000);
