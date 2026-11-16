import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { changeSetBlock, commandRunBlock, diffBlock, excerptBlock, packageCandidates, PACKAGE_MANIFESTS, testReportBlock, type ChangeSetFile } from '../src/block-builders.js';
import { validateMarkdownBlocks } from '../src/gitspace-ui.js';

const fence = '```';
let repo = '';

function git(...args: string[]): string {
  const run = Bun.spawnSync(['git', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', '-c', 'core.quotePath=false', ...args], { cwd: repo });
  if (run.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr.toString()}`);
  return run.stdout.toString();
}

function write(path: string, text: string): void {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), text);
}

const PARSE = ['export function parse(line: string) {', '  const [key, value] = line.split("=");', '  return { key, value };', '}', '', 'export function format(entry: { key: string; value: string }) {', '  return `${entry.key}=${entry.value}`;', '}', ''].join('\n');

// A fixture repository: a base commit, then a change to a package, a folder, a root file and a new file.
beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'block-builders-'));
  git('init', '-q', '-b', 'main');
  write('packages/config/package.json', '{"name":"config"}\n');
  write('packages/config/src/parse.ts', PARSE);
  write('docs/guide.md', '# Guide\n\nOld words.\n');
  write('README.md', 'Readme\n');
  write('src/app.ts', 'console.log("app");\n');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  write('packages/config/src/parse.ts', PARSE.replace('  const [key, value] = line.split("=");', '  const at = line.indexOf("=");\n  const key = line.slice(0, at), value = line.slice(at + 1);'));
  write('packages/config/src/trim.ts', 'export const trim = (text: string) => text.trim();\n');
  write('docs/guide.md', '# Guide\n\nNew words.\n');
  write('README.md', 'Readme\n\nMore.\n');
  write('src/app.ts', 'console.log("app");\nconsole.log("ready");\n');
  git('add', '.');
  git('commit', '-q', '-m', 'change');
});
afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe('diff', () => {
  it('draws one file\'s real hunks as a Diff that validates', () => {
    const patch = git('diff', 'HEAD~1', 'HEAD', '--', 'packages/config/src/parse.ts');
    const built = diffBlock({ path: 'packages/config/src/parse.ts', patch, base: 'main~1' });
    expect(built.component).toBe('Diff');
    expect(built.props.patch).toBe(patch);
    expect(built.props.patch).toContain('@@ -1,5 +1,6 @@');
    expect(built.props.patch).toContain('-  const [key, value] = line.split("=");\n+  const at = line.indexOf("=");\n+  const key = line.slice(0, at), value = line.slice(at + 1);');
    expect(built.props.title).toBe('packages/config/src/parse.ts · against main~1');
    expect(built.fence).toBe(`${fence}gitspace-ui Diff\n${JSON.stringify(built.props)}\n${fence}`);
    expect(validateMarkdownBlocks(built.fence)).toEqual([]);
  });

  it('refuses a file without changes, and a patch of several files', () => {
    expect(() => diffBlock({ path: 'src/none.ts', patch: '', base: 'main' })).toThrow('src/none.ts has no changes against main');
    expect(() => diffBlock({ path: 'docs', patch: git('diff', 'HEAD~1', 'HEAD', '--', 'docs', 'src'), base: 'main' })).toThrow('names 2 changed files');
  });
});

describe('excerpt', () => {
  it('takes the file\'s exact lines with their numbers, marks and commit', () => {
    const commit = git('rev-parse', 'HEAD').trim();
    const text = git('show', `${commit}:packages/config/src/parse.ts`);
    const built = excerptBlock({ path: 'packages/config/src/parse.ts', text, start: 2, end: 4, commit, highlight: [3], note: 'Splits at the first "=" only.' });
    expect(built.props).toEqual({ path: 'packages/config/src/parse.ts', startLine: 2, lines: ['  const at = line.indexOf("=");', '  const key = line.slice(0, at), value = line.slice(at + 1);', '  return { key, value };'], commit, highlight: [3], note: 'Splits at the first "=" only.' });
    expect(validateMarkdownBlocks(built.fence)).toEqual([]);
  });

  it('stops at the file\'s last line, and refuses a start past it or too many lines', () => {
    const text = git('show', 'HEAD:src/app.ts');
    expect(excerptBlock({ path: 'src/app.ts', text, start: 2, end: 40, commit: null }).props.lines).toEqual(['console.log("ready");']);
    expect(() => excerptBlock({ path: 'src/app.ts', text, start: 3, end: 4, commit: null })).toThrow('src/app.ts has 2 lines');
    expect(() => excerptBlock({ path: 'big.ts', text: 'x\n'.repeat(500), start: 1, end: 121, commit: null })).toThrow('at most 120 lines');
  });

  it('is refused by the block checks when a highlight is not among its lines', () => {
    expect(() => excerptBlock({ path: 'src/app.ts', text: git('show', 'HEAD:src/app.ts'), start: 1, end: 2, commit: null, highlight: [5] })).toThrow('line 5 is not among the excerpt\'s lines 1–2');
  });
});

describe('changeSet', () => {
  it('groups the real changed files by top-level package or folder, with their counts', () => {
    const counts = new Map(git('diff', '--numstat', 'HEAD~1', 'HEAD').trim().split('\n').map(line => { const [added, removed, path] = line.split('\t'); return [path!, { added: Number(added), removed: Number(removed) }]; }));
    const files: ChangeSetFile[] = git('diff', '--name-status', 'HEAD~1', 'HEAD').trim().split('\n').map(line => {
      const [status, path] = line.split('\t');
      return { path: path!, status: status === 'A' ? 'added' : 'modified', added: counts.get(path!)!.added, removed: counts.get(path!)!.removed };
    });
    const candidates = packageCandidates(files.map(file => file.path));
    expect(candidates).toEqual(['docs', 'packages', 'packages/config', 'src']);
    const packages = new Set(candidates.filter(folder => Object.keys(PACKAGE_MANIFESTS).some(name => existsSync(join(repo, folder, name)))));
    const built = changeSetBlock({ base: 'main~1', head: 'main', files, packages });
    expect(built.props.groups).toEqual([
      { name: 'docs', paths: ['docs/guide.md'] },
      { name: 'packages/config', paths: ['packages/config/src/parse.ts', 'packages/config/src/trim.ts'] },
      { name: 'src', paths: ['src/app.ts'] },
      { name: '(root)', paths: ['README.md'] },
    ]);
    expect(built.props.files.find(file => file.path === 'packages/config/src/parse.ts')).toEqual({ path: 'packages/config/src/parse.ts', status: 'modified', added: 2, removed: 1 });
    expect(built.props.files.find(file => file.path === 'packages/config/src/trim.ts')).toEqual({ path: 'packages/config/src/trim.ts', status: 'added', added: 1, removed: 0 });
    expect(validateMarkdownBlocks(built.fence)).toEqual([]);
  });

  it('refuses a change without files, and the block checks refuse a group naming a file it lacks', () => {
    expect(() => changeSetBlock({ base: 'main', head: null, files: [], packages: new Set() })).toThrow('No files changed against main');
    const body = JSON.stringify({ files: [{ path: 'a.ts', added: 1, removed: 0, status: 'added' }], groups: [{ name: 'src', paths: ['b.ts'] }] });
    expect(validateMarkdownBlocks(`${fence}gitspace-ui ChangeSet\n${body}\n${fence}`)).toEqual([{ path: 'block 1/elements/block/props/groups/0/paths/0', message: 'no file "b.ts" in files' }]);
  });
});

describe('commandRun', () => {
  it('keeps the command, exit code, duration and the last lines of its output', () => {
    const output = `${Array.from({ length: 100 }, (_, index) => `\u001b[32mline ${index + 1}\u001b[0m`).join('\n')}\n`;
    const built = commandRunBlock({ command: 'bun test', exitCode: 1, durationMs: 2500, output, cut: false, jobId: 'job:7', cwd: 'packages/config' });
    expect(built.props).toMatchObject({ command: 'bun test', exitCode: 1, durationMs: 2500, truncated: true, jobId: 'job:7', cwd: 'packages/config' });
    expect(built.props.output.split('\n')).toEqual(Array.from({ length: 60 }, (_, index) => `line ${index + 41}`));
    expect(commandRunBlock({ command: 'true', exitCode: 0, durationMs: 4, output: 'done\n', cut: false, jobId: null, cwd: null }).props).toMatchObject({ output: 'done', truncated: false });
    expect(validateMarkdownBlocks(built.fence)).toEqual([]);
  });
});

// Real output of vitest 4 and bun test 1.4 for the same two files: one assertion failure and one thrown error each.
const VITEST = `
 RUN  v4.1.11 /tmp/fixture

 ❯ src/math.test.ts (3 tests | 1 failed | 1 skipped) 6ms
     × handles negatives 4ms
 ❯ src/other.test.ts (2 tests | 1 failed) 4ms
   × throws 2ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  src/math.test.ts > adds > handles negatives
AssertionError: expected -2 to be -3 // Object.is equality

- Expected
+ Received

- -3
+ -2

 ❯ src/math.test.ts:4:51
      2| describe('adds', () => {
      3|   it('works', () => { expect(1 + 1).toBe(2); });
      4|   it('handles negatives', () => { expect(-1 + -1).toBe(-3); });
       |                                                   ^
      5|   it.skip('later', () => {});
      6| });

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/2]⎯

 FAIL  src/other.test.ts > throws
Error: boom: database closed
 ❯ src/other.test.ts:3:28
      1| import { expect, it } from 'vitest';
      2| it('passes', () => { expect(true).toBe(true); });
      3| it('throws', () => { throw new Error('boom: database closed'); });
       |                            ^
      4|

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[2/2]⎯


 Test Files  2 failed (2)
      Tests  2 failed | 2 passed | 1 skipped (5)
   Start at  15:05:05
   Duration  131ms (transform 25ms, setup 0ms, import 44ms, tests 10ms, environment 0ms)
`;

const BUN = `bun test v1.4.4 (38afee6c8)

math.test.ts:
1 | import { describe, expect, it } from 'bun:test';
2 | describe('adds', () => {
3 |   it('works', () => { expect(1 + 1).toBe(2); });
4 |   it('handles negatives', () => { expect(-1 + -1).toBe(-3); });
                                                      ^
error: expect(received).toBe(expected)

Expected: -3
Received: -2

      at <anonymous> (/tmp/fixture/b/math.test.ts:4:51)
(fail) adds > handles negatives [0.13ms]

other.test.ts:
1 | import { expect, it } from 'bun:test';
2 | it('passes', () => { expect(true).toBe(true); });
3 | it('throws', () => { throw new Error('boom: database closed'); });
                                                                ^
error: boom: database closed
      at <anonymous> (/tmp/fixture/b/other.test.ts:3:61)
(fail) throws [0.06ms]

 2 pass
 1 skip
 2 fail
 3 expect() calls
Ran 5 tests across 2 files. [1.20s]
`;

const JEST = `FAIL src/math.test.js
  adds
    ✓ works (2 ms)
    ✕ handles negatives (3 ms)
    ○ skipped later

  ● adds › handles negatives

    expect(received).toBe(expected) // Object.is equality

    Expected: -3
    Received: -2

      2 | describe('adds', () => {
      3 |   it('works', () => { expect(1 + 1).toBe(2); });
    > 4 |   it('handles negatives', () => { expect(-1 + -1).toBe(-3); });
        |                                                   ^

      at Object.toBe (src/math.test.js:4:51)

PASS src/other.test.js

Test Suites: 1 failed, 1 passed, 2 total
Tests:       1 failed, 1 skipped, 3 passed, 5 total
Snapshots:   0 total
Time:        0.512 s
Ran all test suites.
`;

const PYTEST = `============================= test session starts ==============================
platform linux -- Python 3.12.3, pytest-8.3.4, pluggy-1.5.0
rootdir: /tmp/fixture
plugins: rerunfailures-15.0
collected 6 items

tests/test_math.py .F.s                                                  [ 66%]
tests/test_db.py RE.                                                     [100%]

==================================== ERRORS ====================================
_______________________ ERROR at setup of test_connect ________________________
E   RuntimeError: database closed
=================================== FAILURES ===================================
________________________________ test_negative _________________________________

    def test_negative():
>       assert -1 + -1 == -3
E       assert -2 == -3

tests/test_math.py:5: AssertionError
=========================== short test summary info ============================
FAILED tests/test_math.py::test_negative - assert -2 == -3
ERROR tests/test_db.py::test_connect - RuntimeError: database closed
tests/test_db.py::test_retry RERUN
============= 1 failed, 3 passed, 1 skipped, 1 error, 1 rerun in 0.42s =============
`;

const GO_VERBOSE = `=== RUN   TestAdd
    math_test.go:8: expected -3, got -2
--- FAIL: TestAdd (0.00s)
=== RUN   TestOther
--- PASS: TestOther (0.00s)
=== RUN   TestSkip
    math_test.go:15: later
--- SKIP: TestSkip (0.00s)
FAIL
FAIL	example.com/calc	0.004s
=== RUN   TestParse
--- PASS: TestParse (0.00s)
PASS
ok  	example.com/parse	0.002s
FAIL
`;

const GO_QUIET = `--- FAIL: TestAdd (0.00s)
    math_test.go:8: expected -3, got -2
FAIL
FAIL	example.com/calc	0.004s
ok  	example.com/parse	0.002s
FAIL
`;

describe('testReport', () => {
  it('reads vitest\'s summary and each failure with its file and message', () => {
    const built = testReportBlock(VITEST, false);
    expect(built.unrecognised).toBe(false);
    expect(built.props).toEqual({
      runner: 'vitest', passed: 2, failed: 2, skipped: 1, durationMs: 131, flaky: null, note: null,
      failures: [
        { name: 'adds > handles negatives', file: 'src/math.test.ts', message: 'AssertionError: expected -2 to be -3 // Object.is equality\n\n- Expected\n+ Received\n\n- -3\n+ -2' },
        { name: 'throws', file: 'src/other.test.ts', message: 'Error: boom: database closed' },
      ],
    });
    expect(validateMarkdownBlocks(built.fence)).toEqual([]);
  });

  it('reads bun test\'s counts and the error printed above each (fail) line', () => {
    expect(testReportBlock(BUN, false).props).toEqual({
      runner: 'bun test', passed: 2, failed: 2, skipped: 1, durationMs: 1200, flaky: null, note: null,
      failures: [
        { name: 'adds > handles negatives', file: 'math.test.ts', message: 'expect(received).toBe(expected)\n\nExpected: -3\nReceived: -2' },
        { name: 'throws', file: 'other.test.ts', message: 'boom: database closed' },
      ],
    });
  });

  it('reads jest\'s summary and failures', () => {
    expect(testReportBlock(JEST, false).props).toMatchObject({
      runner: 'jest', passed: 3, failed: 1, skipped: 1, durationMs: 512,
      failures: [{ name: 'adds > handles negatives', file: 'src/math.test.js', message: 'expect(received).toBe(expected) // Object.is equality\n\nExpected: -3\nReceived: -2' }],
    });
  });

  it('reads pytest\'s summary line, its short summary failures and errors, and a rerun that passed as flaky', () => {
    expect(testReportBlock(PYTEST, false).props).toEqual({
      runner: 'pytest', passed: 3, failed: 2, skipped: 1, durationMs: 420, note: null, flaky: ['tests/test_db.py::test_retry'],
      failures: [
        { name: 'test_negative', file: 'tests/test_math.py', message: 'assert -2 == -3' },
        { name: 'test_connect', file: 'tests/test_db.py', message: 'RuntimeError: database closed' },
      ],
    });
  });

  it('reads go test with -v, and without it says passes are not listed', () => {
    expect(testReportBlock(GO_VERBOSE, false).props).toMatchObject({ runner: 'go test', passed: 2, failed: 1, skipped: 1, durationMs: 6, failures: [{ name: 'TestAdd', file: 'math_test.go', message: 'expected -3, got -2' }], note: null });
    expect(testReportBlock(GO_QUIET, false).props).toMatchObject({ runner: 'go test', passed: null, failed: 1, skipped: null, failures: [{ name: 'TestAdd', file: 'math_test.go', message: 'expected -3, got -2' }], note: 'go test lists passing tests only with -v.' });
  });

  it('gives unrecognised output only the counts it states, never invented ones', () => {
    const mocha = testReportBlock('  parser\n    ✔ reads a line\n    1) reads a quoted value\n\n  4 passing (12ms)\n  1 failing\n', false);
    expect(mocha.unrecognised).toBe(true);
    expect(mocha.props).toEqual({ runner: null, passed: 4, failed: 1, skipped: null, durationMs: null, failures: [], flaky: null, note: 'Unrecognised test output: only the counts it states are shown, and no failures.' });
    const silent = testReportBlock('Segmentation fault (core dumped)\n', true);
    expect(silent.unrecognised).toBe(true);
    expect(silent.props).toMatchObject({ passed: null, failed: null, skipped: null, failures: [], note: 'Unrecognised test output: it states no counts. The run\'s output was cut; this reads the part kept.' });
    expect(validateMarkdownBlocks(silent.fence)).toEqual([]);
  });
});
