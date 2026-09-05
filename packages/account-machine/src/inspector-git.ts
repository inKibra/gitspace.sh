import { lstat, readFile, readlink } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import {
  repositoryDiffViewSchema,
  repositoryFileViewSchema,
  repositoryModeSchema,
  repositoryStatusEntrySchema,
  repositoryTreeEntrySchema,
  type RepositoryDiffView,
  type RepositoryFileView,
  type RepositoryMode,
  type RepositoryStatus,
  type RepositoryStatusEntry,
  type RepositoryTreeEntry,
} from '@gitspace/protocol/inspector-contract';

export interface InspectorRepositoryContext {
  repositoryPath: string;
  spaceId: string;
  generation: number;
  baseRef: string;
}

export interface InspectorRepositoryRead extends InspectorRepositoryContext {
  mode: RepositoryMode;
  path?: string;
}

interface GitResult {
  stdout: Uint8Array;
  stderr: string;
}

export interface RepositoryIdentity {
  headCommit: string;
  baseCommit: string;
}

interface ParsedStatus {
  path: string;
  oldPath: string | null;
  status: RepositoryStatus;
  staged: boolean;
  working: boolean;
  stagedStatus: RepositoryStatus | null;
  workingStatus: RepositoryStatus | null;
}

interface IndexedEntry {
  path: string;
  kind: 'file' | 'symlink';
  blobId: string;
  size: number | null;
}

export class InspectorGitError extends Error {
  readonly name = 'InspectorGitError';

  constructor(readonly operation: string, message: string) {
    super(`${operation}: ${message}`);
  }
}

export async function readRepositoryStatus(input: InspectorRepositoryRead): Promise<RepositoryStatusEntry[]> {
  const context = validateInput(input);
  const identity = await resolveRepositoryIdentity(context);
  const statuses = await statusForMode(context, identity);
  return statuses.map((entry) => repositoryStatusEntrySchema.parse({
    spaceId: context.spaceId,
    generation: context.generation,
    mode: context.mode,
    path: entry.path,
    status: entry.status,
    oldPath: entry.oldPath,
    staged: entry.staged,
    working: entry.working,
  }));
}

export async function readRepositoryTree(input: InspectorRepositoryRead): Promise<RepositoryTreeEntry[]> {
  const context = validateInput(input);
  const identity = await resolveRepositoryIdentity(context);
  const statuses = await statusForMode(context, identity);
  const statusByPath = new Map(statuses.map((entry) => [entry.path, entry]));
  const selectedPath = context.path === undefined ? undefined : safeRepositoryPath(context.repositoryPath, context.path);
  const entries = context.mode === 'base'
    ? await commitTreeEntries(context.repositoryPath, identity.baseCommit, selectedPath)
    : context.mode === 'staged'
      ? await indexTreeEntries(context.repositoryPath, selectedPath)
      : await worktreeEntries(context.repositoryPath, selectedPath);

  for (const status of statuses) {
    if (status.status !== 'deleted' || entries.some((entry) => entry.path === status.path)) continue;
    if (selectedPath && status.path !== selectedPath && !status.path.startsWith(`${selectedPath}/`)) continue;
    const blobId = await objectAtPath(context.repositoryPath, context.mode === 'base' ? identity.baseCommit : identity.headCommit, status.path);
    if (!blobId) throw new InspectorGitError('read tree', `${status.path} is missing from ${context.mode} commit`);
    entries.push({ path: status.path, kind: 'file', blobId, size: null });
  }

  const selectedEntries = entries
    .filter((entry) => visibleInspectorPath(entry.path))
    .sort((left, right) => left.path.split('/').length - right.path.split('/').length || left.path.localeCompare(right.path))
    .slice(0, 180);
  const tree: RepositoryTreeEntry[] = [];
  const directoryStatuses = new Map<string, RepositoryStatus>();
  for (const entry of selectedEntries) {
    const status = statusByPath.get(entry.path)?.status ?? 'clean';
    const parts = entry.path.split('/');
    for (let index = 1; index < parts.length; index += 1) {
      const directory = parts.slice(0, index).join('/');
      const existing = directoryStatuses.get(directory);
      if (existing === undefined || existing === 'clean') directoryStatuses.set(directory, status);
    }
    tree.push(repositoryTreeEntrySchema.parse({
      spaceId: context.spaceId,
      generation: context.generation,
      mode: context.mode,
      path: entry.path,
      name: basename(entry.path),
      kind: entry.kind,
      status,
      oldPath: statusByPath.get(entry.path)?.oldPath ?? null,
      blobId: entry.blobId,
      size: entry.size,
    }));
  }
  for (const [path, status] of directoryStatuses) {
    tree.push(repositoryTreeEntrySchema.parse({
      spaceId: context.spaceId,
      generation: context.generation,
      mode: context.mode,
      path,
      name: basename(path),
      kind: 'directory',
      status,
      oldPath: null,
      blobId: null,
      size: null,
    }));
  }
  return tree
    .sort((left, right) => left.path.split('/').length - right.path.split('/').length || left.path.localeCompare(right.path) || (left.kind === 'directory' ? -1 : 1))
    .slice(0, 200);
}

