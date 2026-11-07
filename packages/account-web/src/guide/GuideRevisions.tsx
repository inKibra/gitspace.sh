// The revisions of a workspace's Change Guide: a picker that shows an older revision read-only, the earlier revision a
// reader compares against ("changes since"), and how each section differs from it. Sections compare by id and content
// hash; a section without a hash compares by its whole content.
import type { ChangeGuideRevisionSummary, ChangeGuideSection, ChangeGuideView, RepositoryDiffView } from '@gitspace/protocol';
import { Badge, Button, Select, SelectContent, SelectItem, SelectTrigger, badgeColors } from '@gitspace/ui';
import { formatRelativeTime } from '../relative-time.js';
import { Source } from './Authorship.js';

/** Reads the workspace's stored guide revisions. */
export interface GuideRevisionHandlers {
  list(): Promise<readonly ChangeGuideRevisionSummary[]>;
  get(revision: number): Promise<ChangeGuideView>;
}

/** The revision an exhibit's diff is read at: between its base and head commits, or with `sinceRevision`, between that
 * earlier revision's head commit and this one's. */
export interface GuideDiffTarget {
  revision: number;
  sinceRevision?: number;
}

export type SectionChange = 'new' | 'changed' | 'unchanged';

/** How the shown revision differs from an earlier one. */
export interface GuideComparison {
  since: number;
  changes: ReadonlyMap<string, SectionChange>;
  removed: readonly ChangeGuideSection[];
  /** An exhibit's diff between the earlier revision's head commit and this one's; null when both narrate the same head. */
  onLoadSinceDiff: ((path: string) => Promise<RepositoryDiffView>) | null;
}

const CHANGE: Record<SectionChange, { label: string; color: 'green' | 'amber' | 'gray' }> = {
  new: { label: 'New', color: 'green' },
  changed: { label: 'Changed', color: 'amber' },
  unchanged: { label: 'Unchanged', color: 'gray' },
};

export function compareSections(current: readonly ChangeGuideSection[], earlier: readonly ChangeGuideSection[]): Pick<GuideComparison, 'changes' | 'removed'> {
  const before = new Map(earlier.map((section) => [section.id, section]));
  const ids = new Set(current.map((section) => section.id));
  const changes = new Map<string, SectionChange>();
  for (const section of current) {
    const previous = before.get(section.id);
    const same = previous !== undefined && (section.contentHash !== undefined && previous.contentHash !== undefined
      ? section.contentHash === previous.contentHash
      : JSON.stringify(section) === JSON.stringify(previous));
    changes.set(section.id, previous === undefined ? 'new' : same ? 'unchanged' : 'changed');
  }
  return { changes, removed: earlier.filter((section) => !ids.has(section.id)) };
}

export function SectionChangeBadge({ change, since }: { change: SectionChange; since: number }) {
  return <span title={`Compared with r${since}`} data-section-change={change}><Badge size="compact" variant="dot" color={CHANGE[change].color}>{CHANGE[change].label}</Badge></span>;
}

/** The revision picker and the revision the shown one is compared with. */
export function GuideRevisionControls({ revisions, shown, since, reviewerId, onShow, onSince }: {
  revisions: readonly ChangeGuideRevisionSummary[];
  shown: number;
  since: number | null;
  reviewerId: string;
  onShow(revision: number): void;
  onSince(revision: number | null): void;
}) {
  const earlier = revisions.filter((entry) => entry.revision < shown);
  const labels = new Map(revisions.map((entry) => [entry.revision, `r${entry.revision} · ${entry.headCommit.slice(0, 7)} · ${formatRelativeTime(new Date(entry.createdAt))}`]));
  return <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
    <div className="flex items-center gap-1.5 text-caption text-muted-foreground">Revision
      <div className="w-56 max-w-full"><Select value={String(shown)} onValueChange={(value) => onShow(Number(value))} size="compact">
        <SelectTrigger aria-label="Guide revision" />
        <SelectContent>{revisions.map((entry, index) => <SelectItem key={entry.revision} value={String(entry.revision)} index={index}>{labels.get(entry.revision)}</SelectItem>)}</SelectContent>
      </Select></div>
    </div>
    {earlier.length ? <div className="flex items-center gap-1.5 text-caption text-muted-foreground">Changes since
      <div className="w-64 max-w-full"><Select value={since === null ? 'none' : String(since)} onValueChange={(value) => onSince(value === 'none' ? null : Number(value))} size="compact">
        <SelectTrigger aria-label="Changes since" />
        <SelectContent>
          <SelectItem value="none" index={0}>No comparison</SelectItem>
          {earlier.map((entry, index) => <SelectItem key={entry.revision} value={String(entry.revision)} index={index + 1}>{`${labels.get(entry.revision)}${entry.readerIds.includes(reviewerId) ? ' · you read' : ''}`}</SelectItem>)}
        </SelectContent>
      </Select></div>
    </div> : null}
  </div>;
}

/** Above an older revision: which one it is, and the way back to the latest. */
export function OlderRevisionBanner({ shown, latest, onLatest }: { shown: number; latest: number; onLatest(): void }) {
  return <div role="status" className="flex flex-wrap items-center gap-x-1.5 gap-y-1 border-l-2 py-1 pl-3 text-body" style={{ borderColor: badgeColors.amber }}>
    <span className="font-medium text-foreground">Viewing r{shown} of {latest}</span>
    <span className="text-muted-foreground">·</span>
    <Button variant="tertiary" size="compact" type="button" onClick={onLatest}>Back to latest</Button>
    <span className="w-full text-caption text-muted-foreground">Read-only: reading, accepting requirements and follow-ups happen on the latest revision.</span>
  </div>;
}

/** What changed since the compared revision: counts, the sections it had that are gone, and whether its code moved. */
export function ComparisonSummary({ comparison }: { comparison: GuideComparison }) {
  const count = (change: SectionChange): number => [...comparison.changes.values()].filter((value) => value === change).length;
  return <div className="flex flex-col gap-1.5" data-comparison={comparison.since}>
    <p className="flex flex-wrap items-center gap-x-1.5 text-caption tabular-nums text-muted-foreground">
      <span>Since r{comparison.since}: {count('new')} new · {count('changed')} changed · {count('unchanged')} unchanged · {comparison.removed.length} removed</span>
      <Source by="gitspace" what="the comparison: sections match by id and content hash, or by their whole content without a hash" />
    </p>
    {comparison.onLoadSinceDiff ? null : <p className="text-caption text-muted-foreground">Both revisions narrate the same head commit: the code is unchanged, only the guide changed.</p>}
    {comparison.removed.length ? <div className="flex flex-col gap-1" data-removed-since={comparison.since}>
      <span className="text-caption font-semibold uppercase tracking-wide text-muted-foreground">Removed since r{comparison.since}</span>
      <ul className="flex list-disc flex-col gap-0.5 pl-5 text-body text-muted-foreground">{comparison.removed.map((section) => <li key={section.id}>{section.title}</li>)}</ul>
    </div> : null}
  </div>;
}
