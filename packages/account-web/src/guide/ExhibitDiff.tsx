// One exhibit of a Change Guide section at the full width: its diff between the guide's base and head, loaded as it
// nears the reader. An exhibit with ranges shows only their lines, each range's note above them; the whole file is a
// click away. At a glance (the walkthrough), an exhibit without ranges shows its first GLANCE_LINES lines of changes.
// Compared with an earlier revision, a changed section's exhibit also shows its code since that revision's head. In the
// workspace, selecting line numbers comments on those lines (a `lines` anchor on the exhibit); review threads written
// before comments replaced them show on their lines, read-only. A shared guide's diffs are read-only.
import type { ChangeGuideSection, RepositoryDiffView, ReviewThreadView } from '@gitspace/protocol';
import { Badge, Button, ThinkingIndicator, Tooltip, badgeColors, useShape } from '@gitspace/ui';
import { FileCode02 } from '@untitledui/icons';
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { CommentScope, TargetCommentEditor } from '../comments/CommentLayer.js';
import { GitSpaceMarkdown } from '../GitSpaceMarkdown.js';
import { PierreViewer } from '../inspector/FilesSurface.js';
import { diffIdentities, ic, openWorkspaceFirst, Placeholder, RuntimeAvailability, type ThreadSelection } from '../inspector/inspector-shared.js';
import { rpcErrorMessage } from '../rpc-error-message.js';
import { Source } from './Authorship.js';
import { firstChanges, narrowExhibit, patchLines } from './exhibit-segments.js';

const LARGE_DIFF_BYTES = 60_000;
/** Lines of changes an exhibit without ranges shows at a glance: what the walkthrough's stage holds under its heading
 * and note at a 900px-high window. */
const GLANCE_LINES = 16;

/** A workspace reviewer's actions on a guide's exhibits: opening a file, and the older review threads, read-only. A
 * shared guide's reader has none. */
export interface GuideReview {
  threads: readonly ReviewThreadView[];
  onOpenFile(path: string): void;
  onSelectThread(thread: ReviewThreadView): void;
}

/** The element the guide scrolls in; diffs start loading 1200px before they reach it. Null: the page itself. */
export const GuideScrollRoot = createContext<{ current: HTMLElement | null }>({ current: null });

type Exhibit = ChangeGuideSection['exhibits'][number];

/** A diff; `onSelectLines` comments on the lines selected, absent where they take no comments. */
function Diff({ path, diff, patch, threads, review, onSelectLines }: { path: string; diff: RepositoryDiffView; patch: string; threads: readonly ReviewThreadView[]; review: GuideReview | null; onSelectLines: ((selection: ThreadSelection) => void) | null }) {
  return <PierreViewer path={path} identities={diffIdentities(diff, path)} patch={patch} threads={threads} onSelectThread={(thread) => review?.onSelectThread(thread)} onSelectRange={onSelectLines ?? undefined} />;
}

/** The file's changed lines a narrowed diff leaves out, and the button that shows the whole file. */
function OtherChanges({ count, onWhole }: { count: number; onWhole(): void }) {
  return <button type="button" onClick={onWhole} className="flex min-h-8 w-full items-center gap-1.5 border-t border-border px-3 text-left text-caption text-muted-foreground hover:text-foreground">
    {count} other changed line{count === 1 ? '' : 's'} in this file · Show the whole file
  </button>;
}

