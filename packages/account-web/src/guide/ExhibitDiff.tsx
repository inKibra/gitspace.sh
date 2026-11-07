// One exhibit of a Change Guide section at the full width: its diff between the guide's base and head, loaded as it
// nears the reader. An exhibit with ranges shows only their lines, each range's note above them; the whole file is a
// click away. In the workspace, selecting line numbers starts a review thread; a shared guide's diffs are read-only.
import type { ChangeGuideSection, RepositoryDiffView, ReviewThreadView } from '@gitspace/protocol';
import { Badge, Button, ThinkingIndicator, Tooltip, badgeColors, useShape } from '@gitspace/ui';
import { FileCode02 } from '@untitledui/icons';
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { GitSpaceMarkdown } from '../GitSpaceMarkdown.js';
import { PierreViewer } from '../inspector/FilesSurface.js';
import { diffIdentities, ic, openWorkspaceFirst, Placeholder, RuntimeAvailability, type ThreadSelection } from '../inspector/inspector-shared.js';
import { rpcErrorMessage } from '../rpc-error-message.js';
import { Source } from './Authorship.js';
import { narrowExhibit } from './exhibit-segments.js';

const LARGE_DIFF_BYTES = 60_000;

/** A workspace reviewer's actions on a guide's exhibits. A shared guide's reader has none. */
export interface GuideReview {
  threads: readonly ReviewThreadView[];
  onOpenFile(path: string): void;
  onSelectThread(thread: ReviewThreadView): void;
  onSelectRange(selection: ThreadSelection): void;
}

/** The element the guide scrolls in; diffs start loading 1200px before they reach it. Null: the page itself. */
export const GuideScrollRoot = createContext<{ current: HTMLElement | null }>({ current: null });

type Exhibit = ChangeGuideSection['exhibits'][number];

function Diff({ path, diff, patch, threads, review }: { path: string; diff: RepositoryDiffView; patch: string; threads: readonly ReviewThreadView[]; review: GuideReview | null }) {
  return <PierreViewer path={path} identities={diffIdentities(diff, path)} patch={patch} threads={threads} onSelectThread={(thread) => review?.onSelectThread(thread)} onSelectRange={review?.onSelectRange} />;
}

function Body({ exhibit, diff, whole, review, onWhole }: { exhibit: Exhibit; diff: RepositoryDiffView; whole: boolean; review: GuideReview | null; onWhole(): void }) {
  const [gateOpen, setGateOpen] = useState(false);
  const ranges = exhibit.ranges ?? [];
  const narrowed = useMemo(() => ranges.length ? narrowExhibit(diff.patch, ranges) : null, [diff.patch, ranges]);
  const threads = review?.threads ?? [];
  if (!narrowed || whole) {
    const bytes = new TextEncoder().encode(diff.patch).byteLength;
    if (bytes > LARGE_DIFF_BYTES && !gateOpen) return <Placeholder><Button variant="secondary" size="compact" type="button" onClick={() => setGateOpen(true)}>Large diff · {(bytes / 1024).toFixed(0)} KB · Click to render</Button></Placeholder>;
    return <Diff path={exhibit.path} diff={diff} patch={diff.patch} threads={threads} review={review} />;
  }
  return <>
    {narrowed.segments.map(({ range, patch, lines }) => <div key={`${range.start}-${range.end}`} className="flex flex-col border-b border-border last:border-b-0">
      {range.note ? <div data-range-note={`${range.start}-${range.end}`} className="flex items-start gap-1.5 bg-background px-3 pb-1.5 pt-3 text-body">
        <span className="mt-1.5"><Source by="agent" what="this range and its note" /></span>
        <div className="min-w-0 flex-1"><GitSpaceMarkdown>{range.note}</GitSpaceMarkdown></div>
      </div> : null}
      {patch ? <div data-range-lines={`${range.start}-${range.end}`} className="flex flex-col"><Diff path={exhibit.path} diff={diff} patch={patch}
        threads={threads.filter((thread) => thread.anchor.kind === 'line' && thread.anchor.path === exhibit.path && lines[thread.anchor.side].has(thread.anchor.startLine))} review={review} /></div>
        : <p className="px-3 py-2 text-caption text-muted-foreground">Lines {range.start}–{range.end} are not changed in this diff.</p>}
    </div>)}
    {narrowed.otherChanges ? <button type="button" onClick={onWhole} className="flex min-h-8 w-full items-center gap-1.5 border-t border-border px-3 text-left text-caption text-muted-foreground hover:text-foreground">
      {narrowed.otherChanges} other changed line{narrowed.otherChanges === 1 ? '' : 's'} in this file · Show the whole file
    </button> : null}
  </>;
}

