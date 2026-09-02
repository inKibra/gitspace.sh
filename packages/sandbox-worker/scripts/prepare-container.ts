import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repositoryRoot = dirname(dirname(packageRoot));
const context = join(packageRoot, '.container-context');
const walgitBinary = process.env.GITSPACE_WALGIT_BINARY;
if (!walgitBinary) throw new Error('GITSPACE_WALGIT_BINARY is required to build the sandbox machine image');
await rm(context, { recursive: true, force: true });
await mkdir(context, { recursive: true });
for (const file of ['package.json', 'bun.lock']) await cp(join(repositoryRoot, file), join(context, file));
await cp(join(repositoryRoot, 'patches'), join(context, 'patches'), { recursive: true });
await mkdir(join(context, 'packages'), { recursive: true });
for (const entry of await readdir(join(repositoryRoot, 'packages'), { withFileTypes: true })) {
  if (!entry.isDirectory() || entry.name === 'sandbox-worker') continue;
  await cp(join(repositoryRoot, 'packages', entry.name), join(context, 'packages', entry.name), {
    recursive: true,
    filter: (source) => !source.split(/[\\/]/u).includes('node_modules') && !source.split(/[\\/]/u).includes('dist'),
  });
}
await mkdir(join(context, 'packages', 'sandbox-worker'), { recursive: true });
await cp(join(packageRoot, 'package.json'), join(context, 'packages', 'sandbox-worker', 'package.json'));
await cp(walgitBinary, join(context, 'walgit'));
const dockerfile = await readFile(join(packageRoot, 'Dockerfile'), 'utf8');
await writeFile(join(context, 'Dockerfile'), dockerfile);
console.log(context);
