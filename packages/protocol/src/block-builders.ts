// Block builders: blocks made from real data (a file's diff, a file's lines, a change's files, a command's run, a test
// run's output) rather than retyped. Each returns the component, its props checked against the catalog, and the
// short-form fence an agent pastes. The `blocks` tool reads the source and calls these.
import { z } from 'zod';
import { gitspaceUiCatalog, validateMarkdownBlocks } from './gitspace-ui.js';

const FENCE = '```';
const components = gitspaceUiCatalog.components;

/** A block ready to paste: `fence` is the short form of `component` with `props`. */
export interface BuiltBlock<T> { component: string; props: T; fence: string }

/** Props checked by the component's schema, and the fence by the checks GitSpace runs on a stored block. */
function ready<T>(component: string, schema: z.ZodType<T>, input: unknown): BuiltBlock<T> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new Error(`The ${component} props are not valid:\n${z.prettifyError(parsed.error)}`);
  const fence = `${FENCE}gitspace-ui ${component}\n${JSON.stringify(parsed.data)}\n${FENCE}`;
  const issues = validateMarkdownBlocks(fence);
  if (issues.length > 0) throw new Error(`GitSpace would refuse the ${component} block: ${issues.map(issue => `${issue.path}: ${issue.message}`).join('; ')}`);
  return { component, props: parsed.data, fence };
}

/** `text` cut to `limit` characters, ending in "…" when cut. */
function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/gu;

/** Terminal output as plain lines: colour codes removed, and a line a carriage return rewrote as its last version. */
function plainLines(output: string): string[] {
  return output.replace(ANSI, '').split('\n').map(line => line.replace(/\r$/u, '').split('\r').at(-1) ?? '');
}

// ── Diff ──

/** The largest patch `diffBlock` draws: a bigger one is shown by the hunks that matter, as excerpts. */
const MAX_DIFF_BYTES = 32 * 1024;

/** A Diff of one file from its patch (`git diff` output); `base` names what it is compared with. */
export function diffBlock(input: { path: string; patch: string; base: string }): BuiltBlock<z.output<typeof components.Diff.props>> {
  const files = input.patch.match(/^diff --git /gmu)?.length ?? 0;
  if (files === 0) throw new Error(`${input.path} has no changes against ${input.base}`);
  if (files > 1) throw new Error(`${input.path} names ${files} changed files; a Diff shows one file (changeSet lists them all)`);
  const bytes = new TextEncoder().encode(input.patch).byteLength;
  if (bytes > MAX_DIFF_BYTES) throw new Error(`The diff of ${input.path} is ${bytes} bytes, over the ${MAX_DIFF_BYTES} a Diff block shows; show the parts that matter with excerpt`);
  return ready('Diff', components.Diff.props, { patch: input.patch, title: `${input.path} · against ${input.base}` });
}

// ── CodeExcerpt ──

/** The most lines an excerpt holds. */
const MAX_EXCERPT_LINES = 120;
const EXCERPT_LINE_CHARACTERS = 1000;

/** Lines `start` to `end` (1-based, inclusive; `end` past the file's end stops at its last line) of a file's `text`. */
export function excerptBlock(input: { path: string; text: string; start: number; end: number; commit: string | null; highlight?: readonly number[]; note?: string }): BuiltBlock<z.output<typeof components.CodeExcerpt.props>> {
  const lines = input.text.split('\n');
  if (input.text.endsWith('\n')) lines.pop();
  if (input.end < input.start) throw new Error(`end (${input.end}) is before start (${input.start})`);
  if (input.start > lines.length) throw new Error(`${input.path} has ${lines.length} lines; start ${input.start} is past its end`);
  const end = Math.min(input.end, lines.length);
  if (end - input.start + 1 > MAX_EXCERPT_LINES) throw new Error(`An excerpt holds at most ${MAX_EXCERPT_LINES} lines; ${input.start}–${end} is ${end - input.start + 1}`);
  return ready('CodeExcerpt', components.CodeExcerpt.props, {
    path: input.path, startLine: input.start, lines: lines.slice(input.start - 1, end).map(line => clip(line, EXCERPT_LINE_CHARACTERS)),
    commit: input.commit, highlight: input.highlight ?? null, note: input.note ?? null,
  });
}

