export interface RepoTreeEntry {
  path: string;
  status?: string;
}

/** Applies the active tree scope, then a case-insensitive relative-path filter. */
export function filterRepoTreeEntries(
  entries: readonly RepoTreeEntry[],
  changedPaths: ReadonlySet<string>,
  treeFilter: 'all' | 'changed',
  query: string,
): RepoTreeEntry[] {
  const scoped = treeFilter === 'changed'
    ? entries.filter((entry) => changedPaths.has(entry.path) || Boolean(entry.status))
    : entries;
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return normalizedQuery
    ? scoped.filter((entry) => entry.path.toLocaleLowerCase().includes(normalizedQuery))
    : [...scoped];
}
