#!/usr/bin/env bun
/**
 * Isolated test runner.
 *
 * Bun's `mock.module` is process-GLOBAL and is evaluated for every test file
 * before any test runs, and `mock.restore()` does NOT undo it (verified on
 * 1.3.14). So a handful of suites that register partial module mocks
 * (../config, ../git, ../paths) silently clobber those modules for every
 * sibling suite in the same `bun test` run — ~47 spurious failures that all
 * vanish when each file runs alone.
 *
 * This runner executes each test file in its OWN `bun test` process, with
 * bounded concurrency, and aggregates results. `bun test` (one process)
 * stays available for fast local iteration; CI uses `bun run test` for a
 * clean, leak-free signal.
 *
 * Usage: bun scripts/test-isolated.ts [pathPrefix ...]   (default: src)
 */

import { readdirSync, statSync } from 'fs';
import { join } from 'path';

const roots = process.argv.slice(2);
const searchRoots = roots.length > 0 ? roots : ['src'];
const CONCURRENCY = Math.max(2, Math.min(8, (navigator.hardwareConcurrency ?? 4) - 1));

function findTests(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git') continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) findTests(full, out);
    else if (entry.endsWith('.test.ts') || entry.endsWith('.test.tsx')) out.push(full);
  }
}

const files: string[] = [];
for (const r of searchRoots) {
  try { statSync(r).isDirectory() ? findTests(r, files) : files.push(r); } catch { /* skip */ }
}
files.sort();

if (files.length === 0) {
  console.error('No test files found under', searchRoots.join(', '));
  process.exit(1);
}

console.log(`Running ${files.length} test files in isolated processes (concurrency ${CONCURRENCY})…\n`);

const failed: string[] = [];
let done = 0;

async function runOne(file: string): Promise<void> {
  // GSSH_TEST_ISOLATED silences the preload's multi-file pollution warning:
  // one file per process is exactly the safe case it warns about.
  const proc = Bun.spawn(['bun', 'test', file], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, GSSH_TEST_ISOLATED: '1' },
  });
  const code = await proc.exited;
  done += 1;
  const tag = `[${done}/${files.length}]`;
  if (code === 0) {
    console.log(`${tag} \x1b[32mPASS\x1b[0m ${file}`);
  } else {
    failed.push(file);
    const err = await new Response(proc.stderr).text();
    console.log(`${tag} \x1b[31mFAIL\x1b[0m ${file}`);
    // Surface the failing assertions, trimmed.
    const lines = err.split('\n').filter((l) => /\(fail\)|error:|Expected|Received/i.test(l)).slice(0, 8);
    for (const l of lines) console.log(`        ${l.trim()}`);
  }
}

// Bounded-concurrency worker pool.
const queue = [...files];
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    for (;;) {
      const f = queue.shift();
      if (!f) return;
      await runOne(f);
    }
  }),
);

console.log(`\n${failed.length === 0 ? '\x1b[32m' : '\x1b[31m'}${files.length - failed.length}/${files.length} files passed\x1b[0m`);
if (failed.length > 0) {
  console.log('\nFailed files:');
  for (const f of failed) console.log(`  ${f}`);
  process.exit(1);
}
