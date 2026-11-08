import { Button, ScrollArea } from '@gitspace/ui';
import type { ChangeGuideRevisionSummary, ChangeGuideView, EvidenceReference, GoalRecordView, RepositoryDiffView } from '@gitspace/protocol';
import { File02 } from '@untitledui/icons';
import { useEffect, useMemo, useRef, useState } from 'react';
import { BlockActionsProvider } from '../blocks/BlockActions.js';
import { useComposerStaging, workspaceBlockActions } from '../chat/staging.js';
import { EmptyState, type AgentScopeView, type WorkspaceView } from '../GitSpaceShell.js';
import { GuideScrollRoot, type GuideReview } from '../guide/ExhibitDiff.js';
import type { GuideCaptures } from '../guide/GuideCapture.js';
import { GuideDocument } from '../guide/GuideDocument.js';
import { GuideRevisionControls, OlderRevisionBanner, compareSections, type GuideComparison, type GuideDiffTarget, type GuideRevisionHandlers } from '../guide/GuideRevisions.js';
import type { GuideWorkspace } from '../guide/GuideSection.js';
import { rpcErrorMessage } from '../rpc-error-message.js';
import type { SetWorkspaceRelations } from '../WorkspaceGraph.js';
import { GuideShareButton, type GuideShareHandlers } from './GuideShare.js';
import type { InspectorProps } from './Inspector.js';
import { ic, settle, Padded } from './inspector-shared.js';

/** Where a reader left each guide revision: its open sections and scroll position, kept while the Inspector shows
 * another tab. */
const guideViewCache = new Map<string, { open: readonly string[]; scrollTop: number }>();

