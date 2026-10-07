import { expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeAttachmentSchema, RuntimeGitCheckpointSchema, RuntimeToolDispatchSchema, type RuntimeGitCheckpoint } from '@gitspace/protocol-runtime';
import { executeMachineTool, type MachineToolOptions } from './tools.js';
import { pinnedRipgrep } from '../../deployment/src/native-build.js';
import { machineToolEnvironment } from '../../deployment/src/native-runtime.js';
import { searchSnapshotFiles, type SearchArguments } from '../../protocol-runtime/src/search.js';

const unused = async (): Promise<never> => { throw new Error('Unexpected search dependency'); };

test('search advertised file filters change real search results and find rejects unsupported glob', async () => {
  const rootPath = await mkdtemp(join(tmpdir(), 'runtime-search-contract-'));
  const previousRipgrep = process.env.GITSPACE_RIPGREP_PATH;
  const ripgrep = await pinnedRipgrep();
  const decoy = await mkdtemp(join(tmpdir(), 'runtime-search-ambient-'));
  let searchPath = '';
  const attachment = RuntimeAttachmentSchema.parse({ attachmentId: 'attachment', projectId: 'project', workspaceId: 'workspace', machineId: 'machine', generation: 1, role: 'primary', checkout: { kind: 'shared', branch: 'main' }, state: 'ready', capabilities: ['grep', 'find'], updatedAt: new Date().toISOString() });
  const local = { attachment, rootPath, executionSecret: 'unused', prerequisitesComplete: true };
  const options: MachineToolOptions = { runCommand: command => {
    const { promise, resolve, reject } = Promise.withResolvers<{ exitCode: number; output: string }>();
    execFile(command.application, command.args, { cwd: command.cwd, env: { ...process.env, PATH: searchPath } }, (error, stdout, stderr) => {
      if (error && (typeof error.code !== 'number' || error.code > 1)) { reject(error); return; }
      resolve({ exitCode: error?.code === 1 ? 1 : 0, output: stdout || stderr });
    });
    return promise;
  }, artifacts: () => ({ read: unused, write: unused }) };
  const search = async (tool: 'find' | 'grep', args: SearchArguments, snapshot?: RuntimeGitCheckpoint) => {
    const dispatch = RuntimeToolDispatchSchema.parse({ conversationKind: 'main', version: 1, conversationId: 'conversation', taskId: 'task', attachmentId: 'attachment', projectId: 'project', workspaceId: 'workspace', machineId: 'machine', generation: 1, requestId: 'request', attemptId: 'attempt', tool, args, snapshot, deadlineAt: new Date(Date.now() + 60000).toISOString(), replay: 'safe' });
    const content = await executeMachineTool(dispatch, local, new AbortController().signal, options);
    return content.flatMap(item => item.type === 'text' ? item.text.trim().split('\n') : []).map(line => line.replace(`${rootPath}/`, '')).sort();
  };
  try {
    const decoyMarker = join(decoy, 'ambient-executed');
    await writeFile(join(decoy, 'rg'), `#!/bin/sh\nprintf malicious > '${decoyMarker}'\nexit 99\n`, { mode: 0o755 });
    process.env.GITSPACE_RIPGREP_PATH = machineToolEnvironment({ GITSPACE_RIPGREP_PATH: join(decoy, 'rg') }, { gitLfs: null, ripgrep: ripgrep.path }).GITSPACE_RIPGREP_PATH;
    await mkdir(join(rootPath, 'src'));
    await mkdir(join(rootPath, 'other'));
    await writeFile(join(rootPath, 'src', 'a.ts'), 'needle\n');
    await writeFile(join(rootPath, 'src', 'b.md'), 'needle\nalternate\n');
    await writeFile(join(rootPath, 'other', 'c.ts'), 'needle\n');
    const findCases = {
      pattern: { args: { pattern: '*.md', path: '.' }, expected: ['src/b.md'] },
      path: { args: { pattern: '*.ts', path: 'src' }, expected: ['src/a.ts'] },
    };
    const grepCases = {
      pattern: { args: { pattern: 'alternate', path: '.' }, expected: ['src/b.md:2:alternate'] },
      path: { args: { pattern: 'needle', path: 'other' }, expected: ['other/c.ts:1:needle'] },
      glob: { args: { pattern: 'needle', path: '.', glob: '*.md' }, expected: ['src/b.md:1:needle'] },
    };
    expect(await search('find', { pattern: '*', path: '.' })).toEqual(['other/c.ts', 'src/a.ts', 'src/b.md']);
    expect(await search('grep', { pattern: 'needle', path: '.' })).toEqual(['other/c.ts:1:needle', 'src/a.ts:1:needle', 'src/b.md:1:needle']);
    for (const example of Object.values(findCases)) expect(await search('find', example.args)).toEqual(example.expected);
    for (const example of Object.values(grepCases)) expect(await search('grep', example.args)).toEqual(example.expected);
    searchPath = decoy;
    expect(await search('find', { pattern: '*.ts', path: 'src' })).toEqual(['src/a.ts']);
    expect(await search('grep', { pattern: 'needle', path: 'src', glob: '*.md' })).toEqual(['src/b.md:1:needle']);
    expect(await Bun.file(decoyMarker).exists()).toBe(false);
    const parityFiles = [
      { path: '.gitignore', content: '*.log\n!keep.log\nignored/\n' },
      { path: 'src/a.ts', content: 'Needle\nαβ\nstart\nend\n' },
      { path: 'src/b.md', content: 'needle\nneedle again\n' },
      { path: 'other/c.ts', content: 'needle\n' },
      { path: '.hidden', content: 'needle\n' },
      { path: 'keep.log', content: 'needle\n' },
      { path: 'drop.log', content: 'needle\n' },
      { path: 'ignored/a.ts', content: 'needle\n' },
      { path: 'binary', content: 'needle\0\n' },
    ];
    await mkdir(join(rootPath, 'ignored'));
    for (const file of parityFiles) await writeFile(join(rootPath, file.path), file.content);
    const cases: SearchArguments[] = [
      { pattern: '(?i)needle', path: '.' }, { pattern: '\\p{Greek}+', path: '.' },
      { pattern: 'start\\nend', path: '.', multiline: true },
      { pattern: 'needle', path: '.', hidden: true, gitignore: false },
      { pattern: 'needle', path: '.', glob: '*.md' }, { pattern: 'needle', path: 'src', offset: 1, limit: 1 },
      { pattern: 'needle', path: '.', glob: '!*.md' },
    ];
    for (const args of cases) expect(await search('grep', args)).toEqual(searchSnapshotFiles(parityFiles, args).text.split('\n').sort());
    await expect(search('grep', { pattern: '(?=needle)', path: '.' })).rejects.toThrow();
    for (const pattern of ['start\\nend', 'start\nend', '\\x0A', '\\u{A}']) {
      await expect(search('grep', { pattern, path: '.' })).rejects.toThrow();
      expect(() => searchSnapshotFiles(parityFiles, { pattern, path: '.' })).toThrow();
    }
    const exec = promisify(execFile);
    const git = async (...args: string[]) => (await exec('git', args, { cwd: rootPath })).stdout.trim();
    await git('init', '-q');
    await git('config', 'user.email', 'local@example.invalid');
    await git('config', 'user.name', 'Local fixture');
    const pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${'a'.repeat(64)}\nsize 999\n`;
    await writeFile(join(rootPath, 'payload.bin'), pointer);
    await git('add', '.');
    await git('commit', '-qm', 'canonical');
    const commit = await git('rev-parse', 'HEAD'), tree = await git('rev-parse', 'HEAD^{tree}');
    const snapshot = RuntimeGitCheckpointSchema.parse({ checkpointRef: 'refs/gitspace/search', branch: 'main', headCommit: commit, indexCommit: commit, trackedWorktreeCommit: commit, worktreeCommit: commit, indexTree: tree, worktreeTree: tree });
    await writeFile(join(rootPath, 'payload.bin'), 'hydrated secret needle\n');
    await writeFile(join(rootPath, 'src/b.md'), 'machine edited needle\n');
    expect(await search('grep', { pattern: 'machine edited|hydrated secret', path: '.', gitignore: false }, snapshot)).toEqual(['']);
    expect(await search('grep', { pattern: 'version https', path: '.' }, snapshot)).toEqual(['payload.bin:1:version https://git-lfs.github.com/spec/v1']);
    expect(await search('grep', { pattern: 'needle', path: 'ignored', gitignore: false }, snapshot)).toEqual(['']);
    expect(await search('grep', { pattern: 'needle', path: 'src/b.md' }, snapshot)).toEqual(['src/b.md:1:needle', 'src/b.md:2:needle again']);
    delete process.env.GITSPACE_RIPGREP_PATH;
    await expect(search('grep', { pattern: 'needle', path: '.' })).rejects.toThrow('prepared absolute');
    await expect(search('find', { pattern: '*', path: '.' })).rejects.toThrow('prepared absolute');
    await expect(search('find', { pattern: '*', path: '.', glob: '*.md' })).rejects.toThrow();
  } finally {
    if (previousRipgrep === undefined) delete process.env.GITSPACE_RIPGREP_PATH;
    else process.env.GITSPACE_RIPGREP_PATH = previousRipgrep;
    await rm(rootPath, { recursive: true, force: true });
    await rm(decoy, { recursive: true, force: true });
  }
}, 120_000);
