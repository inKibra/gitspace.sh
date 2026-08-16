import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  recordEditBreadcrumb,
  pendingBreadcrumbs,
  flushEditBreadcrumbs,
  discardEditBreadcrumbs,
  extractBreadcrumbFile,
} from '../edit-breadcrumbs.js';
import { ensureArtifactsRepo, ensureArtifactsMount } from '../../../../core/artifacts.js';

let root: string;
let projectDir: string;
let workspaceDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'crumbs-'));
  projectDir = join(root, 'project');
  workspaceDir = join(projectDir, 'workspaces', 'ws1');
  mkdirSync(workspaceDir, { recursive: true });
  execFileSync('git', ['init', '-q', workspaceDir]);
});

afterEach(() => {
  discardEditBreadcrumbs(workspaceDir);
  rmSync(root, { recursive: true, force: true });
});

describe('recordEditBreadcrumb', () => {
  it('buffers mutating tools and relativizes workspace paths', () => {
    recordEditBreadcrumb(workspaceDir, 's1', 'edit', { file_path: join(workspaceDir, 'src/a.ts') });
    recordEditBreadcrumb(workspaceDir, 's1', 'write', { path: 'src/b.ts' });
    const crumbs = pendingBreadcrumbs(workspaceDir);
    expect(crumbs.map((c) => c.file)).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('ignores read-only tools and pathless bash', () => {
    recordEditBreadcrumb(workspaceDir, 's1', 'read', { file_path: 'src/a.ts' });
    recordEditBreadcrumb(workspaceDir, 's1', 'grep', { pattern: 'x' });
    recordEditBreadcrumb(workspaceDir, 's1', 'bash', { command: 'rm -rf dist' });
    expect(pendingBreadcrumbs(workspaceDir)).toHaveLength(0);
  });

  it('extracts the first known path key', () => {
    expect(extractBreadcrumbFile('edit', { filePath: 'x.ts' })).toBe('x.ts');
    expect(extractBreadcrumbFile('edit', { nope: 1 })).toBeNull();
    expect(extractBreadcrumbFile('edit', null)).toBeNull();
  });
});

describe('flushEditBreadcrumbs', () => {
  it('appends JSONL to blame/edits.jsonl on the artifacts branch', async () => {
    await ensureArtifactsRepo(projectDir);
    const mount = await ensureArtifactsMount(projectDir, workspaceDir, 'ws1');
    recordEditBreadcrumb(workspaceDir, 's1', 'edit', { file_path: 'src/a.ts' });
    recordEditBreadcrumb(workspaceDir, 's1', 'write', { file_path: 'src/b.ts' });

    const flushed = await flushEditBreadcrumbs(workspaceDir, projectDir);
    expect(flushed).toBe(2);
    expect(pendingBreadcrumbs(workspaceDir)).toHaveLength(0);

    const log = readFileSync(join(mount, 'blame/edits.jsonl'), 'utf8').trim().split('\n');
    expect(log).toHaveLength(2);
    expect(JSON.parse(log[0]!)).toMatchObject({ sessionId: 's1', toolName: 'edit', file: 'src/a.ts' });

    // second flush appends, does not clobber
    recordEditBreadcrumb(workspaceDir, 's2', 'edit', { file_path: 'src/c.ts' });
    await flushEditBreadcrumbs(workspaceDir, projectDir);
    const log2 = readFileSync(join(mount, 'blame/edits.jsonl'), 'utf8').trim().split('\n');
    expect(log2).toHaveLength(3);

    // and the log is committed (versioned), not just working-tree
    const shown = execFileSync('git', ['-C', mount, 'log', '--oneline', '--', 'blame/edits.jsonl'], { encoding: 'utf8' });
    expect(shown.trim().split('\n').length).toBeGreaterThanOrEqual(2);
  });

  it('degrades silently without an artifacts mount', async () => {
    recordEditBreadcrumb(workspaceDir, 's1', 'edit', { file_path: 'src/a.ts' });
    const flushed = await flushEditBreadcrumbs(workspaceDir, projectDir);
    expect(flushed).toBe(0);
    expect(existsSync(join(workspaceDir, '.gitspace/artifacts/blame'))).toBe(false);
  });
});