export async function readRepositoryFile(input: InspectorRepositoryRead & { path: string }): Promise<RepositoryFileView> {
  const context = validateInput(input);
  const path = safeRepositoryPath(context.repositoryPath, input.path);
  const identity = await resolveRepositoryIdentity(context);
  let bytes: Uint8Array;
  let kind: 'file' | 'symlink';
  let blobId: string;
  let commitId: string;

  if (context.mode === 'base') {
    const entry = await indexedPath(context.repositoryPath, identity.baseCommit, path);
    if (!entry) throw new InspectorGitError('read file', `${path} does not exist at ${identity.baseCommit}`);
    bytes = (await runGit(context.repositoryPath, ['cat-file', 'blob', entry.blobId])).stdout;
    kind = entry.kind;
    blobId = entry.blobId;
    commitId = identity.baseCommit;
  } else if (context.mode === 'staged') {
    const entry = (await indexTreeEntries(context.repositoryPath, path)).find((candidate) => candidate.path === path);
    if (!entry) throw new InspectorGitError('read file', `${path} does not exist in the index`);
    bytes = (await runGit(context.repositoryPath, ['cat-file', 'blob', entry.blobId])).stdout;
    kind = entry.kind;
    blobId = entry.blobId;
    commitId = identity.headCommit;
  } else {
    const current = await readWorktreePath(context.repositoryPath, path);
    bytes = current.bytes;
    kind = current.kind;
    blobId = await hashBytes(context.repositoryPath, bytes);
    commitId = identity.headCommit;
  }

  const decoded = decodeContents(bytes);
  const statuses = await statusForMode(context, identity);
  const status = statuses.find((entry) => entry.path === path)?.status ?? 'clean';
  return repositoryFileViewSchema.parse({
    spaceId: context.spaceId,
    generation: context.generation,
    mode: context.mode,
    path,
    kind,
    content: decoded.content,
    encoding: decoded.encoding,
    binary: decoded.binary,
    blobId,
    commitId,
    headCommit: identity.headCommit,
    status,
  });
}

