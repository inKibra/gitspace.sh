import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { buildGuideWorksheet, submitGuideSections, readReviewGuide, guideWorksheetPath, type GuideSection } from '../review-guide.js';
import { ensureArtifactsRepo, ensureArtifactsMount, artifactsMountDir } from '../artifacts.js';

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

  it('rejects an object entry in asks at submit', async () => {
    // Observed in the wild: a narrator mirrored the sibling `callouts` shape
    // ({tone, text}) into `asks`, which is a plain string list. It validated,
    // persisted, and then React threw "Objects are not valid as a React child"
    // out of the guide pane — white-screening the entire app via the
    // ErrorBoundary rather than degrading one section.
    const ws = await buildGuideWorksheet('demo', 'ws1', 'main');
    const sections = ws.clusters.map((c) => sectionFor(c.id, c.files));
    sections[0] = { ...sections[0]!, asks: [{ text: 'Is the CI job worth it?' } as unknown as string] };

    await expect(submitGuideSections('demo', 'ws1', { headSha: ws.headSha, sections }))
      .rejects.toThrow(/non-string entry in "asks"/);
  });

  it('heals an already-committed guide whose asks carry objects', async () => {
    // Submit now refuses this shape, but guides written before it do exist on
    // artifact branches; reading one must not hand the renderer an object.
    const ws = await buildGuideWorksheet('demo', 'ws1', 'main');
    await submitGuideSections('demo', 'ws1', { headSha: ws.headSha, sections: ws.clusters.map((c) => sectionFor(c.id, c.files)) });

    const guidePath = join(workspaceDir, '.gitspace', 'artifacts', 'review', 'guide.json');
    const raw = JSON.parse(readFileSync(guidePath, 'utf8'));
    raw.sections[0].asks = [{ text: 'Is the CI job worth it?' }, 'plain string', { nope: 1 }, 42];
    writeFileSync(guidePath, JSON.stringify(raw));

    const healed = readReviewGuide('demo', 'ws1');
    expect(healed?.sections[0]?.asks).toEqual(['Is the CI job worth it?', 'plain string']);
    for (const ask of healed?.sections[0]?.asks ?? []) expect(typeof ask).toBe('string');
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

    // The mismatch must name the worksheet FILE. Narrating the wrong
    // review/analysis.json presents identically to a moved HEAD, and an error
    // that only says "re-run analyze" sends the narrator round a loop that
    // rewrites a file it is not reading.
    await expect(submitGuideSections('demo', 'ws1', { headSha: 'deadbeef'.repeat(5), sections: good }))
      .rejects.toThrow(new RegExp(`Worksheet at ${guideWorksheetPath('demo', 'ws1')} is for \\w+ but submission targets deadbee`));
    await expect(submitGuideSections('demo', 'ws1', { headSha: ws.headSha, sections: [...good, sectionFor('nope00000000', ['x'])] }))
      .rejects.toThrow(/unknown cluster/);
    const badExhibit = [{ ...good[0]!, exhibits: [{ file: 'not/in/cluster.ts' }] }, ...good.slice(1)];
    await expect(submitGuideSections('demo', 'ws1', { headSha: ws.headSha, sections: badExhibit }))
      .rejects.toThrow(/must stay inside/);
    await expect(submitGuideSections('demo', 'ws1', { headSha: ws.headSha, sections: [] }))
      .rejects.toThrow(/Coverage/);
  });

  it('a goal-owning workspace advertises its goal-scoped worksheet, not the mount root', async () => {
    // Reproduction: analyze printed a hardcoded `<mount>/review/analysis.json`
    // while writing to `goals/<goal-id>/review/analysis.json`. The root path is
    // not empty — it holds the worksheet a goal-less workspace writes, which
    // reaches every mount once it rolls up to main. So the narrator read a
    // real, parseable worksheet for an unrelated diff instead of getting ENOENT,
    // and re-running analyze changed nothing it could see.
    const goalDir = join(workspaceDir, '.gitspace', 'workspace', 'ws1');
    mkdirSync(goalDir, { recursive: true });
    writeFileSync(join(goalDir, 'goal.json'), JSON.stringify({ id: 'g-42' }));

    const mount = artifactsMountDir(workspaceDir);
    const decoy = join(mount, 'review', 'analysis.json');
    mkdirSync(dirname(decoy), { recursive: true });
    writeFileSync(decoy, JSON.stringify({ headSha: 'dec0yde', baseRef: 'main', clusters: [], cachedSections: 0 }));

    const ws = await buildGuideWorksheet('demo', 'ws1', 'main');
    const advertised = guideWorksheetPath('demo', 'ws1');

    expect(advertised).toBe(join(mount, 'goals', 'g-42', 'review', 'analysis.json'));
    expect(JSON.parse(readFileSync(advertised, 'utf8')).headSha).toBe(ws.headSha);
    // The unrelated worksheet is left exactly as it was — nothing rewrites it,
    // which is why reading it looked like analyze had ignored --base.
    expect(JSON.parse(readFileSync(decoy, 'utf8')).headSha).toBe('dec0yde');
    expect(advertised).not.toBe(decoy);
  });
});
