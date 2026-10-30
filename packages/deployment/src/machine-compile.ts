import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import remapping from '@jridgewell/remapping';
import { z } from 'zod';

/** The bundles a machine generation compiles: its machine process and its worker, started often and the largest. The
 * host, its updater and bootstrap stay ES modules: they await at top level, and run briefly. */
export const COMPILED_MACHINE_BUNDLES = ['machine.js', 'machine-worker.js'] as const;

/**
 * Compiles a machine generation's process and worker bundles in `directory` (ES modules, as a release builds them, each
 * with its linked source map) in place into CommonJS with bytecode for the Bun running this: `<name>.js` becomes
 * CommonJS with `<name>.js.jsc` beside it, and `<name>.js.map` still maps to the TypeScript sources. The release build
 * compiles its own platform's generation; a machine compiles one it assembled from the portable release. Bytecode holds
 * for one Bun version only: another Bun ignores it and parses the JavaScript.
 */
export async function compileMachineBundles(directory: string): Promise<void> {
  const scratch = join(directory, '.compile');
  await rm(scratch, { recursive: true, force: true });
  await mkdir(scratch);
  try {
    for (const name of COMPILED_MACHINE_BUNDLES) {
      const path = join(directory, name);
      const original = z.looseObject({}).parse(JSON.parse(await readFile(`${path}.map`, 'utf8')));
      // Bun passes a file marked `// @bun` through as already bundled; unmarked, it is compiled again.
      await writeFile(join(scratch, name), (await readFile(path, 'utf8')).replace(/^\/\/ @bun[^\n]*\n/u, ''));
      const built = await Bun.build({
        entrypoints: [join(scratch, name)], target: 'bun', format: 'cjs', bytecode: true, sourcemap: 'linked', outdir: directory, naming: { entry: name },
        // The ES module bundle's own `require` is `import.meta.require`, which a CommonJS module spells `require`.
        define: { 'import.meta.require': 'require' },
      });
      if (!built.success) throw new AggregateError(built.logs, `Compiling ${name} failed`);
      // The compiled map points into the scratch copy, whose original map's sources are relative to `directory`.
      const composed = remapping(await readFile(`${path}.map`, 'utf8'), file => file.endsWith(`.compile/${name}`) ? JSON.stringify({ ...original, sourceRoot: '../' }) : null);
      await writeFile(`${path}.map`, composed.toString());
    }
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
