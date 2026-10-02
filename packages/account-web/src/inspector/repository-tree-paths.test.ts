import { FileTree } from '@pierre/trees';
import { describe, expect, it } from 'vitest';
import { syncRepositoryTreePaths } from './repository-tree-paths.js';

const expanded = (tree: FileTree, path: string) => {
  const item = tree.getItem(path);
  return item !== null && 'isExpanded' in item && item.isExpanded();
};

describe('repository tree refreshes', () => {
  it('keeps folders the user opened when a refresh delivers the same paths or a changed list', () => {
    const initial = ['src/inspector/Inspector.tsx', 'src/App.tsx', 'README.md'];
    const tree = new FileTree({ paths: initial, initialExpandedPaths: ['src'] });
    const opened = tree.getItem('src/inspector');
    if (!opened || !('expand' in opened)) throw new Error('Expected a directory');
    opened.expand();

    const refreshed = [...initial];
    syncRepositoryTreePaths(tree, initial, refreshed);
    expect(expanded(tree, 'src/inspector')).toBe(true);

    const changed = [...initial, 'src/inspector/Files.tsx', 'docs/guide.md'];
    syncRepositoryTreePaths(tree, refreshed, changed);
    expect(expanded(tree, 'src')).toBe(true);
    expect(expanded(tree, 'src/inspector')).toBe(true);
    expect(tree.getItem('src/inspector/Files.tsx')).not.toBeNull();
    expect(expanded(tree, 'docs')).toBe(false);
  });
});
