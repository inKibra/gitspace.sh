import { type ReactElement } from 'react';
import { PatchDiff } from '@pierre/diffs/react';
import type { DiffData } from '../types/content.js';
import { defineRenderer } from './registry.web.js';

// The `diff` block renders its unified-diff patch with @pierre/diffs — the same
// engine the review surface uses (DiffViewer), so inline diffs match it. Kept
// read-only here (no annotations/line-selection); the review surface adds those.
defineRenderer<DiffData>('diff', ({ data }): ReactElement => (
  <div className="my-2 border border-[var(--gs-border)] overflow-x-auto">
    {data.file && (
      <div className="px-2 py-1 text-[11px] text-[var(--gs-text)] bg-[var(--gs-bg-elevated)] border-b border-[var(--gs-border)] truncate">
        {data.file}
      </div>
    )}
    <PatchDiff patch={data.patch} options={{ diffStyle: 'unified', theme: 'pierre-dark' }} />
  </div>
));
