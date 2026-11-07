import { Accordion, AccordionContent, AccordionItem, AccordionTrigger, Badge, Button, ScrollArea, Tooltip, ThinkingIndicator, useShape } from '@gitspace/ui';
import type { ChangeGuideView, RepositoryDiffView, ReviewThreadView } from '@gitspace/protocol';
import { Check, File02, FileCode02 } from '@untitledui/icons';
import { useContext, useEffect, useRef, useState } from 'react';
import { rpcErrorMessage } from '../rpc-error-message.js';
import { GitSpaceMarkdown } from '../GitSpaceMarkdown.js';
import { EmptyState } from '../GitSpaceShell.js';
import { GuideShareButton, type GuideShareHandlers } from './GuideShare.js';
import type { InspectorProps } from './Inspector.js';
import { type ThreadSelection, diffIdentities, RuntimeAvailability, openWorkspaceFirst, ic, settle, Kicker, Placeholder, Padded } from './inspector-shared.js';
import { PierreViewer } from './FilesSurface.js';

interface GuideViewState {
  active: number;
  anchor: { key: string; offset: number } | null;
  openedGates: Set<string>;
}
const guideViewCache = new Map<string, GuideViewState>();
/** A workspace reviewer's actions on a guide's exhibits. A shared guide's reader has none: its diffs are read-only. */
export interface GuideReview {
  threads: readonly ReviewThreadView[];
  onOpenFile(path: string): void;
  onSelectThread(thread: ReviewThreadView): void;
  onSelectRange(selection: ThreadSelection): void;
}

function GuideFileDiffBlock({ path, anchorKey, root, gateOpened, onGateOpen, onLoadDiff, review }: {
  path: string;
  anchorKey: string;
  root: { current: HTMLDivElement | null };
  gateOpened: boolean;
  onGateOpen(path: string): void;
  onLoadDiff(path: string): Promise<RepositoryDiffView>;
  review: GuideReview | null;
}) {
  const shape = useShape();
  const runtimeAvailable = useContext(RuntimeAvailability);
  const hostRef = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  const [requested, setRequested] = useState(false);
  const [diff, setDiff] = useState<RepositoryDiffView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [height, setHeight] = useState(120);
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !runtimeAvailable) return;
    const observer = new IntersectionObserver(([entry]) => {
      const next = !!entry?.isIntersecting;
      setNear(next);
      if (next) setRequested(true);
    }, { root: root.current, rootMargin: '1200px 0px', threshold: 0 });
    observer.observe(host);
    return () => observer.disconnect();
  }, [root, runtimeAvailable]);
  useEffect(() => {
    setDiff(null);
    setError(null);
    if (!runtimeAvailable || !requested) return;
    let active = true;
    void onLoadDiff(path).then((loaded) => {
      if (!active) return;
      if (loaded.path !== path || loaded.mode !== 'base') throw new Error('The diff response does not match this guide exhibit.');
      setDiff(loaded);
    }).catch((cause: unknown) => { if (active) setError(rpcErrorMessage(cause, 'Change Guide diff')); });
    return () => { active = false; };
  }, [requested, path, runtimeAvailable]);
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !near) return;
    const observer = new ResizeObserver(() => setHeight(Math.max(120, Math.round(host.getBoundingClientRect().height))));
    observer.observe(host);
    return () => observer.disconnect();
  }, [near, diff, gateOpened]);
  const large = diff ? new TextEncoder().encode(diff.patch).byteLength > 60_000 : false;
  // Off-screen blocks keep their last measured height so the walkthrough's scroll position holds while they unmount.
  if (!runtimeAvailable) return <div data-guide-anchor={anchorKey} className={`${shape.container} flex flex-col overflow-hidden border border-border`}><Tooltip content={openWorkspaceFirst}><span><Button variant="ghost" size="compact" type="button" disabled className="w-full justify-start">{ic(FileCode02, 14)}<span className="truncate font-mono">{path}</span></Button></span></Tooltip><Placeholder>Saved file reference. {openWorkspaceFirst} to inspect its diff.</Placeholder></div>;
  if (diff && !near) return <div ref={hostRef} data-guide-anchor={anchorKey} style={{ height }} />;
  return <div ref={hostRef} data-guide-anchor={anchorKey} className={`${shape.container} flex flex-col overflow-hidden border border-border`}>
    {review ? <Button variant="ghost" size="compact" type="button" className="w-full justify-start border-b border-border" onClick={() => review.onOpenFile(path)}>{ic(FileCode02, 14)}<span className="truncate font-mono">{path}</span></Button>
      : <div className="flex min-h-10 items-center gap-2 border-b border-border px-3 text-body">{ic(FileCode02, 14)}<span className="truncate font-mono">{path}</span></div>}
    {!requested ? <Placeholder>Diff loads when it approaches the reading viewport.</Placeholder>
      : error ? <Placeholder><span className="text-destructive">{error}</span></Placeholder>
        : !diff ? <div className="flex min-h-28 items-center justify-center"><ThinkingIndicator aria-label="Loading diff…" /></div>
          : large && !gateOpened ? <Placeholder><Button variant="secondary" size="compact" type="button" onClick={() => onGateOpen(path)}>Large diff · {(new TextEncoder().encode(diff.patch).byteLength / 1024).toFixed(0)} KB · Click to render</Button></Placeholder>
            : <PierreViewer path={path} identities={diffIdentities(diff, path)} patch={diff.patch} threads={review?.threads ?? []} onSelectThread={(thread) => review?.onSelectThread(thread)} onSelectRange={review?.onSelectRange} />}
  </div>;
}

