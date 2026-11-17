// The comments a Goal or Change Guide revision shows (docs/BLOCK-DOCUMENTS-DESIGN.md §3–§4). A Goal comment stays on the
// Goal across its revisions; it is outdated when what it is on changed after the revision it was written on (the
// entity is gone, or the entity's text no longer reads as its quote). A Guide comment shows on its revision, and is
// carried forward to a later revision when its section's contentHash is unchanged; otherwise it shows outdated there,
// with a link to the revision it was written on.
import type { ChangeGuideSection } from '@gitspace/protocol';
import { commentExcerpt, COMMENT_QUOTE_MAX } from '@gitspace/protocol-runtime/comments';
import { useLayoutEffect, useMemo, useState } from 'react';
import type { CommentNote, DocumentNote } from './context.js';
import { anchorEntity, locateAnchor } from './CommentLayer.js';

/** What a Goal or Guide entity's comment quotes: its title, then its text, on one line. */
export function entityQuote(title: string, text: string): string {
  return commentExcerpt(text.trim() ? `${title} — ${text}` : title, COMMENT_QUOTE_MAX);
}

/** The Goal's comments at its revision `revision`. `quotes`: each entity of the Goal shown now and the quote a comment
 * on it takes (`entityQuote`). */
export function goalNotes(notes: readonly CommentNote[], revision: number, quotes: ReadonlyMap<string, string>): DocumentNote[] {
  return notes.flatMap((note): DocumentNote[] => {
    const { document, target } = note.anchor;
    if (document.kind !== 'goal' || document.revision > revision) return [];
    const entity = anchorEntity(note.anchor);
    const quote = entity === null ? undefined : quotes.get(entity);
    const outdated = document.revision < revision && (quote === undefined || (target.kind === 'entity' && quote !== note.anchor.quote));
    return [{ ...note, revision: document.revision, outdated }];
  });
}

/** The section of a guide entity (`section:<id>`, `exhibit:<section id>:<path>`), among `sections`: the section with that
 * id, or the section that has that exhibit (section ids and paths may contain `:`). None for an exhibit no section has. */
export function entitySection(entity: string, sections: readonly ChangeGuideSection[]): ChangeGuideSection | undefined {
  if (entity.startsWith('section:')) return sections.find((section) => section.id === entity.slice('section:'.length));
  return entity.startsWith('exhibit:') ? sections.find((section) => section.exhibits.some((exhibit) => entity === `exhibit:${section.id}:${exhibit.path}`)) : undefined;
}

/** The Guide's comments as revision `revision` (its `sections`) shows them: its own, and those of earlier revisions
 * (`earlier`, revision → its sections) carried forward or outdated. A comment on an earlier revision not loaded yet is
 * left out until it is. */
export function guideNotes(notes: readonly CommentNote[], revision: number, sections: readonly ChangeGuideSection[], earlier: ReadonlyMap<number, readonly ChangeGuideSection[]>): DocumentNote[] {
  return notes.flatMap((note): DocumentNote[] => {
    const { document } = note.anchor;
    if (document.kind !== 'guide' || document.revision > revision) return [];
    if (document.revision === revision) return [{ ...note, revision, outdated: false }];
    const then = earlier.get(document.revision);
    if (!then) return [];
    const entity = anchorEntity(note.anchor);
    const before = entity === null ? undefined : entitySection(entity, then);
    const now = entity === null ? undefined : entitySection(entity, sections);
    // Copies read the same by content hash, or by their whole content without one.
    const same = before !== undefined && now !== undefined && (before.contentHash !== undefined && now.contentHash !== undefined ? before.contentHash === now.contentHash : JSON.stringify(before) === JSON.stringify(now));
    return [{ ...note, revision: document.revision, outdated: !same }];
  });
}

/** `notes` with a passage, block or item comment whose entity is drawn (`root`) but which is no longer found in it marked
 * outdated: its text changed in a later revision. */
export function useFoundAgain(root: HTMLElement | null, notes: readonly DocumentNote[]): readonly DocumentNote[] {
  const [lost, setLost] = useState<ReadonlySet<string>>(new Set());
  useLayoutEffect(() => {
    if (!root) return;
    const next = new Set(notes.flatMap((note) => {
      const { target } = note.anchor;
      if (note.outdated || target.kind === 'entity' || target.kind === 'lines') return [];
      const entity = anchorEntity(note.anchor);
      const drawn = entity !== null && root.querySelector(`[data-comment-target="${CSS.escape(entity)}"]`) !== null;
      return drawn && locateAnchor(root, note.anchor) === null ? [note.id] : [];
    }));
    setLost((current) => current.size === next.size && [...next].every((id) => current.has(id)) ? current : next);
  }, [root, notes]);
  return useMemo(() => lost.size === 0 ? notes : notes.map((note) => lost.has(note.id) ? { ...note, outdated: true } : note), [notes, lost]);
}