export function ChangeGuideSurface({ guide, reviewerId, review, goal, onSetAcceptance, onOpenEvidence, captures, scope, workspaces, onSetRelations, onLoadDiff, onMarkRead, onGenerate, shares, revisions, focusSection }: {
  /** The latest revision. */
  guide: ChangeGuideView | null;
  reviewerId: string;
  review: GuideReview;
  /** The Goal whose requirements the sections show; their checkboxes accept them. */
  goal: GoalRecordView | null;
  onSetAcceptance?(requirementId: string, accepted: boolean): Promise<void>;
  onOpenEvidence(reference: EvidenceReference): void;
  captures: GuideCaptures;
  /** The workspace the guide belongs to and its project's workspaces, for relating a follow-up to one. */
  scope?: AgentScopeView;
  workspaces: readonly WorkspaceView[];
  onSetRelations?: SetWorkspaceRelations;
  onLoadDiff(path: string, target: GuideDiffTarget): Promise<RepositoryDiffView>;
  onMarkRead: InspectorProps['onMarkGuideSectionRead'];
  onGenerate?: InspectorProps['onGenerateChangeGuide'];
  shares?: GuideShareHandlers;
  /** The stored revisions: an older one is shown read-only, and the shown one compared with an earlier one. */
  revisions?: GuideRevisionHandlers;
  /** A link to one section (a Journal decision's, a chat block's): opens it and scrolls to it, once per serial. */
  focusSection?: { id: string; serial: number } | null;
}) {
  const latest = guide?.revision ?? 0;
  const [list, setList] = useState<readonly ChangeGuideRevisionSummary[]>([]);
  const [loaded, setLoaded] = useState<ReadonlyMap<number, ChangeGuideView>>(new Map());
  const [revisionError, setRevisionError] = useState<string | null>(null);
  /** The revision shown; null: the latest. */
  const [viewing, setViewing] = useState<number | null>(null);
  /** The revision compared with; undefined: the newest earlier one this reviewer read in. */
  const [chosenSince, setChosenSince] = useState<number | null | undefined>(undefined);
  const shownRevision = viewing ?? latest;
  const shown = shownRevision === latest ? guide : loaded.get(shownRevision) ?? null;
  const since = chosenSince === undefined
    ? list.find((entry) => entry.revision < shownRevision && entry.readerIds.includes(reviewerId))?.revision ?? null
    : chosenSince !== null && chosenSince < shownRevision ? chosenSince : null;
  const earlier = since === null ? null : loaded.get(since) ?? null;
  // The handlers are recreated on every render of the workspace; the Inspector remounts per workspace.
  useEffect(() => {
    if (!revisions || !latest) return;
    let active = true;
    void revisions.list().then((entries) => { if (active) setList(entries); }, (cause: unknown) => { if (active) setRevisionError(rpcErrorMessage(cause, 'inspector.guide.revisions')); });
    return () => { active = false; };
  }, [latest]);
  useEffect(() => {
    if (!revisions) return;
    for (const revision of [shownRevision, since]) {
      if (revision === null || revision === latest || loaded.has(revision)) continue;
      void revisions.get(revision).then(
        (view) => setLoaded((current) => new Map(current).set(view.revision, view)),
        (cause: unknown) => setRevisionError(rpcErrorMessage(cause, 'inspector.guide.get')),
      );
    }
  }, [shownRevision, since, latest]);
  const viewKey = shown ? `${shown.projectId}:${shown.spaceId}:${shown.revision}` : 'empty';
  const scrollRef = useRef<HTMLElement | null>(null);
  const openRef = useRef<readonly string[]>([]);
  const staging = useComposerStaging();
  const serial = useRef(0);
  const [focus, setFocus] = useState<{ id: string; serial: number } | null>(null);
  const focusOn = (id: string): void => { serial.current += 1; setFocus({ id, serial: serial.current }); };
  useEffect(() => { if (focusSection) { setViewing(null); focusOn(focusSection.id); } }, [focusSection?.serial]);
  const blockActions = useMemo(() => workspaceBlockActions({ staging, setAcceptance: onSetAcceptance, openGuideSection: focusOn }), [staging, onSetAcceptance]);
  // Restore where the reader left this revision, again for a few frames while the diffs above load and change height.
  useEffect(() => {
    const cached = guideViewCache.get(viewKey);
    if (!cached?.scrollTop) return;
    let frame = 0;
    const restore = (): void => {
      if (scrollRef.current) scrollRef.current.scrollTop = cached.scrollTop;
      if (frame++ < 30) requestAnimationFrame(restore);
    };
    requestAnimationFrame(restore);
  }, [viewKey]);
  useEffect(() => () => { guideViewCache.set(viewKey, { open: openRef.current, scrollTop: scrollRef.current?.scrollTop ?? 0 }); }, [viewKey]);
  if (!guide?.sections.length) return <Padded><EmptyState icon={ic(File02, 22)} title="No Change Guide" description="Ask the canonical agent to delegate a narrator grounded in the Journal and current diff." action={onGenerate ? <Button variant="secondary" size="compact" type="button" onClick={() => settle(onGenerate())}>Generate Change Guide</Button> : undefined} /></Padded>;
  if (!shown) return <Padded>{revisionError ? <p role="alert" className="text-caption text-destructive">{revisionError}</p> : <p className="text-caption text-muted-foreground">Loading revision {shownRevision}…</p>}</Padded>;
  const readOnly = shown.revision !== latest;
  const reviewer = shown.reviewerStates.find((state) => state.reviewerId === reviewerId) ?? null;
  const stale = !!reviewer && (reviewer.revision !== shown.revision || reviewer.headCommit !== shown.headCommit);
  const readIds = new Set(stale ? [] : reviewer?.readSectionIds ?? []);
  const relatable = scope && 'relations' in scope && onSetRelations ? workspaces.filter((workspace) => workspace.projectId === scope.projectId && workspace.id !== scope.id && !workspace.closedAt && !scope.relations.relatedTo.includes(workspace.id)) : [];
  const workspace: GuideWorkspace = {
    review, readIds, goal, onOpenEvidence, staging, onSetAcceptance, readOnly,
    onMarkRead: (sectionId) => { if (!readOnly && !readIds.has(sectionId)) settle(onMarkRead(sectionId, shown.revision, shown.headCommit)); },
    relate: scope && 'relations' in scope && onSetRelations && relatable.length ? {
      workspaces: relatable.map((candidate) => ({ id: candidate.id, name: candidate.name })),
      onRelate: async (workspaceId) => { await onSetRelations(scope.id, { ...scope.relations, relatedTo: [...scope.relations.relatedTo, workspaceId] }); },
    } : null,
  };
  const comparison: GuideComparison | null = earlier ? {
    since: earlier.revision,
    ...compareSections(shown.sections, earlier.sections),
    onLoadSinceDiff: earlier.headCommit === shown.headCommit ? null : (path) => onLoadDiff(path, { revision: shown.revision, sinceRevision: earlier.revision }),
  } : null;
  const firstUnread = shown.sections.find((section) => !readIds.has(section.id)) ?? shown.sections[0];
  return <ScrollArea ref={(element) => { scrollRef.current = element?.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]') ?? null; }} className="min-h-0 flex-1" viewportClassName="h-full">
    <GuideScrollRoot.Provider value={scrollRef}>
      <BlockActionsProvider actions={blockActions}>
        <GuideDocument key={viewKey} guide={shown} kicker={`Change Guide · revision ${shown.revision}`} workspace={workspace} captures={captures} comparison={comparison} focusSection={focus}
          onLoadDiff={(path) => onLoadDiff(path, { revision: shown.revision })}
          banner={readOnly ? <OlderRevisionBanner shown={shown.revision} latest={latest} onLatest={() => setViewing(null)} /> : null}
          actions={<>
            {list.length > 1 ? <GuideRevisionControls revisions={list} shown={shown.revision} since={since} reviewerId={reviewerId} onShow={(revision) => setViewing(revision === latest ? null : revision)} onSince={setChosenSince} /> : null}
            {shares && !readOnly ? <GuideShareButton revision={shown.revision} shares={shares} /> : null}
            {revisionError ? <p role="alert" className="w-full text-caption text-destructive">{revisionError}</p> : null}
          </>}
          initialOpen={guideViewCache.get(viewKey)?.open ?? (firstUnread ? [firstUnread.id] : [])} onOpenChange={(open) => { openRef.current = [...open]; }} />
      </BlockActionsProvider>
    </GuideScrollRoot.Provider>
  </ScrollArea>;
}