export function GuideWalkthroughSection({ section, index, root, done, openedGates, onSectionRef, onToggleDone, onGateOpen, onLoadDiff, review }: {
  section: ChangeGuideView['sections'][number];
  index: number;
  root: { current: HTMLDivElement | null };
  done: boolean;
  openedGates: Set<string>;
  onSectionRef?(index: number, element: HTMLElement | null): void;
  onToggleDone(): void;
  onGateOpen(path: string): void;
  onLoadDiff(path: string): Promise<RepositoryDiffView>;
  review: GuideReview | null;
}) {
  return <AccordionItem value={section.id} ref={(element) => onSectionRef?.(index, element)} data-guide-anchor={`s${index}`}>
    <AccordionTrigger>{`${done ? '✓' : index + 1} · ${section.title}`}</AccordionTrigger>
    <AccordionContent>
      <div className="flex flex-col gap-3 pb-2">
        <div className="flex flex-wrap items-center gap-2"><Badge variant="dot" color={done ? 'green' : 'gray'}>{section.kind}</Badge><span className="text-caption text-muted-foreground tabular-nums">{section.exhibits.length} file{section.exhibits.length === 1 ? '' : 's'}</span><Button variant={done ? 'ghost' : 'secondary'} size="compact" type="button" className="ml-auto" disabled={done} onClick={onToggleDone}>{done ? <>{ic(Check, 14)}Complete</> : 'Mark complete'}</Button></div>
        <div className="flex flex-col gap-2"><GitSpaceMarkdown>{section.explanation}</GitSpaceMarkdown>{section.why ? <GitSpaceMarkdown>{`**Why:** ${section.why}`}</GitSpaceMarkdown> : null}</div>
        <div className="flex flex-col gap-3">{section.exhibits.length ? section.exhibits.map((exhibit) => <div className="flex flex-col gap-1" key={exhibit.path}>{exhibit.slowRead ? <p className="flex flex-wrap items-center gap-2 text-caption text-muted-foreground"><Badge variant="dot" color="amber">slow read</Badge>{exhibit.note || 'Reviewer attention requested.'}</p> : null}<GuideFileDiffBlock path={exhibit.path} anchorKey={`f${index}:${exhibit.path}`} root={root} gateOpened={openedGates.has(exhibit.path)} onGateOpen={onGateOpen} onLoadDiff={onLoadDiff} review={review} /></div>) : <Placeholder>No file exhibits in this section.</Placeholder>}</div>
      </div>
    </AccordionContent>
  </AccordionItem>;
}

