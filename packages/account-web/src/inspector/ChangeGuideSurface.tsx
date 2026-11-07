import { Button, ScrollArea } from '@gitspace/ui';
import type { ChangeGuideView, EvidenceReference, GoalRecordView, RepositoryDiffView } from '@gitspace/protocol';
import { File02 } from '@untitledui/icons';
import { useEffect, useMemo, useRef, useState } from 'react';
import { BlockActionsProvider } from '../blocks/BlockActions.js';
import { useComposerStaging, workspaceBlockActions } from '../chat/staging.js';
import { EmptyState, type AgentScopeView, type WorkspaceView } from '../GitSpaceShell.js';
import { GuideScrollRoot, type GuideReview } from '../guide/ExhibitDiff.js';
import { GuideDocument, type GuideCaptures } from '../guide/GuideDocument.js';
import type { GuideWorkspace } from '../guide/GuideSection.js';
import type { SetWorkspaceRelations } from '../WorkspaceGraph.js';
import { GuideShareButton, type GuideShareHandlers } from './GuideShare.js';
import type { InspectorProps } from './Inspector.js';
import { ic, settle, Padded } from './inspector-shared.js';

/** Where a reader left each guide revision: its open sections and scroll position, kept while the Inspector shows
 * another tab. */
const guideViewCache = new Map<string, { open: readonly string[]; scrollTop: number }>();

export function ChangeGuideSurface({ guide, reviewerId, review, goal, onSetAcceptance, onOpenEvidence, captures, scope, workspaces, onSetRelations, onLoadDiff, onMarkRead, onGenerate, shares, focusSection }: {
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
  onLoadDiff(path: string): Promise<RepositoryDiffView>;
  onMarkRead: InspectorProps['onMarkGuideSectionRead'];
  onGenerate?: InspectorProps['onGenerateChangeGuide'];
  shares?: GuideShareHandlers;
  /** A link to one section (a Journal decision's, a chat block's): opens it and scrolls to it, once per serial. */
  focusSection?: { id: string; serial: number } | null;
}) {
  const viewKey = guide ? `${guide.projectId}:${guide.spaceId}:${guide.revision}` : 'empty';
  const scrollRef = useRef<HTMLElement | null>(null);
  const openRef = useRef<readonly string[]>([]);
  const staging = useComposerStaging();
  const serial = useRef(0);
  const [focus, setFocus] = useState<{ id: string; serial: number } | null>(null);
  const focusOn = (id: string): void => { serial.current += 1; setFocus({ id, serial: serial.current }); };
  useEffect(() => { if (focusSection) focusOn(focusSection.id); }, [focusSection?.serial]);
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
  const reviewer = guide.reviewerStates.find((state) => state.reviewerId === reviewerId) ?? null;
  const stale = !!reviewer && (reviewer.revision !== guide.revision || reviewer.headCommit !== guide.headCommit);
  const readIds = new Set(stale ? [] : reviewer?.readSectionIds ?? []);
  const relatable = scope && 'relations' in scope && onSetRelations ? workspaces.filter((workspace) => workspace.projectId === scope.projectId && workspace.id !== scope.id && !workspace.closedAt && !scope.relations.relatedTo.includes(workspace.id)) : [];
  const workspace: GuideWorkspace = {
    review, readIds, goal, onOpenEvidence, staging, onSetAcceptance,
    onMarkRead: (sectionId) => { if (!readIds.has(sectionId)) settle(onMarkRead(sectionId, guide.revision, guide.headCommit)); },
    relate: scope && 'relations' in scope && onSetRelations && relatable.length ? {
      workspaces: relatable.map((candidate) => ({ id: candidate.id, name: candidate.name })),
      onRelate: async (workspaceId) => { await onSetRelations(scope.id, { ...scope.relations, relatedTo: [...scope.relations.relatedTo, workspaceId] }); },
    } : null,
  };
  const firstUnread = guide.sections.find((section) => !readIds.has(section.id)) ?? guide.sections[0]!;
  return <ScrollArea ref={(element) => { scrollRef.current = element?.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]') ?? null; }} className="min-h-0 flex-1" viewportClassName="h-full">
    <GuideScrollRoot.Provider value={scrollRef}>
      <BlockActionsProvider actions={blockActions}>
        <GuideDocument key={viewKey} guide={guide} kicker={`Change Guide · revision ${guide.revision}`} workspace={workspace} captures={captures} onLoadDiff={onLoadDiff} focusSection={focus}
          actions={shares ? <GuideShareButton revision={guide.revision} shares={shares} /> : null}
          initialOpen={guideViewCache.get(viewKey)?.open ?? [firstUnread.id]} onOpenChange={(open) => { openRef.current = [...open]; }} />
      </BlockActionsProvider>
    </GuideScrollRoot.Provider>
  </ScrollArea>;
}
