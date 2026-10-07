import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { readdir } from 'node:fs/promises';

/** Bun leaves the static workerd WASM import external; Miniflare supplies its compiled module. */
export async function searchWasmModule(directory: string) {
  const require = createRequire(new URL('../../protocol-runtime/package.json', import.meta.url));
  const packageRoot = dirname(require.resolve('rregex/package.json'));
  return { type: 'CompiledWasm' as const, path: join(directory, 'rregex.wasm'), contents: new Uint8Array(await Bun.file(join(packageRoot, 'lib/rregex.wasm')).arrayBuffer()) };
}

/** Wrangler names auxiliary modules by hash; enumerate output rather than scanning dynamic imports. */
export async function wranglerWorkerModules(directory: string, main: string) {
  const modules: ({ type: 'ESModule'; path: string; contents: string } | { type: 'CompiledWasm'; path: string; contents: Uint8Array })[] = [
    { type: 'ESModule', path: join(directory, main), contents: await Bun.file(join(directory, main)).text() },
  ];
  for (const name of await readdir(directory)) {
    if (name.endsWith('.wasm')) modules.push({ type: 'CompiledWasm', path: join(directory, name), contents: new Uint8Array(await Bun.file(join(directory, name)).arrayBuffer()) });
    else if (name !== main && (name.endsWith('.mjs') || name.endsWith('.js'))) modules.push({ type: 'ESModule', path: join(directory, name), contents: await Bun.file(join(directory, name)).text() });
  }
  return modules;
}