export function ChangeGuideSurface({ guide, reviewerId, review, onLoadDiff, onMarkRead, onGenerate, shares }: {
  guide: ChangeGuideView | null;
  reviewerId: string;
  review: GuideReview;
  onLoadDiff(path: string): Promise<RepositoryDiffView>;
  onMarkRead: InspectorProps['onMarkGuideSectionRead'];
  onGenerate?: InspectorProps['onGenerateChangeGuide'];
  shares?: GuideShareHandlers;
}) {
  const viewKey = guide ? `${guide.projectId}:${guide.spaceId}:${guide.revision}` : 'empty';
  const cached = guideViewCache.get(viewKey);
  const [active, setActive] = useState(cached?.active ?? 0);
  const [open, setOpen] = useState<string[]>(() => { const id = guide?.sections[cached?.active ?? 0]?.id; return id ? [id] : []; });
  const scrollRef = useRef<HTMLDivElement>(null);
  const sectionRefs = useRef<Array<HTMLElement | null>>([]);
  const [openedGates, setOpenedGates] = useState(new Set(cached?.openedGates ?? []));
  const reviewer = guide?.reviewerStates.find((state) => state.reviewerId === reviewerId) ?? null;
  const stale = !!guide && !!reviewer && (reviewer.revision !== guide.revision || reviewer.headCommit !== guide.headCommit);
  const readIds = stale ? new Set<string>() : new Set(reviewer?.readSectionIds ?? []);
  const activeSection = guide?.sections[active] ?? null;
  useEffect(() => {
    const root = scrollRef.current;
    const anchor = cached?.anchor;
    if (!root || !anchor) return;
    let frame = 0;
    let still = 0;
    const settle = (): void => {
      const element = root.querySelector<HTMLElement>(`[data-guide-anchor="${anchor.key}"]`);
      if (element) {
        const delta = element.getBoundingClientRect().top - root.getBoundingClientRect().top - anchor.offset;
        if (Math.abs(delta) > 1) { root.scrollTop += delta; still = 0; } else still += 1;
      }
      if (still < 30 && frame++ < 480) requestAnimationFrame(settle);
    };
    requestAnimationFrame(settle);
  }, [viewKey]);
  useEffect(() => () => {
    const root = scrollRef.current;
    let anchor: GuideViewState['anchor'] = null;
    if (root) {
      const top = root.getBoundingClientRect().top;
      for (const element of root.querySelectorAll<HTMLElement>('[data-guide-anchor]')) {
        const offset = element.getBoundingClientRect().top - top;
        if (offset > 1) break;
        anchor = { key: element.dataset.guideAnchor!, offset };
      }
    }
    guideViewCache.set(viewKey, { active, anchor, openedGates: new Set(openedGates) });
  }, [viewKey, active, openedGates]);
  if (!guide || !activeSection) return <Padded><EmptyState icon={ic(File02, 22)} title="No Change Guide" description="Ask the canonical agent to delegate a narrator grounded in the Journal and current diff." action={onGenerate ? <Button variant="secondary" size="compact" type="button" onClick={() => settle(onGenerate())}>Generate Change Guide</Button> : undefined} /></Padded>;
  const go = (index: number): void => {
    setActive(index);
    let frame = 0;
    const converge = (): void => {
      const root = scrollRef.current;
      const section = sectionRefs.current[index];
      if (!root || !section) return;
      const delta = section.getBoundingClientRect().top - root.getBoundingClientRect().top - 6;
      if (Math.abs(delta) > 1) root.scrollTop += delta;
      if (frame++ < 480 && Math.abs(delta) > 1) requestAnimationFrame(converge);
    };
    requestAnimationFrame(converge);
  };
  const onOpenChange = (next: string[]): void => {
    const opened = next.find((id) => !open.includes(id));
    setOpen(next);
    if (opened) { const index = guide.sections.findIndex((section) => section.id === opened); if (index >= 0) go(index); }
  };
  return <div className="flex min-h-0 flex-1 flex-col">
    <header className="flex items-center justify-between gap-2 px-4 pb-2 pt-4">
      <span className="flex min-w-0 flex-col"><Kicker>Change Guide · the PR as a story</Kicker><span className="text-caption text-muted-foreground tabular-nums">{readIds.size} / {guide.sections.length} phases reviewed</span></span>
      <span className="flex items-center gap-2"><Badge variant="dot" color={readIds.size === guide.sections.length ? 'green' : 'gray'}>{activeSection.kind}</Badge>{shares ? <GuideShareButton revision={guide.revision} shares={shares} /> : null}</span>
    </header>
    <ScrollArea ref={(element) => { scrollRef.current = element?.querySelector<HTMLDivElement>('[data-slot="scroll-area-viewport"]') ?? null; }} className="min-h-0 flex-1" viewportClassName="h-full">
      <div className="px-3 pb-6">
        <Accordion type="multiple" value={open} onValueChange={onOpenChange} className="w-full">
          {guide.sections.map((section, index) => <GuideWalkthroughSection section={section} index={index} root={scrollRef} done={readIds.has(section.id)} openedGates={openedGates} onSectionRef={(sectionIndex, element) => { sectionRefs.current[sectionIndex] = element; }} onToggleDone={() => { if (!readIds.has(section.id)) settle(onMarkRead(section.id, guide.revision, guide.headCommit)); }} onGateOpen={(path) => setOpenedGates((current) => new Set(current).add(path))} onLoadDiff={onLoadDiff} review={review} key={section.id} />)}
        </Accordion>
      </div>
    </ScrollArea>
  </div>;
}
