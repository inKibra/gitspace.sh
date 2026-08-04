#!/usr/bin/env bun
/**
 * Fails when a source file is type-checked by NOBODY, or silences its own file.
 *
 * Two real holes this exists to close:
 *
 * 1. Coverage gap. The root tsconfig excludes `src/**\/*.web.ts(x)`, and the web
 *    project (web/tsconfig.app.json) only includes `main.tsx` — it reaches the
 *    rest transitively. A `.web.tsx` file that nothing imports therefore lands in
 *    neither program and is never checked. Four such files existed (1,276 lines,
 *    zero importers) and a deliberately broken type in one of them was reported
 *    by neither `tsgo` nor `tsc`.
 *
 * 2. Whole-file suppression. `@ts-nocheck` turns a file off entirely. It was on
 *    the 4,800-line machine daemon, where an undefined identifier typechecked
 *    clean and would only have surfaced as a runtime ReferenceError.
 *
 * Both failures are invisible: the suite is green, typecheck is green, and the
 * file is unchecked. Only an explicit inventory catches that.
 *
 * Usage: bun scripts/check-typecheck-coverage.ts
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(import.meta.dir, '..');

/** Every file a tsconfig's program actually contains, as repo-relative paths. */
function programFiles(cwd: string, project: string): Set<string> {
  const result = spawnSync('bunx', ['tsc', '-p', project, '--noEmit', '--listFiles'], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  // tsc exits non-zero when the project has type errors; --listFiles output is
  // still complete and is all this check needs.
  const files = new Set<string>();
  for (const line of (result.stdout ?? '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('/')) continue;
    if (trimmed.includes('/node_modules/')) continue;
    files.add(relative(ROOT, trimmed));
  }
  return files;
}

function sourceFiles(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, out);
    } else if (/\.tsx?$/.test(entry) && !entry.endsWith('.d.ts')) {
      out.push(relative(ROOT, full));
    }
  }
}

// Every project that contributes coverage. Keep in lockstep with the
// `typecheck` script in package.json — a project missing here reports its files
// as unchecked, and a project missing there leaves them genuinely unchecked.
const covered = new Set<string>([
  ...programFiles(ROOT, 'tsconfig.json'),
  ...programFiles(join(ROOT, 'web'), 'tsconfig.app.json'),
  ...programFiles(join(ROOT, 'web'), 'tsconfig.webtests.json'),
]);

const all: string[] = [];
sourceFiles(join(ROOT, 'src'), all);

const unchecked = all.filter((file) => !covered.has(file)).sort();
const suppressed = all
  .filter((file) => readFileSync(join(ROOT, file), 'utf8').includes('@ts-nocheck'))
  .sort();

if (unchecked.length > 0) {
  console.error(`\n${unchecked.length} source file(s) are in NO typecheck program:`);
  for (const file of unchecked) console.error(`  ${file}`);
  console.error('\nEither import it from a checked entrypoint, add it to a tsconfig `include`,');
  console.error('or delete it — an unchecked file is worse than no file.');
}

if (suppressed.length > 0) {
  console.error(`\n${suppressed.length} source file(s) disable checking with @ts-nocheck:`);
  for (const file of suppressed) console.error(`  ${file}`);
  console.error('\nFix the underlying types instead; a whole-file opt-out hides every future error.');
}

if (unchecked.length > 0 || suppressed.length > 0) {
  process.exit(1);
}

console.log(`typecheck coverage OK — ${all.length} source files, all in a program, no @ts-nocheck`);
