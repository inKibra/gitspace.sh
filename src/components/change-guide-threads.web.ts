/**
 * Change Guide line-anchored review threads — the pure mapping layer.
 *
 * Bridges the review thread model (src/types/review.ts) and @pierre/diffs'
 * line-annotation API. Kept free of React/DOM so the mapping is unit-testable:
 *
 *   ReviewThread[]  --guideLineAnnotations-->  DiffLineAnnotation<GuideThreadMeta>[]
 *   SelectedLineRange --lineTargetFromSelection--> LineTarget
 *
 * The renderer anchors annotations by (side, lineNumber) where side is
 * 'deletions' (the LEFT/old side) or 'additions' (the RIGHT/new side), and
 * lineNumber is 1-based on that side — which is exactly how LineTarget is
 * defined, so the two models map 1:1.
 */
import type { AnnotationSide, DiffLineAnnotation, SelectedLineRange } from '@pierre/diffs';
import type { LineTarget, ReviewThread } from '../types/review.js';

/** Metadata carried on each inline annotation the guide renders. */
export interface GuideThreadMeta {
  /** Threads anchored at this (file, side, line) — usually one, more when stacked. */
  threads: ReviewThread[];
}

/** review LineTarget side <-> @pierre/diffs annotation side. */
export function sideToAnnotationSide(side: LineTarget['side']): AnnotationSide {
  return side === 'LEFT' ? 'deletions' : 'additions';
}

export function annotationSideToSide(side: AnnotationSide | undefined): LineTarget['side'] {
  return side === 'deletions' ? 'LEFT' : 'RIGHT';
}

/**
 * Build a LineTarget from a PatchDiff line selection.
 *
 * The renderer reports start/end in DOM order, which can be inverted when the
 * user drags upward — normalize to startLine <= endLine. A selection that
 * spans both sides is anchored to the side the drag STARTED on (`range.side`),
 * since a thread has exactly one side.
 */
export function lineTargetFromSelection(range: SelectedLineRange, file: string): LineTarget {
  return {
    kind: 'line',
    file,
    startLine: Math.min(range.start, range.end),
    endLine: Math.max(range.start, range.end),
    side: annotationSideToSide(range.side),
  };
}

/** Does this thread anchor to a line in `file`? (matches renames via prevFile) */
export function isLineThreadForFile(thread: ReviewThread, file: string, prevFile?: string): boolean {
  if (thread.target.kind !== 'line') return false;
  return thread.target.file === file || (prevFile !== undefined && thread.target.file === prevFile);
}

/**
 * Map a workspace's threads to the annotations for ONE file's diff.
 *
 * Anchors each line thread at its startLine on its own side. Threads sharing an
 * anchor collapse into a single annotation carrying all of them — the renderer
 * allots one annotation slot per (side, line), so stacking them here is what
 * keeps a second thread on the same line from being dropped.
 *
 * Ordering is deterministic (side, then line, then createdAt) so re-renders
 * don't reshuffle the DOM.
 */
export function guideLineAnnotations(
  threads: ReviewThread[],
  file: string,
  prevFile?: string,
): DiffLineAnnotation<GuideThreadMeta>[] {
  const byAnchor = new Map<string, DiffLineAnnotation<GuideThreadMeta>>();

  const relevant = threads
    .filter((t) => isLineThreadForFile(t, file, prevFile))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  for (const thread of relevant) {
    const target = thread.target as LineTarget;
    const side = sideToAnnotationSide(target.side);
    const lineNumber = Math.max(1, Math.min(target.startLine, target.endLine));
    const key = `${side}:${lineNumber}`;

    const existing = byAnchor.get(key);
    if (existing) {
      existing.metadata.threads.push(thread);
      continue;
    }
    byAnchor.set(key, { side, lineNumber, metadata: { threads: [thread] } });
  }

  return [...byAnchor.values()].sort((a, b) => (
    a.side === b.side ? a.lineNumber - b.lineNumber : a.side === 'deletions' ? -1 : 1
  ));
}

/** Human label for a line target — 'L12' or 'L12–L18'. */
export function lineRangeLabel(target: LineTarget): string {
  const start = Math.min(target.startLine, target.endLine);
  const end = Math.max(target.startLine, target.endLine);
  return start === end ? `L${start}` : `L${start}–L${end}`;
}
