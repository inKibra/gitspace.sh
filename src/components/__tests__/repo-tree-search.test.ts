import { describe, expect, it } from 'bun:test';
import { filterRepoTreeEntries, type RepoTreeEntry } from '../repo-tree-search.js';

const entries: RepoTreeEntry[] = [
  { path: 'src/API/Client.ts' },
  { path: 'src/feature/changed.ts' },
  { path: 'docs/architecture.md' },
  { path: 'scratch/new-note.md', status: '?' },
];

describe('filterRepoTreeEntries', () => {
  it('matches relative paths case-insensitively while leaving unrelated loaded entries out', () => {
    expect(filterRepoTreeEntries(entries, new Set(), 'all', ' api/client '))
      .toEqual([{ path: 'src/API/Client.ts' }]);
  });

  it('restores every entry in the current tree scope when a filename query is cleared', () => {
    const changedPaths = new Set(['src/feature/changed.ts']);

    expect(filterRepoTreeEntries(entries, changedPaths, 'changed', 'changed.ts'))
      .toEqual([{ path: 'src/feature/changed.ts' }]);
    expect(filterRepoTreeEntries(entries, changedPaths, 'changed', '   '))
      .toEqual([
        { path: 'src/feature/changed.ts' },
        { path: 'scratch/new-note.md', status: '?' },
      ]);
  });

  it('keeps tracked changed files and status-marked entries in the Changed scope', () => {
    expect(filterRepoTreeEntries(entries, new Set(['src/feature/changed.ts']), 'changed', ''))
      .toEqual([
        { path: 'src/feature/changed.ts' },
        { path: 'scratch/new-note.md', status: '?' },
      ]);
  });
});