function Body({ exhibit, diff, whole, glance, review, onSelectLines, onWhole }: { exhibit: Exhibit; diff: RepositoryDiffView; whole: boolean; glance: boolean; review: GuideReview | null; onSelectLines: ((selection: ThreadSelection) => void) | null; onWhole(): void }) {
  const [gateOpen, setGateOpen] = useState(false);
  const ranges = exhibit.ranges ?? [];
  const narrowed = useMemo(() => ranges.length ? narrowExhibit(diff.patch, ranges) : null, [diff.patch, ranges]);
  const glanced = useMemo(() => glance && !ranges.length ? firstChanges(diff.patch, GLANCE_LINES) : null, [glance, diff.patch, ranges.length]);
  const threads = review?.threads ?? [];
  if (glanced && !whole) {
    return <div data-glance-lines="" className="flex flex-col">
      <Diff path={exhibit.path} diff={diff} patch={glanced.patch} threads={threads} review={review} onSelectLines={onSelectLines} />
      {glanced.otherChanges ? <OtherChanges count={glanced.otherChanges} onWhole={onWhole} /> : null}
    </div>;
  }
  if (!narrowed || whole) {
    const bytes = new TextEncoder().encode(diff.patch).byteLength;
    if (bytes > LARGE_DIFF_BYTES && !gateOpen) return <Placeholder><Button variant="secondary" size="compact" type="button" onClick={() => setGateOpen(true)}>Large diff · {(bytes / 1024).toFixed(0)} KB · Click to render</Button></Placeholder>;
    return <Diff path={exhibit.path} diff={diff} patch={diff.patch} threads={threads} review={review} onSelectLines={onSelectLines} />;
  }
  return <>
    {narrowed.segments.map(({ range, patch, lines }) => <div key={`${range.start}-${range.end}`} className="flex flex-col border-b border-border last:border-b-0">
      {range.note ? <div data-range-note={`${range.start}-${range.end}`} className="flex items-start gap-1.5 bg-background px-3 pb-1.5 pt-3 text-body">
        <span className="mt-1.5"><Source by="agent" what="this range and its note" /></span>
        <div className="min-w-0 flex-1"><GitSpaceMarkdown>{range.note}</GitSpaceMarkdown></div>
      </div> : null}
      {patch ? <div data-range-lines={`${range.start}-${range.end}`} className="flex flex-col"><Diff path={exhibit.path} diff={diff} patch={patch}
        threads={threads.filter((thread) => thread.anchor.kind === 'line' && thread.anchor.path === exhibit.path && lines[thread.anchor.side].has(thread.anchor.startLine))} review={review} onSelectLines={onSelectLines} /></div>
        : <p className="px-3 py-2 text-caption text-muted-foreground">Lines {range.start}–{range.end} are not changed in this diff.</p>}
    </div>)}
    {narrowed.otherChanges ? <OtherChanges count={narrowed.otherChanges} onWhole={onWhole} /> : null}
  </>;
}

