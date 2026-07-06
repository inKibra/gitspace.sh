import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { buildGuideWorksheet, submitGuideSections, readReviewGuide, type GuideSection } from '../review-guide.js';
import { ensureArtifactsRepo, ensureArtifactsMount } from '../artifacts.js';

let root: string;
let previousRoot: string | undefined;
let projectDir: string;
let workspaceDir: string;

function sh(cwd: string, args: string[]): void {
  execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { stdio: 'ignore' });
}

function write(path: string, content: string): void {
  const full = join(workspaceDir, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function commitAll(msg: string): void {
  sh(workspaceDir, ['add', '-A']);
  sh(workspaceDir, ['commit', '-q', '-m', msg]);
}

function sectionFor(clusterId: string, files: string[]): GuideSection {
  return {
    clusterId,
    title: 'The core thing',
    kind: 'core',
    explanation: 'Adds thing() and wires the consumer.\n\nConsequence: both call sites now share one path.',
    exhibits: [{ file: files[0]!, slow: true }],
  };
}

beforeEach(async () => {
  root = join(tmpdir(), `guide-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  previousRoot = process.env.GITSPACE_WORKSPACE_ROOT;
  process.env.GITSPACE_WORKSPACE_ROOT = root;
  projectDir = join(root, 'demo');
  workspaceDir = join(projectDir, 'workspaces', 'ws1');
  mkdirSync(workspaceDir, { recursive: true });
  writeFileSync(join(projectDir, '.config.json'), JSON.stringify({ name: 'demo', repository: 'x/y' }));
  sh(projectDir, ['init', '-q', '-b', 'main', workspaceDir]);
  write('src/base.ts', 'export const base = 1;\n');
  commitAll('init');
  sh(workspaceDir, ['checkout', '-q', '-b', 'feature']);
  write('src/core/thing.ts', 'export function thing() { return 1; }\n');
  write('src/use.ts', "import { thing } from './core/thing.js';\nexport const u = thing();\n");
  commitAll('feat: add thing and wire consumer');
  await ensureArtifactsRepo(projectDir);
  await ensureArtifactsMount(projectDir, workspaceDir, 'ws1');
});

afterEach(() => {
  if (previousRoot === undefined) delete process.env.GITSPACE_WORKSPACE_ROOT;
  else process.env.GITSPACE_WORKSPACE_ROOT = previousRoot;
  rmSync(root, { recursive: true, force: true });
});

describe('review guide worksheet + submit', () => {
  it('worksheet marks everything stale on first run; valid submission commits the guide', async () => {
    const ws = await buildGuideWorksheet('demo', 'ws1', 'main');
    expect(ws.clusters.length).toBeGreaterThanOrEqual(1);
    expect(ws.clusters.every((c) => c.stale)).toBe(true);

    const sections = ws.clusters.map((c) => sectionFor(c.id, c.files));
    const guide = await submitGuideSections('demo', 'ws1', { headSha: ws.headSha, sections });
    expect(guide.sections).toHaveLength(ws.clusters.length);
    expect(readReviewGuide('demo', 'ws1')?.headSha).toBe(ws.headSha);
  });

  it('unchanged clusters carry cached prose; only new clusters need narration', async () => {
    const ws1 = await buildGuideWorksheet('demo', 'ws1', 'main');
    await submitGuideSections('demo', 'ws1', { headSha: ws1.headSha, sections: ws1.clusters.map((c) => sectionFor(c.id, c.files)) });

    // new unrelated file → new cluster; old cluster id unchanged
    write('docs/new.md', 'hello\n');
    commitAll('docs: add note');
    const ws2 = await buildGuideWorksheet('demo', 'ws1', 'main');
    const stale = ws2.clusters.filter((c) => c.stale);
    const cachedCount = ws2.clusters.length - stale.length;
    expect(cachedCount).toBeGreaterThanOrEqual(1);

    // submitting ONLY the stale sections passes coverage; cached prose survives
    const guide = await submitGuideSections('demo', 'ws1', {
      headSha: ws2.headSha,
      sections: stale.map((c) => sectionFor(c.id, c.files)),
    });
    expect(guide.sections).toHaveLength(ws2.clusters.length);
    expect(guide.headSha).toBe(ws2.headSha);
  });

  it('rejects: stale sha, unknown cluster, out-of-cluster exhibit, missing coverage', async () => {
    const ws = await buildGuideWorksheet('demo', 'ws1', 'main');
    const good = ws.clusters.map((c) => sectionFor(c.id, c.files));

    await expect(submitGuideSections('demo', 'ws1', { headSha: 'deadbeef'.repeat(5), sections: good }))
      .rejects.toThrow(/re-run analyze/);
    await expect(submitGuideSections('demo', 'ws1', { headSha: ws.headSha, sections: [...good, sectionFor('nope00000000', ['x'])] }))
      .rejects.toThrow(/unknown cluster/);
    const badExhibit = [{ ...good[0]!, exhibits: [{ file: 'not/in/cluster.ts' }] }, ...good.slice(1)];
    await expect(submitGuideSections('demo', 'ws1', { headSha: ws.headSha, sections: badExhibit }))
      .rejects.toThrow(/must stay inside/);
    await expect(submitGuideSections('demo', 'ws1', { headSha: ws.headSha, sections: [] }))
      .rejects.toThrow(/Coverage/);
  });
});