export async function readRepositoryDiff(input: InspectorRepositoryRead): Promise<RepositoryDiffView> {
  const context = validateInput(input);
  const identity = await resolveRepositoryIdentity(context);
  const path = context.path === undefined ? undefined : safeRepositoryPath(context.repositoryPath, context.path);
  let patch: string;
  if (context.mode === 'current') {
    if (!path) throw new InspectorGitError('read diff', 'Current mode requires a file path');
    const file = await readRepositoryFile({ ...context, path });
    patch = fullFilePatch(file, false);
  } else {
    const args = diffArguments(context.mode, identity.baseCommit, false, path);
    patch = text((await runGit(context.repositoryPath, args)).stdout);
    if (context.mode === 'working' || context.mode === 'base') {
      const untracked = (await statusForMode(context, identity)).filter((entry) => entry.status === 'untracked' && (!path || entry.path === path || entry.path.startsWith(`${path}/`)));
      for (const entry of untracked) {
        const file = await readRepositoryFile({ ...context, mode: 'working', path: entry.path });
        patch += `${patch && !patch.endsWith('\n') ? '\n' : ''}${fullFilePatch(file, true)}`;
      }
    }
  }

  const statuses = await statusForMode(context, identity);
  const matching = statuses.filter((entry) => !path || entry.path === path || entry.path.startsWith(`${path}/`));
  const stats = context.mode === 'current'
    ? new Map<string, { additions: number | null; deletions: number | null; binary: boolean }>()
    : await diffStats(context.repositoryPath, diffArguments(context.mode, identity.baseCommit, true, path));
  const files = matching.map((entry) => {
    const stat = stats.get(entry.path);
    return {
      path: entry.path,
      oldPath: entry.oldPath,
      status: entry.status,
      additions: stat?.additions ?? (entry.status === 'untracked' ? countPatchAdditions(patch, entry.path) : null),
      deletions: stat?.deletions ?? null,
      binary: stat?.binary ?? false,
    };
  });
  if (context.mode === 'current' && path) {
    const file = await readRepositoryFile({ ...context, path });
    if (!files.some((entry) => entry.path === path)) {
      files.push({
        path,
        oldPath: null,
        status: file.status,
        additions: file.binary ? null : file.content.split('\n').length,
        deletions: 0,
        binary: file.binary,
      });
    }
  }
  return repositoryDiffViewSchema.parse({
    spaceId: context.spaceId,
    generation: context.generation,
    mode: context.mode,
    path: path ?? null,
    patch,
    baseCommit: context.mode === 'base' ? identity.baseCommit : identity.headCommit,
    headCommit: identity.headCommit,
    files,
  });
}

function validateInput(input: InspectorRepositoryRead): InspectorRepositoryRead {
  const mode = repositoryModeSchema.parse(input.mode);
  if (!Number.isSafeInteger(input.generation) || input.generation < 0) throw new InspectorGitError('validate', 'Generation must be a non-negative safe integer');
  if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(input.spaceId)) throw new InspectorGitError('validate', 'Space id is invalid');
  if (!input.baseRef.trim() || input.baseRef.startsWith('-') || /[\0-\x20\x7f]/u.test(input.baseRef)) throw new InspectorGitError('validate', 'Base ref is invalid');
  const repositoryPath = resolve(input.repositoryPath);
  return { ...input, repositoryPath, mode };
}

function safeRepositoryPath(repositoryPath: string, path: string): string {
  if (isAbsolute(path) || path.includes('\\') || path.includes('\0')) throw new InspectorGitError('validate path', `${path} is not a portable repository path`);
  const normalized = path.split('/');
  if (normalized.some((part) => part === '' || part === '.' || part === '..' || part === '.git')) throw new InspectorGitError('validate path', `${path} is not a portable repository path`);
  const absoluteRepository = resolve(repositoryPath);
  const absolutePath = resolve(absoluteRepository, path);
  const local = relative(absoluteRepository, absolutePath);
  if (local === '' || local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)) throw new InspectorGitError('validate path', `${path} is outside the repository`);
  return local.split(sep).join('/');
}

