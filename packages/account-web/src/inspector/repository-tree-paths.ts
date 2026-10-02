import type { FileTree } from '@pierre/trees';

function directoriesOf(paths: readonly string[]): Set<string> {
  const directories = new Set<string>();
  for (const path of paths) {
    const parts = path.split('/');
    for (let depth = 1; depth < parts.length; depth++) directories.add(parts.slice(0, depth).join('/'));
  }
  return directories;
}

/**
 * Applies a new path list to the tree only when its contents change. Refreshes deliver new
 * arrays with the same paths; resetting on those would collapse every folder the user opened.
 * A real change keeps each expanded folder that still exists.
 */
export function syncRepositoryTreePaths(model: Pick<FileTree, 'getItem' | 'resetPaths'>, previous: readonly string[], next: readonly string[]): void {
  if (previous.length === next.length && previous.every((path, index) => path === next[index])) return;
  const remaining = directoriesOf(next);
  const expanded = [...directoriesOf(previous)].filter((directory) => {
    if (!remaining.has(directory)) return false;
    const item = model.getItem(directory);
    return item !== null && 'isExpanded' in item && item.isExpanded();
  });
  model.resetPaths(next, { initialExpandedPaths: expanded });
}
