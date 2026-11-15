// The comment panel of a lightbox: a block, a video or a Sequence opened full-screen keeps its comments beside it. The
// panel lists the block's comments (staged ones editable, sent ones locked) and has a box for a new comment on the
// whole block; for a Sequence or a video the box comments on the frame or the moment showing ("Frame 3", "0:42").
// Selections and item icons inside the lightboxed content comment as they do in place, their editors opening in the
// panel. Comments stage as any other: a chip above the composer, and the margin's pill once the lightbox closes. An
// older turn's block shows its comments read-only. Under 900 px the panel is a bottom sheet behind a toggle.
import { commentExcerpt } from '@gitspace/protocol-runtime/comments';
import { Badge, Button, useShape } from '@gitspace/ui';
import { Annotation, ChevronDown } from '@untitledui/icons';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { CommentBlock, CommentEditorHost, CommentScope, SelectionComments, useCommentsAt } from './CommentLayer.js';
import { CommentCards } from './CommentMargin.js';
import { CommentLayer } from './context.js';

/** Where in the lightboxed block a new comment goes: the Sequence frame or the video moment showing. */
export interface LightboxPlace { at: { kind: 'frame'; index: number } | { kind: 'time'; seconds: number }; label: string; quote: string | null }

/** Set inside a lightbox's content: a Sequence player or a video reports what is showing. */
export const LightboxPlaceReport = createContext<((place: LightboxPlace | null) => void) | null>(null);

const NARROW = '(max-width: 899px)';

/** A lightbox's body with its comment panel; outside a commentable message, or for a question, the body alone. */
export function LightboxComments({ children }: { children: ReactNode }) {
  const shape = useShape();
  const layer = useContext(CommentLayer);
  const scope = useContext(CommentScope);
  const block = useContext(CommentBlock);
  const notes = useCommentsAt({ block: block?.key ?? '' });
  const [place, setPlace] = useState<LightboxPlace | null>(null);
  // A video reports its moment several times a second: only a new second (or frame) is a new place.
  const report = useCallback((next: LightboxPlace | null): void => setPlace((current) => current?.label === next?.label ? current : next), []);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [draft, setDraft] = useState('');
  const [state, setState] = useState<{ saving: boolean; error: string | null }>({ saving: false, error: null });
  // A comment being written stays on the frame or moment showing when it was started, though playback moves on.
  const [pinned, setPinned] = useState<LightboxPlace | null>(null);
  const [narrow, setNarrow] = useState(() => window.matchMedia(NARROW).matches);
  const [sheet, setSheet] = useState(false);
  useEffect(() => {
    const media = window.matchMedia(NARROW);
    const change = (): void => setNarrow(media.matches);
    media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, []);
  if (!layer || !scope || !block || block.asks) return <>{children}</>;
  const at = draft ? pinned : place;
  const label = at ? at.label : block.kind;
  const add = (): void => {
    if (!draft.trim() || state.saving) return;
    setState({ saving: true, error: null });
    const quote = at?.quote ?? (block.title ? `${block.kind}: ${block.title}` : block.kind);
    layer.stage(scope.row, at ? { ...at.at, block: block.key } : { kind: 'block', id: block.key }, at ? `${at.label}${at.quote ? ` · ${at.quote}` : ''}` : quote, draft.trim()).then(() => {
      setDraft('');
      setPinned(null);
      setState({ saving: false, error: null });
    }, (failure: unknown) => setState({ saving: false, error: failure instanceof Error ? failure.message : String(failure) }));
  };
  const panel = <div data-lightbox-comments="" className="flex min-h-0 flex-col gap-3">
    {narrow ? null : <span className="flex items-center gap-1.5 text-caption font-medium text-foreground"><Annotation width={14} height={14} />Comments<Badge size="compact" variant="dot" color={notes.length ? 'amber' : 'gray'}>{notes.length}</Badge></span>}
    <CommentCards notes={notes} />
    {narrow ? null : <div ref={setHost} className="empty:hidden" />}
    {scope.editable ? <div className="flex flex-col gap-1.5 border-t border-border pt-3">
      <span className="text-caption text-muted-foreground">{at ? (at.at.kind === 'frame' ? 'On' : 'At') : 'On this'} <span className="font-medium text-foreground">{label}</span></span>
      {at?.quote ? <blockquote className="border-l-2 border-border pl-2 text-caption italic text-muted-foreground">{commentExcerpt(at.quote, 120)}</blockquote> : null}
      {/* FLUID-GAP: multi-line textarea — the registry has no textarea field. */}
      <textarea aria-label={`Comment on ${label}`} placeholder="Your comment" rows={3} value={draft} onChange={(event) => { const value = event.currentTarget.value; if (!draft && value) setPinned(place); setDraft(value); }}
        onKeyDown={(event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) add(); }}
        className={`${shape.input} w-full resize-y border border-border bg-surface-2 px-2.5 py-1.5 text-body text-foreground`} />
      {state.error ? <p role="alert" className="text-caption text-destructive">{state.error}</p> : null}
      <Button variant="primary" size="compact" type="button" className="self-start" disabled={!draft.trim() || state.saving} onClick={add}>Comment</Button>
    </div> : <p className="border-t border-border pt-3 text-caption text-muted-foreground">Comments go on the latest turn.</p>}
  </div>;
  const content = <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-auto">
    <SelectionComments className="flex min-h-0 flex-1 flex-col"><div data-comment-block={block.key} data-comment-kind={block.kind} className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</div></SelectionComments>
  </div>;
  return <CommentEditorHost.Provider value={host}>
    <LightboxPlaceReport.Provider value={report}>
      {narrow ? <div className="relative flex min-h-0 w-full flex-1 flex-col">
        {content}
        <div className={`${shape.container} absolute inset-x-0 bottom-0 z-20 flex max-h-[70%] flex-col border border-border bg-background shadow-lg`}>
          <button type="button" aria-expanded={sheet} onClick={() => setSheet(!sheet)} className="flex items-center gap-1.5 px-3 py-2 text-caption font-medium text-foreground">
            <Annotation width={14} height={14} />Comments · {notes.length}<ChevronDown width={14} height={14} className={`ml-auto transition-transform ${sheet ? '' : 'rotate-180'}`} />
          </button>
          {/* An editor opened from the content shows even while the sheet is folded. */}
          <div ref={setHost} className="px-3 pb-2 empty:hidden" />
          <div className={sheet ? 'min-h-0 overflow-y-auto px-3 pb-3' : 'hidden'}>{panel}</div>
        </div>
      </div> : <div className="flex min-h-0 w-full flex-1 gap-4">
        {content}
        <aside aria-label="Comments" className="flex w-80 shrink-0 flex-col overflow-y-auto border-l border-border pl-4">{panel}</aside>
      </div>}
    </LightboxPlaceReport.Provider>
  </CommentEditorHost.Provider>;
}
