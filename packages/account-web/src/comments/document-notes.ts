// The comments a Goal or Change Guide revision or a drive doc shows (docs/BLOCK-DOCUMENTS-DESIGN.md §3–§4). A Goal
// comment stays on the Goal across its revisions; it is outdated when what it is on changed after the revision it was
// written on (the entity is gone, or the entity's text no longer reads as its quote). A Guide comment shows on its
// revision, and is carried forward to a later revision when its section's contentHash is unchanged; otherwise it shows
// outdated there, with a link to the revision it was written on. A drive doc comment shows on every version of its file:
// a passage is carried forward while its exact text with the same prefix and suffix is still found, a block while a
// block with its id holds the same spec; otherwise it shows outdated with the version it was written on.
import type { ChangeGuideSection } from '@gitspace/protocol';
import { extractBlocks, fenceSpec, isRecord } from '@gitspace/protocol/gitspace-ui';
import { commentExcerpt, COMMENT_QUOTE_MAX, findTextQuote, textQuoteAt, type CommentTarget } from '@gitspace/protocol-runtime/comments';
import { useLayoutEffect, useMemo, useState } from 'react';
import type { CommentNote, DocumentNote } from './context.js';
import { anchorEntity, blockKey, flatText, locateAnchor, targetElement } from './CommentLayer.js';

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

/** The one entity of a drive doc: its passages are within it, its blocks keyed `drive#<element id>`. */
export const DRIVE_ENTITY = 'drive';

/** The gitspace-ui blocks of a drive doc's Markdown by their key (`blockKey` of the entity `drive`), each with its spec
 * as JSON. */
export function driveBlocks(markdown: string): Map<string, string> {
  const blocks = new Map<string, string>();
  for (const block of extractBlocks(markdown)) {
    if (block.kind !== 'gitspace-ui' || !block.closed) continue;
    const read = fenceSpec(block.body, block.info);
    if (!('spec' in read) || !isRecord(read.spec) || !isRecord(read.spec.elements) || typeof read.spec.root !== 'string') continue;
    const root = read.spec.elements[read.spec.root];
    blocks.set(blockKey(DRIVE_ENTITY, root, isRecord(root) && typeof root.id === 'string' ? root.id : null), JSON.stringify(read.spec));
  }
  return blocks;
}

/**
 * A drive doc's comments as the version `file` shows it (its drive URL `path`, content `hash` and `markdown`): those
 * written on it, and those of earlier versions (`earlier`, hash → Markdown, null when it could not be read). A passage
 * written on an earlier version is decided where it is drawn (`quoteReads`). A block comment (on the block, an item, a
 * moment or a frame of it) is carried forward while a block with its key holds the same spec as when it was written,
 * and outdated otherwise; one whose version is not read yet is left out until it is. `version`: the first 7 hex
 * digits of the hash it was written on.
 */
export function driveNotes(notes: readonly CommentNote[], file: { path: string; hash: string; markdown: string }, earlier: ReadonlyMap<string, string | null>): DocumentNote[] {
  let now: Map<string, string> | null = null;
  return notes.flatMap((note): DocumentNote[] => {
    const { document, target } = note.anchor;
    if (document.kind !== 'drive' || document.path !== file.path) return [];
    const version = document.hash.replace(/^sha256:/u, '').slice(0, 7);
    if (document.hash === file.hash || target.kind === 'text') return [{ ...note, revision: 0, outdated: false, version }];
    const before = earlier.get(document.hash);
    if (before === undefined) return [];
    const key = target.kind === 'block' ? target.id : 'block' in target ? target.block : null;
    const spec = key === null || before === null ? undefined : driveBlocks(before).get(key);
    now ??= driveBlocks(file.markdown);
    return [{ ...note, revision: 0, outdated: spec === undefined || key === null || now.get(key) !== spec, version }];
  });
}

/** Whether a passage comment's quote still reads as written in `root`: its exact text, found inside what it is within,
 * has the same prefix and suffix from within its own block (`textQuoteAt`). */
export function quoteReads(root: ParentNode, target: Extract<CommentTarget, { kind: 'text' }>): boolean {
  const within = targetElement(root, target);
  if (within === null) return false;
  const flat = flatText(within);
  const found = findTextQuote(flat.text, target, flat.breaks);
  const around = found && textQuoteAt(flat.text, found.start, found.end, flat.breaks);
  return around !== null && around.prefix === target.prefix && around.suffix === target.suffix;
}
