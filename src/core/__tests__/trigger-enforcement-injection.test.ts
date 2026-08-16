/**
 * Regression: trigger write-scope enforcement must NOT execute shell from
 * attacker-controlled filenames (ultrareview bug_001 — RCE in the daemon
 * that holds the signing key). git filenames are arbitrary bytes; the fix
 * is execFileSync (no shell). A file named `x_$(touch PWNED).md` committed
 * out of scope must be reverted WITHOUT the substitution ever running.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { enforceTriggerWritesPostRun } from '../triggers.js';
import type { TriggerRecord } from '../triggers.js';

const TMP = join(import.meta.dir, `.inj-${process.pid}`);
// The enforcement helper reads its mount at `<workspaceDir>/.gitspace/artifacts`.
const workspaceDir = TMP;
const mount = join(TMP, '.gitspace', 'artifacts');
// Slash-free marker so it's a single valid git path. gitInMount runs with the
// default cwd, so we chdir into TMP for the test — any shell that DID fire
// would drop the marker here, where we check + clean it.
const MARKER = 'INJ_MARKER';
const markerPath = join(TMP, MARKER);
let prevCwd = '';

function git(...args: string[]): string {
  return execFileSync('git', ['-C', mount, ...args], { encoding: 'utf8' }).trim();
}

beforeEach(() => {
  prevCwd = process.cwd();
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(mount, { recursive: true });
  process.chdir(TMP);
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 't');
  git('config', 'user.email', 't@t');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(mount, 'seed.md'), 'seed\n');
  git('add', '-A');
  git('commit', '-qm', 'seed');
});

afterEach(() => {
  if (prevCwd) process.chdir(prevCwd);
  rmSync(TMP, { recursive: true, force: true });
});

test('malicious filename is reverted without executing shell', async () => {
  const startCommit = git('rev-parse', 'HEAD');

  // An out-of-scope file whose NAME is a shell command substitution.
  const evil = 'x_$(touch ' + MARKER + ').md';
  writeFileSync(join(mount, evil), 'malicious\n');
  git('add', '-A');
  git('commit', '-qm', 'agent writes out of scope');

  const trigger: TriggerRecord = {
    id: 'inj-test', name: 'inj', kind: 'manual', when: '', writes: ['allowed/**'],
  } as TriggerRecord;

  const result = await enforceTriggerWritesPostRun(TMP, workspaceDir, trigger, { startCommit });

  // The substitution must never have run — no marker anywhere plausible.
  expect(existsSync(markerPath)).toBe(false);
  expect(existsSync(join(mount, MARKER))).toBe(false);
  // And the enforcement must have caught + reverted the out-of-scope write.
  expect(result.violations).toContain(evil);
  expect(existsSync(join(mount, evil))).toBe(false);
});