export function ExhibitDiff({ exhibit, entity = null, onLoadDiff, review, since, glance = false }: {
  exhibit: Exhibit;
  /** The exhibit's anchor (`exhibit:<section id>:<path>`): its lines take comments where its document does. */
  entity?: string | null;
  onLoadDiff(path: string): Promise<RepositoryDiffView>;
  review: GuideReview | null;
  /** An earlier revision to show this file's diff since: between its head commit and this revision's. */
  since?: { revision: number; onLoad(path: string): Promise<RepositoryDiffView> } | null;
  /** Shown at a glance: without ranges, only the first lines of changes. */
  glance?: boolean;
}) {
  const scope = useContext(CommentScope);
  const [selected, setSelected] = useState<ThreadSelection | null>(null);
  const shape = useShape();
  const runtimeAvailable = useContext(RuntimeAvailability);
  const root = useContext(GuideScrollRoot);
  const hostRef = useRef<HTMLElement>(null);
  const [requested, setRequested] = useState(false);
  const [diff, setDiff] = useState<RepositoryDiffView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [whole, setWhole] = useState(false);
  const [sinceShown, setSinceShown] = useState(false);
  const fromSince = sinceShown && !!since;
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !runtimeAvailable || requested) return;
    const observer = new IntersectionObserver(([entry]) => { if (entry?.isIntersecting) setRequested(true); }, { root: root.current, rootMargin: '1200px 0px', threshold: 0 });
    observer.observe(host);
    return () => observer.disconnect();
  }, [root, runtimeAvailable, requested]);
  useEffect(() => {
    setDiff(null);
    setError(null);
    if (!runtimeAvailable || !requested) return;
    let active = true;
    void (fromSince ? since.onLoad : onLoadDiff)(exhibit.path).then((loaded) => {
      if (!active) return;
      if (loaded.path !== exhibit.path || loaded.mode !== 'base') throw new Error('The diff response does not match this guide exhibit.');
      setDiff(loaded);
    }).catch((cause: unknown) => { if (active) setError(rpcErrorMessage(cause, 'Change Guide diff')); });
    return () => { active = false; };
  }, [requested, exhibit.path, runtimeAvailable, fromSince]);
  const file = diff?.files.find((entry) => entry.path === exhibit.path);
  const name = <span className="min-w-0 truncate font-mono text-caption">{exhibit.path}</span>;
  return <figure ref={hostRef} className={`flex flex-col overflow-hidden border border-border ${shape.container}`}>
    <figcaption className="flex min-h-9 flex-wrap items-center gap-x-2 gap-y-1 border-b border-border px-2 py-1">
      {review && runtimeAvailable ? <Button variant="ghost" size="compact" type="button" className="min-w-0" onClick={() => review.onOpenFile(exhibit.path)}>{ic(FileCode02, 14)}{name}</Button>
        : <span className="flex min-w-0 items-center gap-2 px-1">{ic(FileCode02, 14)}{name}</span>}
      {file ? <span className="flex items-center gap-1 text-caption tabular-nums"><span style={{ color: badgeColors.green }}>+{file.additions}</span><span style={{ color: badgeColors.red }}>−{file.deletions}</span><Source by="gitspace" what={fromSince ? `the diff and its line counts, between r${since.revision}'s head and this revision's` : "the diff and its line counts, between the guide's base and head"} /></span> : null}
      {exhibit.slowRead ? <Badge size="compact" variant="dot" color="amber">slow read</Badge> : null}
      <span className="ml-auto flex items-center gap-1">
        {since ? <Button variant="ghost" size="compact" type="button" aria-pressed={fromSince} onClick={() => setSinceShown((value) => !value)}>{fromSince ? 'Whole change' : `Since r${since.revision}`}</Button> : null}
        {exhibit.ranges?.length && diff && !fromSince ? <Button variant="ghost" size="compact" type="button" aria-pressed={whole} onClick={() => setWhole((value) => !value)}>{whole ? 'Lines for this section' : 'Whole file'}</Button> : null}
      </span>
    </figcaption>
    {!runtimeAvailable ? <Tooltip content={openWorkspaceFirst}><span><Placeholder>Saved file reference. {openWorkspaceFirst} to inspect its diff.</Placeholder></span></Tooltip>
      : !requested ? <Placeholder>The diff loads as it nears the reading position.</Placeholder>
        : error ? <Placeholder><span className="text-destructive">{error}</span></Placeholder>
          : !diff ? <div className="flex min-h-28 items-center justify-center"><ThinkingIndicator aria-label="Loading diff…" /></div>
            : <Body exhibit={exhibit} diff={diff} whole={whole || fromSince} glance={glance} review={fromSince ? null : review} onWhole={() => setWhole(true)}
              onSelectLines={entity !== null && scope?.editable && scope.document && !fromSince ? setSelected : null} />}
    {selected && diff && entity !== null && hostRef.current ? <TargetCommentEditor around={hostRef.current} onClose={() => setSelected(null)}
      label={`${exhibit.path} · ${selected.startLine === selected.endLine ? `line ${selected.startLine}` : `lines ${selected.startLine}–${selected.endLine}`}`}
      quote={patchLines(diff.patch, selected.side, selected.startLine, selected.endLine) || `${exhibit.path}:${selected.startLine}`}
      target={{ kind: 'lines', exhibit: entity, side: selected.side, start: selected.startLine, end: selected.endLine, blobId: selected.identity.blobId }} /> : null}
  </figure>;
}