// ── ChangeSet ──

/** Files whose folder is a package: a changed file is grouped under the package it belongs to. */
export const PACKAGE_MANIFESTS: Readonly<Record<string, true>> = {
  'package.json': true, 'deno.json': true, 'go.mod': true, 'Cargo.toml': true, 'pyproject.toml': true, 'setup.py': true,
  'pom.xml': true, 'build.gradle': true, 'build.gradle.kts': true, 'composer.json': true, 'Gemfile': true, 'mix.exs': true,
};

/** The folders, one and two deep, that may be the package of a changed file: `packages/ui/src/a.ts` gives `packages`
 * and `packages/ui`. */
export function packageCandidates(paths: readonly string[]): string[] {
  const folders = new Set<string>();
  for (const path of paths) {
    const parts = path.split('/');
    if (parts.length > 1) folders.add(parts[0]!);
    if (parts.length > 2) folders.add(`${parts[0]}/${parts[1]}`);
  }
  return [...folders].sort();
}

export type ChangeSetFile = z.output<typeof components.ChangeSet.props>['files'][number];
const ROOT_GROUP = '(root)';

/** A file's area: its top-level package (the first of its one- and two-deep folders that `packages` holds), else its
 * top-level folder; a file at the root is in "(root)". */
function areaOf(path: string, packages: ReadonlySet<string>): string {
  const parts = path.split('/');
  if (parts.length === 1) return ROOT_GROUP;
  const second = parts.length > 2 ? `${parts[0]}/${parts[1]}` : null;
  return !packages.has(parts[0]!) && second !== null && packages.has(second) ? second : parts[0]!;
}

/** A ChangeSet of `files`, grouped by area (`packages`: the candidate folders that hold a package manifest), areas in
 * name order with "(root)" last. */
export function changeSetBlock(input: { base: string | null; head: string | null; files: readonly ChangeSetFile[]; packages: ReadonlySet<string> }): BuiltBlock<z.output<typeof components.ChangeSet.props>> {
  if (input.files.length === 0) throw new Error(`No files changed against ${input.base ?? 'the base'}`);
  const files = [...input.files].sort((left, right) => left.path.localeCompare(right.path));
  const groups = new Map<string, string[]>();
  for (const file of files) {
    const area = areaOf(file.path, input.packages);
    groups.set(area, [...groups.get(area) ?? [], file.path]);
  }
  const names = [...groups.keys()].sort((left, right) => Number(left === ROOT_GROUP) - Number(right === ROOT_GROUP) || left.localeCompare(right));
  return ready('ChangeSet', components.ChangeSet.props, { base: input.base, head: input.head, files, groups: names.map(name => ({ name, paths: groups.get(name)! })) });
}

// ── CommandRun ──

/** How much of a command's output a CommandRun keeps: its last lines, at most this many characters. */
const COMMAND_OUTPUT_LINES = 60;
const COMMAND_OUTPUT_CHARACTERS = 8000;

/** A CommandRun from a finished command. `cut`: the source holds only part of the output. */
export function commandRunBlock(input: { command: string; exitCode: number; durationMs: number; output: string; cut: boolean; jobId: string | null; cwd: string | null }): BuiltBlock<z.output<typeof components.CommandRun.props>> {
  const lines = plainLines(input.output.replace(/\n+$/u, ''));
  const tail = lines.slice(-COMMAND_OUTPUT_LINES).join('\n');
  const output = tail.length > COMMAND_OUTPUT_CHARACTERS ? tail.slice(-COMMAND_OUTPUT_CHARACTERS) : tail;
  return ready('CommandRun', components.CommandRun.props, {
    command: clip(input.command, 2000), exitCode: input.exitCode, durationMs: Math.max(0, input.durationMs), output,
    truncated: input.cut || lines.length > COMMAND_OUTPUT_LINES || tail.length > COMMAND_OUTPUT_CHARACTERS, jobId: input.jobId, cwd: input.cwd,
  });
}

// ── TestReport ──

type TestFailure = { name: string; file: string | null; message: string };
/** What a test run's output says. `unrecognised`: no known runner's summary was found, so only the counts the output
 * states in words are read, and none of its failures. */