export function ExhibitDiff({ exhibit, onLoadDiff, review }: { exhibit: Exhibit; onLoadDiff(path: string): Promise<RepositoryDiffView>; review: GuideReview | null }) {
  const shape = useShape();
  const runtimeAvailable = useContext(RuntimeAvailability);
  const root = useContext(GuideScrollRoot);
  const hostRef = useRef<HTMLElement>(null);
  const [requested, setRequested] = useState(false);
  const [diff, setDiff] = useState<RepositoryDiffView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [whole, setWhole] = useState(false);
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
    void onLoadDiff(exhibit.path).then((loaded) => {
      if (!active) return;
      if (loaded.path !== exhibit.path || loaded.mode !== 'base') throw new Error('The diff response does not match this guide exhibit.');
      setDiff(loaded);
    }).catch((cause: unknown) => { if (active) setError(rpcErrorMessage(cause, 'Change Guide diff')); });
    return () => { active = false; };
  }, [requested, exhibit.path, runtimeAvailable]);
  const file = diff?.files.find((entry) => entry.path === exhibit.path);
  const name = <span className="min-w-0 truncate font-mono text-caption">{exhibit.path}</span>;
  return <figure ref={hostRef} className={`flex flex-col overflow-hidden border border-border ${shape.container}`}>
    <figcaption className="flex min-h-9 flex-wrap items-center gap-x-2 gap-y-1 border-b border-border px-2 py-1">
      {review && runtimeAvailable ? <Button variant="ghost" size="compact" type="button" className="min-w-0" onClick={() => review.onOpenFile(exhibit.path)}>{ic(FileCode02, 14)}{name}</Button>
        : <span className="flex min-w-0 items-center gap-2 px-1">{ic(FileCode02, 14)}{name}</span>}
      {file ? <span className="flex items-center gap-1 text-caption tabular-nums"><span style={{ color: badgeColors.green }}>+{file.additions}</span><span style={{ color: badgeColors.red }}>−{file.deletions}</span><Source by="gitspace" what="the diff and its line counts, between the guide's base and head" /></span> : null}
      {exhibit.slowRead ? <Badge size="compact" variant="dot" color="amber">slow read</Badge> : null}
      {exhibit.ranges?.length && diff ? <Button variant="ghost" size="compact" type="button" className="ml-auto" aria-pressed={whole} onClick={() => setWhole((value) => !value)}>{whole ? 'Lines for this section' : 'Whole file'}</Button> : null}
    </figcaption>
    {!runtimeAvailable ? <Tooltip content={openWorkspaceFirst}><span><Placeholder>Saved file reference. {openWorkspaceFirst} to inspect its diff.</Placeholder></span></Tooltip>
      : !requested ? <Placeholder>The diff loads as it nears the reading position.</Placeholder>
        : error ? <Placeholder><span className="text-destructive">{error}</span></Placeholder>
          : !diff ? <div className="flex min-h-28 items-center justify-center"><ThinkingIndicator aria-label="Loading diff…" /></div>
            : <Body exhibit={exhibit} diff={diff} whole={whole} review={review} onWhole={() => setWhole(true)} />}
  </figure>;
}
