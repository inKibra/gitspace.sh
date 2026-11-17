// A Markdown file shown in the Inspector as a block document (docs/BLOCK-DOCUMENTS-DESIGN.md §1, §3–§4): its prose and
// its gitspace-ui, svg and mermaid blocks drawn as the chat draws them, each block with Copy as Markdown. A drive file
// is a drive doc: a person comments on a passage or a block of it (the entity `drive`, at the file's drive URL and the
// content hash of the version shown), and each comment's thread shows under the paragraph or block it is on. A comment
// written on an earlier version is carried forward or shown outdated (`driveNotes`, `quoteReads`); an outdated one
// shows above the document with its quote and the version it was written on.
import type { CommentAnchor, CommentDocument } from '@gitspace/protocol-runtime/comments';
import { ScrollArea } from '@gitspace/ui';
import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { parseMarkdownIntoBlocks } from 'streamdown';
import { GitSpaceMarkdown } from '../GitSpaceMarkdown.js';
import { RecordBlockDocument } from '../blocks/BlockDocument.js';
import { CommentEntity, DocumentThreads, locateAnchor, showAnchor } from '../comments/CommentLayer.js';
import { CommentMarginLayout } from '../comments/CommentMargin.js';
import { CommentLayer, DocumentComments, type DocumentCommentsValue, type DocumentNote } from '../comments/context.js';
import { DRIVE_ENTITY, driveNotes, quoteReads } from '../comments/document-notes.js';

/** Frames to wait for a comment's anchor to be drawn before scrolling to the comments on earlier versions instead. */
const FOCUS_FRAMES = 120;

/** Where each comment shows: the part of the document its anchor is in, or `lost` (outdated). */
interface Places { key: string; parts: ReadonlyMap<string, number>; lost: ReadonlySet<string> }
const NO_PLACES: Places = { key: '', parts: new Map(), lost: new Set() };