interface TestRun { runner: string | null; passed: number | null; failed: number | null; skipped: number | null; durationMs: number | null; failures: TestFailure[]; flaky: string[]; unrecognised: boolean }

const MAX_FAILURES = 40;
const FAILURE_MESSAGE_CHARACTERS = 2000;

/** A duration as runners print it: 131ms, 1.23s, 0.512 s. */
function milliseconds(value: string, unit: string): number {
  return Math.round(Number(value) * (unit === 'ms' ? 1 : 1000));
}

/** The number before `word` in `text` (`2 failed`), or null. */
function countOf(text: string, word: RegExp): number | null {
  const match = new RegExp(`(\\d+) (?:${word.source})\\b`, 'u').exec(text);
  return match ? Number(match[1]) : null;
}

/** Lines of a message: blank lines at either end dropped, the common indent removed. */
function messageOf(lines: readonly string[]): string {
  const kept = [...lines];
  while (kept.length > 0 && kept[0]!.trim() === '') kept.shift();
  while (kept.length > 0 && kept.at(-1)!.trim() === '') kept.pop();
  const indent = Math.min(...kept.filter(line => line.trim() !== '').map(line => /^\s*/u.exec(line)![0].length));
  return kept.map(line => line.slice(Number.isFinite(indent) ? indent : 0)).join('\n');
}

/** Lines from `start` until one `stop` matches. */
function linesUntil(lines: readonly string[], start: number, stop: RegExp): string[] {
  const taken: string[] = [];
  for (let index = start; index < lines.length && !stop.test(lines[index]!); index++) taken.push(lines[index]!);
  return taken;
}

function vitest(lines: readonly string[], text: string): TestRun | null {
  const summary = /^\s*Tests\s+(.*\(\d+\))\s*$/mu.exec(text);
  if (!summary || !/^\s*Test Files\s/mu.test(text)) return null;
  const counts = summary[1]!;
  const todo = countOf(counts, /todo/u);
  const skipped = countOf(counts, /skipped/u);
  const duration = /^\s*Duration\s+([\d.]+)(ms|s)\b/mu.exec(text);
  const failures: TestFailure[] = [];
  const seen = new Set<string>();
  lines.forEach((line, index) => {
    const head = /^\s*FAIL\s+(.+?)(?: \[ .* \])?\s*$/u.exec(line);
    if (!head || seen.has(head[1]!)) return;
    seen.add(head[1]!);
    const [file, ...names] = head[1]!.split(' > ');
    failures.push({ name: names.length > 0 ? names.join(' > ') : file!, file: file!, message: messageOf(linesUntil(lines, index + 1, /^\s*(?:❯ \S+:\d+|⎯)/u)) });
  });
  const flaky = lines.flatMap(line => { const retried = /^\s*[✓√]\s+(.+?)\s+\(retry x\d+\)/u.exec(line); return retried ? [retried[1]!] : []; });
  return { runner: 'vitest', passed: countOf(counts, /passed/u) ?? 0, failed: countOf(counts, /failed/u) ?? 0, skipped: (skipped ?? 0) + (todo ?? 0), durationMs: duration ? milliseconds(duration[1]!, duration[2]!) : null, failures, flaky, unrecognised: false };
}

function jest(lines: readonly string[], text: string): TestRun | null {
  const summary = /^Tests:\s+(.*\d+ total)\s*$/mu.exec(text);
  if (!summary) return null;
  const counts = summary[1]!;
  const duration = /^Time:\s+([\d.]+)\s*(ms|s)\b/mu.exec(text);
  const failures: TestFailure[] = [];
  const seen = new Set<string>();
  let file: string | null = null;
  lines.forEach((line, index) => {
    const header = /^\s*FAIL\s+(\S+)/u.exec(line);
    if (header) { file = header[1]!; return; }
    const head = /^\s+● (.+?)\s*$/u.exec(line);
    if (!head || head[1] === 'Console' || seen.has(`${file}:${head[1]}`)) return;
    seen.add(`${file}:${head[1]}`);
    failures.push({ name: head[1]!.replaceAll(' › ', ' > '), file, message: messageOf(linesUntil(lines, index + 1, /^\s+(?:\d+ \||> \d+ \||at |● )/u)) });
  });
  return { runner: 'jest', passed: countOf(counts, /passed/u) ?? 0, failed: countOf(counts, /failed/u) ?? 0, skipped: (countOf(counts, /skipped/u) ?? 0) + (countOf(counts, /todo/u) ?? 0), durationMs: duration ? milliseconds(duration[1]!, duration[2]!) : null, failures, flaky: [], unrecognised: false };
}

