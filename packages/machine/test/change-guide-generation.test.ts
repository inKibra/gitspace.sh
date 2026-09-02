import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InspectorOverview, JournalEntryView } from '@gitspace/protocol/inspector-contract';
import { buildChangeGuideWorksheet, validateChangeGuideNarration } from '../src/change-guide-generation.js';

const roots: string[] = [];
function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'gitspace-guide-'));
  roots.push(root);
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'guide@example.com');
  git(root, 'config', 'user.name', 'Guide Test');
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'model.ts'), 'export const version = 1;\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'base');
  writeFileSync(join(root, 'src', 'model.ts'), 'export const version = 2;\nexport const enabled = true;\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'change model');
  return root;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('Change Guide generation', () => {
  it('ports the analyzer and grounds stale narration in typed Journal evidence', () => {
    const root = fixture();
    const head = git(root, 'rev-parse', 'HEAD');
    const base = git(root, 'rev-parse', 'HEAD~1');
    const journalEntry: JournalEntryView = {
      projectId: 'project-a', spaceId: 'space-a', id: 'journal-a', sequence: 1, kind: 'decision',
      phaseRunId: null, phase: 'code', title: 'Model contract changed', body: 'Added the enabled state after review.',
      outcome: 'Consumers can distinguish enabled records.', decisions: ['Keep the state explicit.'], surprises: [],
      evidence: [{ kind: 'git', generation: 1, path: 'src/model.ts', blobId: null, commitId: head, label: 'Model diff' }],
      snapshot: null, delta: null, reverted: null, createdAt: '2026-08-31T00:00:00.000Z', createdBy: 'machine-a',
    };
    const overview: InspectorOverview = {
      projectId: 'project-a', spaceId: 'space-a', revision: 0, goal: null, workflow: null, rubric: null,
      journal: { entries: 1, openPhaseRunId: null, recent: [journalEntry] }, changeGuide: null,
      review: { total: 0, unresolved: 0 },
    };
    const worksheet = buildChangeGuideWorksheet({ projectId: 'project-a', spaceId: 'space-a', repositoryPath: root, generation: 1, baseRef: base, overview, journal: [journalEntry] });
    expect(worksheet.covered).toBe(true);
    expect(worksheet.headCommit).toBe(head);
    expect(worksheet.clusters).toHaveLength(1);
    expect(worksheet.clusters[0]!.journal[0]?.entryId).toBe('journal-a');
    const cluster = worksheet.clusters[0]!;
    const guide = validateChangeGuideNarration(worksheet, {
      projectId: 'project-a', spaceId: 'space-a', expectedGeneration: 1, expectedRevision: 0,
      headCommit: head, baseRef: base, title: 'Model change', createdBy: 'narrator-a',
      sections: [{ id: cluster.id, title: 'Step 1 — Model contract', kind: 'decision', explanation: 'The model now exposes an explicit enabled state.', why: 'Consumers no longer infer state.', exhibits: [{ path: 'src/model.ts', blobId: null, note: 'Review the new contract.', slowRead: true }], requirementIds: [], contentHash: cluster.contentHash, journalEntryIds: ['journal-a'] }],
    });
    expect(guide.sections[0]?.contentHash).toBe(cluster.contentHash);
    expect(() => validateChangeGuideNarration(worksheet, {
      projectId: 'project-a', spaceId: 'space-a', expectedGeneration: 1, expectedRevision: 0,
      headCommit: head, baseRef: base, title: 'Invalid guide', createdBy: 'narrator-a',
      sections: [{ id: cluster.id, title: 'Invalid exhibit', kind: 'risk', explanation: 'Invalid.', why: '', exhibits: [{ path: 'src/other.ts', blobId: null, note: '', slowRead: false }], requirementIds: [], contentHash: cluster.contentHash }],
    })).toThrow('outside section');
  });
});