export function MarkdownFileDocument({ markdown, documentUrl, file, readVersion, focus = null }: {
  markdown: string;
  /** The file's address: links and images relative to it name the files beside it. */
  documentUrl: string;
  /** The drive file (its drive URL) and the content hash of the version shown: its comments show and it takes new ones.
   * Null for a file shown by its address alone. */
  file: { path: string; hash: string } | null;
  /** Reads an earlier version of the drive file by its hash; null when it cannot be read. */
  readVersion?: (hash: string) => Promise<string | null>;
  /** The comment whose anchor to scroll to once it is drawn; a new serial scrolls again. */
  focus?: { anchor: CommentAnchor; serial: number } | null;
}) {
  const layer = useContext(CommentLayer);
  const path = file?.path ?? null;
  const hash = file?.hash ?? null;
  const showDrive = layer?.showDrive;
  useEffect(() => path === null || !showDrive ? undefined : showDrive(path), [path, showDrive]);
  // Each top-level part (a paragraph, a list, a block) is drawn on its own, so a comment's thread shows under it.
  const parts = useMemo(() => parseMarkdownIntoBlocks(markdown), [markdown]);
  // The earlier versions block comments were written on, each read once.
  const [earlier, setEarlier] = useState<ReadonlyMap<string, string | null>>(new Map());
  const requested = useRef(new Set<string>());
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const wanted = useMemo(() => path === null ? [] : [...new Set((layer?.notes ?? []).flatMap(({ anchor: { document, target } }) =>
    document.kind === 'drive' && document.path === path && document.hash !== hash && target.kind !== 'text' ? [document.hash] : []))].sort(), [layer?.notes, path, hash]);
  const wantedKey = wanted.join('\n');
  useEffect(() => {
    if (!readVersion) return;
    for (const version of wanted) {
      if (requested.current.has(version)) continue;
      requested.current.add(version);
      readVersion(version).catch(() => null).then((text) => { if (mounted.current) setEarlier((current) => new Map(current).set(version, text)); });
    }
  }, [wantedKey, readVersion]);
  const notes = useMemo(() => path === null || hash === null ? [] : driveNotes(layer?.notes ?? [], { path, hash, markdown }, earlier), [layer?.notes, path, hash, markdown, earlier]);
  // Which part each comment is in, found again whenever the document draws (blocks draw after the prose); a passage
  // written on an earlier version is lost (outdated) unless its quote still reads as written.
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const [places, setPlaces] = useState<Places>(NO_PLACES);
  useLayoutEffect(() => {
    if (!root) return;
    const place = (): void => {
      const found = new Map<string, number>();
      const lost = new Set<string>();
      for (const note of notes) {
        const { anchor } = note;
        const carried = !note.outdated && (anchor.target.kind !== 'text' || anchor.document.kind !== 'drive' || anchor.document.hash === hash || quoteReads(root, anchor.target));
        if (!carried) { lost.add(note.id); continue; }
        const located = locateAnchor(root, anchor);
        const node = located ? located.whole ?? located.range?.startContainer ?? located.element : null;
        const part = (node instanceof Element ? node : node?.parentElement)?.closest('[data-drive-part]')?.getAttribute('data-drive-part');
        if (part !== null && part !== undefined) found.set(note.id, Number(part));
      }
      const key = JSON.stringify([[...found], [...lost]]);
      setPlaces((current) => current.key === key ? current : { key, parts: found, lost });
    };
    place();
    let frame = 0;
    const observer = new MutationObserver(() => { cancelAnimationFrame(frame); frame = requestAnimationFrame(place); });
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    return () => { cancelAnimationFrame(frame); observer.disconnect(); };
  }, [root, notes, hash]);
  const shown = useMemo(() => places.lost.size === 0 ? notes : notes.map((note): DocumentNote => places.lost.has(note.id) ? { ...note, outdated: true } : note), [notes, places]);
  const outdated = shown.filter((note) => note.outdated);
  // The margin marks only what the version shown holds; outdated comments are listed above the document.
  const current = useMemo(() => shown.filter((note) => !note.outdated), [shown]);
  const byPart = new Map<number, DocumentNote[]>();
  for (const note of shown) {
    const part = note.outdated ? undefined : places.parts.get(note.id);
    if (part !== undefined) byPart.set(part, [...byPart.get(part) ?? [], note]);
  }
  const where = useMemo((): CommentDocument | null => path === null || hash === null ? null : { kind: 'drive', path, hash }, [path, hash]);
  const documentComments = useMemo((): DocumentCommentsValue => ({ document: where, notes: shown, onShowRevision: null }), [where, shown]);
  // A link to a comment scrolls to its anchor once drawn, or to the comments on earlier versions when it is gone.
  useEffect(() => {
    if (!focus || !root) return;
    let frames = 0;
    let frame = 0;
    const scroll = (): void => {
      if (locateAnchor(root, focus.anchor)) { showAnchor(focus.anchor); return; }
      if (frames++ < FOCUS_FRAMES) { frame = requestAnimationFrame(scroll); return; }
      root.querySelector('[data-drive-earlier]')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
    frame = requestAnimationFrame(scroll);
    return () => cancelAnimationFrame(frame);
  }, [focus?.serial, root]);
  const markdowns = useMemo(() => [markdown], [markdown]);
  return <DocumentComments.Provider value={documentComments}><RecordBlockDocument markdown={markdowns}>
    <ScrollArea className="min-h-0 flex-1" viewportClassName="h-full"><div ref={setRoot}><CommentMarginLayout columnMax={768} notes={current}>
      <article data-drive-document={path ?? undefined} className="flex min-w-0 flex-col gap-4 px-6 py-6">
        {outdated.length ? <section data-drive-earlier="" data-comment-ui="" aria-label="Comments on earlier versions" className="flex min-w-0 flex-col gap-1">
          <span className="text-caption font-medium text-muted-foreground">On earlier versions of this file</span>
          <DocumentThreads notes={outdated} />
        </section> : null}
        <CommentEntity entity={DRIVE_ENTITY} className="flex min-w-0 flex-col gap-3">
          {parts.map((part, index) => <div key={index} data-drive-part={index} className="flex min-w-0 flex-col gap-1.5">
            <GitSpaceMarkdown documentUri={documentUrl}>{part}</GitSpaceMarkdown>
            {byPart.get(index)?.length ? <div data-comment-ui="" data-drive-threads={index} className="flex min-w-0 flex-col gap-1"><DocumentThreads notes={byPart.get(index) ?? []} /></div> : null}
          </div>)}
        </CommentEntity>
      </article>
    </CommentMarginLayout></div></ScrollArea>
  </RecordBlockDocument></DocumentComments.Provider>;
}
