import { type CSSProperties, type ReactElement } from 'react';
import { FileTree, useFileTree } from '@pierre/trees/react';
import type { FileTreeData } from '../types/content.js';
import { defineRenderer } from './registry.web.js';

const ROW_HEIGHT = 26;

// @pierre/trees is a shadow-DOM web component; CSS custom properties pierce the
// boundary, so we map its `--trees-*-override` hooks onto our `--gs-*` tokens.
const TREE_THEME = {
  '--trees-bg-override': 'transparent',
  '--trees-bg-muted-override': 'var(--gs-bg)',
  '--trees-fg-override': 'var(--gs-text)',
  '--trees-fg-muted-override': 'var(--gs-text-muted)',
  '--trees-accent-override': 'var(--gs-accent)',
  '--trees-border-color-override': 'var(--gs-border)',
  '--trees-selected-bg-override': 'var(--gs-bg-active)',
  '--trees-selected-fg-override': 'var(--gs-text)',
  '--trees-indent-guide-bg-override': 'var(--gs-border-muted)',
  '--trees-scrollbar-thumb-override': 'var(--gs-border-active)',
  '--trees-font-family-override': 'var(--gs-font)',
  '--trees-git-added-color-override': 'var(--gs-success)',
  '--trees-git-modified-color-override': 'var(--gs-info)',
  '--trees-git-deleted-color-override': 'var(--gs-danger)',
  '--trees-git-renamed-color-override': 'var(--gs-warning)',
  '--trees-git-untracked-color-override': 'var(--gs-text-muted)',
} as const;

// The tree is virtualized, so its host needs an explicit height. Size it to the
// fully-expanded row count (every path prefix is a row) so a block shows the
// whole tree without an inner scrollbar.
function expandedRowCount(paths: readonly string[]): number {
  const rows = new Set<string>();
  for (const path of paths) {
    let prefix = '';
    for (const part of path.split('/').filter(Boolean)) {
      prefix = prefix ? `${prefix}/${part}` : part;
      rows.add(prefix);
    }
  }
  return rows.size;
}

// The `file-tree` block renders a path list with @pierre/trees — the same tree
// engine the repo's file browser uses, themed to match the app.
defineRenderer<FileTreeData>('file-tree', ({ data }): ReactElement => {
  const { model } = useFileTree({ paths: data.paths, gitStatus: data.gitStatus, initialExpansion: 'open' });
  const height = Math.max(1, expandedRowCount(data.paths)) * ROW_HEIGHT + 8;
  return (
    <div className="my-2 border border-[var(--gs-border)] bg-[var(--gs-bg-elevated)]">
      <FileTree model={model} style={{ height, ...TREE_THEME } as CSSProperties} />
    </div>
  );
});