async function runGit(repositoryPath: string, args: string[], allowFailure = false): Promise<GitResult> {
  const child = Bun.spawn(['git', ...args], { cwd: repositoryPath, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const [exitCode, stdout, stderrBytes] = await Promise.all([
    child.exited,
    new Response(child.stdout).bytes(),
    new Response(child.stderr).bytes(),
  ]);
  const stderr = text(stderrBytes).trim();
  if (exitCode !== 0 && !allowFailure) throw new InspectorGitError(`git ${args[0] ?? ''}`.trim(), stderr || `exited with ${exitCode}`);
  return { stdout: exitCode === 0 ? stdout : new Uint8Array(), stderr };
}

function text(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

export async function readRepositoryIdentity(input: InspectorRepositoryContext): Promise<RepositoryIdentity> {
  return resolveRepositoryIdentity(validateInput({ ...input, mode: 'current' }));
}

async function resolveRepositoryIdentity(input: InspectorRepositoryContext): Promise<RepositoryIdentity> {
  const headCommit = text((await runGit(input.repositoryPath, ['rev-parse', '--verify', 'HEAD^{commit}'])).stdout).trim();
  const baseTip = text((await runGit(input.repositoryPath, ['rev-parse', '--verify', `${input.baseRef}^{commit}`])).stdout).trim();
  const baseCommit = text((await runGit(input.repositoryPath, ['merge-base', headCommit, baseTip])).stdout).trim();
  return { headCommit, baseCommit };
}

async function statusForMode(input: InspectorRepositoryRead, identity: RepositoryIdentity): Promise<ParsedStatus[]> {
  const pathspec = input.path ? ['--', input.path] : [];
  if (input.mode === 'base') {
    const raw = text((await runGit(input.repositoryPath, ['diff', '--name-status', '-z', '--find-renames', identity.baseCommit, ...pathspec])).stdout);
    const statuses = parseNameStatus(raw, true, true);
    const current = parsePorcelain(text((await runGit(input.repositoryPath, ['status', '--porcelain=v1', '-z', '--untracked-files=all', ...pathspec])).stdout));
    for (const untracked of current.filter((entry) => entry.status === 'untracked')) if (!statuses.some((entry) => entry.path === untracked.path)) statuses.push(untracked);
    return statuses.sort((left, right) => left.path.localeCompare(right.path));
  }
  const all = parsePorcelain(text((await runGit(input.repositoryPath, ['status', '--porcelain=v1', '-z', '--untracked-files=all', ...pathspec])).stdout));
  if (input.mode === 'current') return all;
  return all.filter((entry) => input.mode === 'staged' ? entry.staged : entry.working).map((entry) => ({
    ...entry,
    status: (input.mode === 'staged' ? entry.stagedStatus : entry.workingStatus) ?? entry.status,
  }));
}

function parsePorcelain(raw: string): ParsedStatus[] {
  const fields = raw.split('\0');
  const statuses: ParsedStatus[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (!field) continue;
    if (field.length < 4) throw new InspectorGitError('parse status', `Malformed status record ${JSON.stringify(field)}`);
    const x = field[0]!;
    const y = field[1]!;
    const path = field.slice(3);
    let oldPath: string | null = null;
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') oldPath = fields[++index] || null;
    const conflicted = x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D');
    const code = conflicted ? 'U' : x === '?' ? '?' : y !== ' ' ? y : x;
    statuses.push({
      path,
      oldPath,
      status: statusFromCode(code),
      staged: x !== ' ' && x !== '?',
      working: y !== ' ' || x === '?',
      stagedStatus: conflicted ? 'conflicted' : x !== ' ' && x !== '?' ? statusFromCode(x) : null,
      workingStatus: conflicted ? 'conflicted' : x === '?' ? 'untracked' : y !== ' ' ? statusFromCode(y) : null,
    });
  }
  return statuses.sort((left, right) => left.path.localeCompare(right.path));
}

function parseNameStatus(raw: string, staged: boolean, working: boolean): ParsedStatus[] {
  const fields = raw.split('\0');
  const statuses: ParsedStatus[] = [];
  for (let index = 0; index < fields.length;) {
    let code = fields[index++] ?? '';
    if (!code) continue;
    let inlinePath: string | undefined;
    const tab = code.indexOf('\t');
    if (tab >= 0) {
      inlinePath = code.slice(tab + 1);
      code = code.slice(0, tab);
    }
    const status = statusFromCode(code[0]!);
    if (code.startsWith('R') || code.startsWith('C')) {
      const oldPath = inlinePath ?? fields[index++] ?? '';
      const path = fields[index++] ?? '';
      if (path) statuses.push({ path, oldPath, status, staged, working, stagedStatus: staged ? status : null, workingStatus: working ? status : null });
    } else {
      const path = inlinePath ?? fields[index++] ?? '';
      if (path) statuses.push({ path, oldPath: null, status, staged, working, stagedStatus: staged ? status : null, workingStatus: working ? status : null });
    }
  }
  return statuses;
}

function statusFromCode(code: string): RepositoryStatus {
  if (code === '?' ) return 'untracked';
  if (code === 'A') return 'added';
  if (code === 'D') return 'deleted';
  if (code === 'R') return 'renamed';
  if (code === 'C') return 'copied';
  if (code === 'U') return 'conflicted';
  return 'modified';
}

function visibleInspectorPath(path: string): boolean {
  return !path.startsWith('.gitspace/environments/')
    && !path.startsWith('.gitspace/artifacts/')
    && !path.startsWith('node_modules/')
    && !path.startsWith('dist/');
}

async function worktreeEntries(repositoryPath: string, selectedPath?: string): Promise<IndexedEntry[]> {
  const entries = await indexTreeEntries(repositoryPath, selectedPath);
  const tracked = new Set(entries.map((entry) => entry.path));
  const args = ['ls-files', '-z', '--others', '--exclude-standard'];
  if (selectedPath) args.push('--', selectedPath);
  const paths = text((await runGit(repositoryPath, args)).stdout).split('\0').filter(Boolean)
    .filter(visibleInspectorPath)
    .sort((left, right) => left.split('/').length - right.split('/').length || left.localeCompare(right))
    .slice(0, 180);
  for (const path of paths) {
    if (path.endsWith('/') || tracked.has(path)) continue;
    try {
      const current = await readWorktreePath(repositoryPath, path);
      entries.push({ path, kind: current.kind, blobId: await hashBytes(repositoryPath, current.bytes), size: current.bytes.byteLength });
    } catch (error) {
      if (!(error instanceof InspectorGitError) || !error.message.includes('does not exist')) throw error;
    }
  }
  return entries;
}

async function indexTreeEntries(repositoryPath: string, selectedPath?: string): Promise<IndexedEntry[]> {
  const args = ['ls-files', '--stage', '-z'];
  if (selectedPath) args.push('--', selectedPath);
  const records = text((await runGit(repositoryPath, args)).stdout).split('\0').filter(Boolean);
  const entries: IndexedEntry[] = [];
  for (const record of records) {
    const match = /^(\d{6}) ([a-f0-9]{40,64}) (\d)\t(.*)$/u.exec(record);
    if (!match || match[3] !== '0') continue;
    entries.push({ path: match[4]!, kind: match[1] === '120000' ? 'symlink' : 'file', blobId: match[2]!, size: null });
  }
  return entries;
}

async function commitTreeEntries(repositoryPath: string, commit: string, selectedPath?: string): Promise<IndexedEntry[]> {
  const args = ['ls-tree', '-rz', '--full-tree', '--long', commit];
  if (selectedPath) args.push('--', selectedPath);
  const records = text((await runGit(repositoryPath, args)).stdout).split('\0').filter(Boolean);
  const entries: IndexedEntry[] = [];
  for (const record of records) {
    const match = /^(\d{6}) blob ([a-f0-9]{40,64})\s+(-|\d+)\t(.*)$/u.exec(record);
    if (!match) continue;
    entries.push({ path: match[4]!, kind: match[1] === '120000' ? 'symlink' : 'file', blobId: match[2]!, size: match[3] === '-' ? null : Number(match[3]) });
  }
  return entries;
}

async function indexedPath(repositoryPath: string, commit: string, path: string): Promise<IndexedEntry | null> {
  return (await commitTreeEntries(repositoryPath, commit, path)).find((entry) => entry.path === path) ?? null;
}

async function objectAtPath(repositoryPath: string, commit: string, path: string): Promise<string | null> {
  return (await indexedPath(repositoryPath, commit, path))?.blobId ?? null;
}

async function readWorktreePath(repositoryPath: string, path: string): Promise<{ bytes: Uint8Array; kind: 'file' | 'symlink' }> {
  const portable = safeRepositoryPath(repositoryPath, path);
  const absolute = resolve(repositoryPath, portable);
  let stat;
  try {
    stat = await lstat(absolute);
  } catch {
    throw new InspectorGitError('read file', `${portable} does not exist`);
  }
  if (stat.isSymbolicLink()) return { bytes: new TextEncoder().encode(await readlink(absolute)), kind: 'symlink' };
  if (!stat.isFile()) throw new InspectorGitError('read file', `${portable} is not a file`);
  return { bytes: await readFile(absolute), kind: 'file' };
}

async function hashBytes(repositoryPath: string, bytes: Uint8Array): Promise<string> {
  const owned = new Uint8Array(bytes);
  const child = Bun.spawn(['git', 'hash-object', '--stdin'], { cwd: repositoryPath, stdin: new Blob([owned.buffer]), stdout: 'pipe', stderr: 'pipe' });
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (exitCode !== 0) throw new InspectorGitError('git hash-object', stderr.trim() || `exited with ${exitCode}`);
  return stdout.trim();
}

function decodeContents(bytes: Uint8Array): { content: string; encoding: 'utf-8' | 'base64'; binary: boolean } {
  if (bytes.includes(0)) return { content: Buffer.from(bytes).toString('base64'), encoding: 'base64', binary: true };
  try {
    return { content: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8', binary: false };
  } catch {
    return { content: Buffer.from(bytes).toString('base64'), encoding: 'base64', binary: true };
  }
}

function diffArguments(mode: RepositoryMode, baseCommit: string, numstat: boolean, path?: string): string[] {
  const args = ['diff', '--no-ext-diff'];
  if (numstat) args.push('--numstat', '-z');
  else args.push('--binary', '--no-color');
  if (mode === 'staged') args.push('--cached');
  else if (mode === 'base') args.push(baseCommit);
  args.push('--');
  if (path) args.push(path);
  return args;
}

async function diffStats(repositoryPath: string, args: string[]): Promise<Map<string, { additions: number | null; deletions: number | null; binary: boolean }>> {
  const raw = text((await runGit(repositoryPath, args)).stdout);
  const fields = raw.split('\0');
  const stats = new Map<string, { additions: number | null; deletions: number | null; binary: boolean }>();
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (!field) continue;
    const match = /^(\d+|-)\t(\d+|-)\t(.*)$/u.exec(field);
    if (!match) continue;
    let path = match[3]!;
    if (!path) {
      index += 2;
      path = fields[index] ?? '';
    }
    if (!path) continue;
    const binary = match[1] === '-' || match[2] === '-';
    stats.set(path, { additions: binary ? null : Number(match[1]), deletions: binary ? null : Number(match[2]), binary });
  }
  return stats;
}

function fullFilePatch(file: RepositoryFileView, added: boolean): string {
  if (file.binary) return `diff --git a/${file.path} b/${file.path}\nBinary files ${added ? '/dev/null' : `a/${file.path}`} and b/${file.path} differ\n`;
  const lines = file.content.endsWith('\n') ? file.content.slice(0, -1).split('\n') : file.content.split('\n');
  const oldCount = added ? 0 : lines.length;
  const prefix = added ? '+' : ' ';
  return [
    `diff --git a/${file.path} b/${file.path}`,
    added ? 'new file mode 100644' : `index ${file.blobId.slice(0, 7)}..${file.blobId.slice(0, 7)} 100644`,
    added ? '--- /dev/null' : `--- a/${file.path}`,
    `+++ b/${file.path}`,
    `@@ -${added ? '0,0' : `1,${oldCount}`} +1,${lines.length} @@`,
    ...lines.map((line) => `${prefix}${line}`),
    '',
  ].join('\n');
}

function countPatchAdditions(patch: string, path: string): number | null {
  const marker = `diff --git a/${path} b/${path}`;
  const start = patch.indexOf(marker);
  if (start < 0) return null;
  const end = patch.indexOf('\ndiff --git ', start + marker.length);
  const section = patch.slice(start, end < 0 ? undefined : end);
  return section.split('\n').filter((line) => line.startsWith('+') && !line.startsWith('+++')).length;
}