function bun(lines: readonly string[], text: string): TestRun | null {
  const ran = /^Ran \d+ tests? across \d+ files?\.(?: \[([\d.]+)(ms|s)\])?/mu.exec(text);
  const pass = /^ ?(\d+) pass$/mu.exec(text);
  if (!ran && !pass) return null;
  const count = (word: string) => { const match = new RegExp(`^ ?(\\d+) ${word}$`, 'mu').exec(text); return match ? Number(match[1]) : 0; };
  const failures: TestFailure[] = [];
  const seen = new Set<string>();
  let file: string | null = null;
  let section = 0;
  lines.forEach((line, index) => {
    const header = /^(\S[^:]*\.\w+):$/u.exec(line);
    if (header) { file = header[1]!; section = index + 1; return; }
    const failed = /^\(fail\) (.+?)(?: \[[\d.]+m?s\])?$/u.exec(line);
    if (!failed || seen.has(`${file}:${failed[1]}`)) return;
    seen.add(`${file}:${failed[1]}`);
    // The error is printed above its (fail) line: the last "error:" since the test before it.
    let start = -1;
    for (let at = index - 1; at >= section && !/^\((?:pass|fail|skip|todo)\) /u.test(lines[at]!); at--) if (lines[at]!.startsWith('error:')) { start = at; break; }
    const message = start < 0 ? '' : messageOf([lines[start]!.slice('error:'.length).trimStart(), ...linesUntil(lines, start + 1, /^\s+at |^\((?:pass|fail)\) /u)]);
    failures.push({ name: failed[1]!, file, message });
  });
  return { runner: 'bun test', passed: count('pass'), failed: count('fail'), skipped: count('skip') + count('todo'), durationMs: ran?.[1] ? milliseconds(ran[1], ran[2]!) : null, failures, flaky: [], unrecognised: false };
}

function pytest(lines: readonly string[], text: string): TestRun | null {
  const summary = [...text.matchAll(/^=+ (.*?\b(?:passed|failed|errors?|skipped|deselected|xfailed|xpassed|no tests ran)\b.*?) in ([\d.]+)s\b.*=+\s*$/gmu)].at(-1);
  if (!summary) return null;
  const counts = summary[1]!;
  const failures: TestFailure[] = [];
  const failedNames = new Set<string>();
  for (const line of lines) {
    const failed = /^(?:FAILED|ERROR) (\S+?)(?: - (.*))?$/u.exec(line);
    if (!failed || failedNames.has(failed[1]!)) continue;
    failedNames.add(failed[1]!);
    const [file, ...names] = failed[1]!.split('::');
    failures.push({ name: names.length > 0 ? names.join('::') : file!, file: file!, message: failed[2] ?? '' });
  }
  const flaky = [...new Set(lines.flatMap(line => { const rerun = /^(\S+::\S+) RERUN\b/u.exec(line); return rerun && !failedNames.has(rerun[1]!) ? [rerun[1]!] : []; }))];
  const failed = (countOf(counts, /failed/u) ?? 0) + (countOf(counts, /errors?/u) ?? 0);
  return { runner: 'pytest', passed: (countOf(counts, /passed/u) ?? 0) + (countOf(counts, /xpassed/u) ?? 0), failed, skipped: (countOf(counts, /skipped/u) ?? 0) + (countOf(counts, /xfailed/u) ?? 0), durationMs: milliseconds(summary[2]!, 's'), failures, flaky, unrecognised: false };
}

