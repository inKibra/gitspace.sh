#!/usr/bin/env bun
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';

const root = resolve(import.meta.dir, '..');
const legacyRoots = ['src', 'web', 'worker', 'bin/gssh'];
const errors: string[] = [];
for (const name of legacyRoots) {
  if (existsSync(join(root, name))) errors.push(`Removed product path exists: ${name}`);
}

function inspect(directory: string): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (['node_modules', 'dist', '.git', '.wrangler'].includes(entry.name)) continue;
    const file = join(directory, entry.name);
    if (entry.isDirectory()) {
      inspect(file);
      continue;
    }
    if (!/\.[cm]?[jt]sx?$/u.test(entry.name) && relative(root, file) !== 'bin/gitspace') continue;
    const source = readFileSync(file, 'utf8');
    for (const imported of ts.preProcessFile(source, true, true).importedFiles) {
      const specifier = imported.fileName;
      const target = relative(root, resolve(dirname(file), specifier));
      if (specifier.startsWith('@oh-my-pi/') || specifier === 'omp-legacy-pi-modules'
        || (specifier.startsWith('.') && legacyRoots.some(name => target === name || target.startsWith(`${name}/`)))) {
        errors.push(`${relative(root, file)} imports removed product dependency ${specifier}`);
      }
    }
  }
}
inspect(join(root, 'packages'));
inspect(join(root, 'scripts'));
inspect(join(root, 'bin'));
if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log('Current entrypoints do not depend on the removed product.');
