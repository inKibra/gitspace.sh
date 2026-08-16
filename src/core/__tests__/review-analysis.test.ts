import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { analyzeReviewDiff, editShapeSignature, tokenShape, scoreCommitPrior } from '../review-analysis.js';

let repo: string;

function sh(args: string[]): void {
  execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { stdio: 'ignore' });
}

function write(path: string, content: string): void {
  const full = join(repo, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function commitAll(msg: string): void {
  sh(['add', '-A']);
  sh(['commit', '-q', '-m', msg]);
}

beforeEach(() => {
  repo = join(tmpdir(), `ra-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(repo, { recursive: true });
  sh(['init', '-q', '-b', 'main']);
  write('src/existing.ts', 'export const existing = 1;\n');
  commitAll('init');
  sh(['checkout', '-q', '-b', 'feature']);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('edit shapes', () => {
  it('identical edits in different files share a signature; different edits do not', () => {
    const a = `--- a/x.ts\n+++ b/x.ts\n@@\n-import { z } from './old.js';\n+import { z } from './new.js';\n`;
    const b = `--- a/y.ts\n+++ b/y.ts\n@@\n-import { q } from './old.js';\n+import { q } from './new.js';\n`;
    const c = `--- a/z.ts\n+++ b/z.ts\n@@\n+export function brandNew() { return 42; }\n`;
    expect(editShapeSignature(a)).toBe(editShapeSignature(b));
    expect(editShapeSignature(a)).not.toBe(editShapeSignature(c));
    expect(tokenShape("import { a } from 'b';")).toBe(tokenShape("import { xyz } from 'longer/path';"));
  });
});

describe('analyzeReviewDiff', () => {
  it('detects sweeps, core clusters, and holds the coverage invariant', () => {
    // core: new module + two consumers; sweep: same one-line edit in 3 files
    write('src/core/thing.ts', 'export function thing() { return 1; }\nexport type ThingKind = string;\n');
    write('src/use-a.ts', "import { thing } from './core/thing.js';\nexport const a = thing();\n");
    write('src/use-b.ts', "import { thing } from './core/thing.js';\nexport const b = thing();\n");
    for (const f of ['s1', 's2', 's3']) write(`src/sweep/${f}.ts`, "import { x } from './renamed.js';\n");
    write('bun.lock', '{}\n');
    commitAll('feat: add thing module with consumers');

    const analysis = analyzeReviewDiff(repo, 'main');

    expect(analysis.covered).toBe(true);
    const sweep = analysis.clusters.find((c) => c.type === 'sweep');
    expect(sweep?.files).toEqual(['src/sweep/s1.ts', 'src/sweep/s2.ts', 'src/sweep/s3.ts']);
    expect(sweep?.signals.sweep?.representative).toBe('src/sweep/s1.ts');

    const core = analysis.clusters.find((c) => c.files.includes('src/core/thing.ts'));
    expect(core?.type).toBe('core');
    expect(core?.files).toEqual(expect.arrayContaining(['src/use-a.ts', 'src/use-b.ts']));
    expect(core?.order).toBe(1); // core reads first
    expect(analysis.files.find((f) => f.path === 'src/core/thing.ts')?.inDegree).toBe(2);
    expect(analysis.files.find((f) => f.path === 'bun.lock')?.lowSignal).toBe('lockfile');

    const supporting = analysis.clusters.find((c) => c.type === 'supporting');
    expect(supporting?.files).toContain('bun.lock');
    expect(supporting?.order).toBe(analysis.clusters.length); // reads last
  });

  it('cluster ids are stable across unrelated changes elsewhere', () => {
    write('src/core/thing.ts', 'export function thing() { return 1; }\n');
    write('src/use-a.ts', "import { thing } from './core/thing.js';\nexport const a = thing();\n");
    commitAll('feat: thing');
    const first = analyzeReviewDiff(repo, 'main');
    const coreId = first.clusters.find((c) => c.files.includes('src/core/thing.ts'))!.id;

    write('docs/note.md', 'unrelated\n');
    commitAll('docs: note');
    const second = analyzeReviewDiff(repo, 'main');
    expect(second.clusters.find((c) => c.files.includes('src/core/thing.ts'))!.id).toBe(coreId);
  });

  it('scores commit coherence: informative partitioned commits adopted, wip noise rejected', () => {
    expect(scoreCommitPrior([
      { sha: 'a', subject: 'add billing types for invoices', files: ['a.ts'] },
      { sha: 'b', subject: 'wire invoice types into checkout', files: ['b.ts'] },
    ])).toBeGreaterThanOrEqual(0.6);
    expect(scoreCommitPrior([
      { sha: 'a', subject: 'wip', files: ['a.ts', 'b.ts'] },
      { sha: 'b', subject: 'fix', files: ['a.ts', 'b.ts'] },
    ])).toBeLessThan(0.6);
  });

  it('test files bind to their source cluster', () => {
    write('src/core/thing.ts', 'export function thing() { return 1; }\n');
    write('src/core/__tests__/thing.test.ts', "import { thing } from '../thing.js';\n");
    commitAll('feat: thing with test');
    const analysis = analyzeReviewDiff(repo, 'main');
    const cluster = analysis.clusters.find((c) => c.files.includes('src/core/thing.ts'));
    expect(cluster?.files).toContain('src/core/__tests__/thing.test.ts');
  });
});

/**
 * Smoke test over THIS repository's real diff. It needs the base ref to exist,
 * which a shallow CI checkout does not provide — and deepening the clone just
 * to satisfy it would buy a test whose thresholds (>100 files) describe the
 * current branch rather than any contract, so it would break the moment this
 * merges. It runs where the ref is there, and declares itself skipped where it
 * is not, rather than failing on an absent precondition.
 */
function baseRefExists(ref: string): boolean {
  try {
    execFileSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], { cwd: process.cwd(), stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('smoke: this repository', () => {
  const BASE = 'develop';
  it.skipIf(!baseRefExists(BASE))('analyzes the real multi-pane diff with full coverage in bounded time', () => {
    const here = process.cwd();
    const started = Date.now();
    const analysis = analyzeReviewDiff(here, BASE);
    const elapsed = Date.now() - started;
    expect(analysis.covered).toBe(true);
    expect(analysis.files.length).toBeGreaterThan(100);
    expect(analysis.clusters.length).toBeGreaterThan(3);
    expect(analysis.clusters.filter((c) => c.type === 'core').length).toBeGreaterThanOrEqual(1);
    // deterministic layer must stay cheap even on a ~400-file diff
    expect(elapsed).toBeLessThan(60_000);
    // Runner timeout sits ABOVE the assertion above, so a genuine perf
    // regression fails on `elapsed` with a real number rather than being
    // killed at bun's 5s default before the assertion is ever reached.
  }, 120_000);
});