function goTest(lines: readonly string[]): TestRun | null {
  const result = /^\s*--- (PASS|FAIL|SKIP): (\S+) \(([\d.]+)s\)/u;
  const packageLine = /^(ok|FAIL)\s+\S+\s+([\d.]+)s\b/u;
  if (!lines.some(line => result.test(line) || packageLine.test(line))) return null;
  const tally: Record<string, number> = { PASS: 0, FAIL: 0, SKIP: 0 };
  const failures: TestFailure[] = [];
  let durationMs = 0;
  let packages = 0;
  const location = /^\s+(\S+\.go):\d+: ?(.*)$/u;
  lines.forEach((line, index) => {
    const finished = packageLine.exec(line);
    if (finished) { packages++; durationMs += milliseconds(finished[2]!, 's'); return; }
    const outcome = result.exec(line);
    if (!outcome) return;
    tally[outcome[1]!]!++;
    if (outcome[1] !== 'FAIL') return;
    // Without -v a failing test's log follows its --- FAIL line; with -v it comes between === RUN and --- FAIL.
    const after = linesUntil(lines, index + 1, /^\s*(?:---|===) |^\S/u);
    let before: string[] = [];
    if (after.length === 0) {
      const run = lines.slice(0, index).findLastIndex(earlier => earlier.trim() === `=== RUN   ${outcome[2]}`);
      before = run < 0 ? [] : lines.slice(run + 1, index).filter(earlier => location.test(earlier));
    }
    const logged = after.length > 0 ? after : before;
    const file = logged.map(entry => location.exec(entry)?.[1]).find(found => found !== undefined) ?? null;
    failures.push({ name: outcome[2]!, file, message: messageOf(logged.map(entry => entry.replace(location, '$2'))) });
  });
  // Without -v, go test lists only failing tests: a package's passes are only an "ok" line.
  const verbose = tally.PASS! > 0 || tally.SKIP! > 0 || lines.some(line => line.startsWith('=== RUN'));
  return { runner: 'go test', passed: verbose ? tally.PASS! : null, failed: tally.FAIL!, skipped: verbose ? tally.SKIP! : null, durationMs: packages > 0 ? durationMs : null, failures, flaky: [], unrecognised: false };
}

/** The counts an unknown runner's output states in words, the last of each: the summary comes last. */
function unrecognised(text: string): TestRun {
  const last = (word: RegExp) => { const found = [...text.matchAll(new RegExp(`(\\d+) (?:${word.source})\\b`, 'giu'))].at(-1); return found ? Number(found[1]) : null; };
  return { runner: null, passed: last(/passed|passing|pass|ok/u), failed: last(/failed|failing|fail|failures?|errors?/u), skipped: last(/skipped|pending|skip|todo/u), durationMs: null, failures: [], flaky: [], unrecognised: true };
}

/** What a test run's output says: the summary of vitest, jest, bun test, pytest or go test, with its failures. */
function parseTestOutput(output: string): TestRun {
  const lines = plainLines(output);
  const text = lines.join('\n');
  return vitest(lines, text) ?? jest(lines, text) ?? bun(lines, text) ?? pytest(lines, text) ?? goTest(lines) ?? unrecognised(text);
}

/** A TestReport from a test run's output, and whether the output was unrecognised. `cut`: the output held is only part
 * of what the run wrote. */
export function testReportBlock(output: string, cut: boolean): BuiltBlock<z.output<typeof components.TestReport.props>> & { unrecognised: boolean } {
  const run = parseTestOutput(output);
  const notes = [
    ...run.unrecognised ? [`Unrecognised test output: ${[run.passed, run.failed, run.skipped].some(count => count !== null) ? 'only the counts it states are shown, and no failures' : 'it states no counts'}.`] : [],
    ...cut ? ['The run\'s output was cut; this reads the part kept.'] : [],
    ...run.runner === 'go test' && run.passed === null ? ['go test lists passing tests only with -v.'] : [],
    ...run.failures.length > MAX_FAILURES ? [`${MAX_FAILURES} of ${run.failures.length} failures shown.`] : [],
  ];
  const props = {
    runner: run.runner, passed: run.passed, failed: run.failed, skipped: run.skipped, durationMs: run.durationMs,
    failures: run.failures.slice(0, MAX_FAILURES).map(failure => ({ name: clip(failure.name, 300), file: failure.file === null ? null : clip(failure.file, 300), message: clip(failure.message, FAILURE_MESSAGE_CHARACTERS) })),
    flaky: run.flaky.length > 0 ? run.flaky.slice(0, 40).map(name => clip(name, 300)) : null,
    note: notes.length > 0 ? notes.join(' ') : null,
  };
  return { ...ready('TestReport', components.TestReport.props, props), unrecognised: run.unrecognised };
}
