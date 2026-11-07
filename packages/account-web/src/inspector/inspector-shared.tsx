import { Badge, Card, CardDescription, CardHeader, CardTitle, SelectContent, SelectItem, type BadgeProps } from '@gitspace/ui';
import type { EvidenceReference, RepositoryDiffView, RepositoryMode, ReviewAnchor } from '@gitspace/protocol';
import { createContext, type ComponentType, type ReactNode } from 'react';

export interface InspectorArtifactContent {
  url: string;
  source: string | null;
  previewUrl: string;
  mediaType: string | null;
  /** Saves the file under its own name; absent for content that is not a stored drive file. */
  downloadUrl?: string;
  /** Larger than the preview limit: offered as a download instead. */
  oversized?: boolean;
  dispose?(): void;
}
export function selectOptions(options: readonly { value: string; label: ReactNode }[]): ReactNode {
  return <SelectContent>{options.map((option, index) => <SelectItem value={option.value} index={index} key={option.value}>{option.label}</SelectItem>)}</SelectContent>;
}
export type ArtifactReference = Extract<EvidenceReference, { kind: 'artifact' }>;
export type LoadStatus = 'loading' | 'loaded' | 'error' | undefined;
type ToneColor = NonNullable<BadgeProps['color']>;
type ThreadIdentity = Pick<Extract<ReviewAnchor, { kind: 'line' }>, 'generation' | 'baseCommit' | 'headCommit' | 'blobId'>;
export interface ThreadSelection { path: string; side: 'base' | 'head'; startLine: number; endLine: number; identity: ThreadIdentity }
export type ThreadIdentities = Record<'base' | 'head', ThreadIdentity>;
export function diffIdentities(diff: RepositoryDiffView, path: string): ThreadIdentities {
  const file = diff.files.find((entry) => entry.path === path);
  const context = { generation: diff.generation, baseCommit: diff.baseCommit, headCommit: diff.headCommit };
  return { base: { ...context, blobId: file?.oldBlobId ?? null }, head: { ...context, blobId: file?.newBlobId ?? null } };
}
export const RuntimeAvailability = createContext(true);
export const openWorkspaceFirst = 'Open this workspace on a machine first';
export const repositoryModes: ReadonlyArray<{ id: RepositoryMode; label: string }> = [
  { id: 'current', label: 'Current files' },
  { id: 'working', label: 'Unstaged' },
  { id: 'staged', label: 'Staged' },
  { id: 'base', label: 'All changes since base' },
];
type Glyph = ComponentType<{ width?: number; height?: number; strokeWidth?: number; className?: string }>;
export function ic(Icon: Glyph, size = 16): ReactNode { return <Icon width={size} height={size} strokeWidth={1.5} />; }

export function settle(promise: Promise<void>): void { void promise.catch(() => undefined); }
export function shortHash(value: string | null): string { return value ? value.slice(0, 8) : 'untracked'; }
export function formatDate(value: string): string { return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)); }
export function artifactId(reference: ArtifactReference): string { return `${reference.url}@${reference.hash}`; }
function toneColor(value: string): ToneColor {
  switch (value) {
    case 'accepted': case 'pass': case 'passed': case 'satisfied': case 'approved': case 'ready': case 'running': case 'done': return 'green';
    case 'review': case 'pending': case 'stale': case 'passable': case 'starting': return 'amber';
    case 'missing': case 'fail': case 'failed': case 'blocked': case 'changes-requested': return 'red';
    default: return 'gray';
  }
}
export function Tone({ value }: { value: string }) { return <Badge variant="dot" color={toneColor(value)}>{value}</Badge>; }
export function Kicker({ children }: { children: ReactNode }) { return <span className="text-caption text-muted-foreground">{children}</span>; }
export function Heading({ children }: { children: ReactNode }) { return <h2 className="text-title font-semibold text-foreground">{children}</h2>; }
export function SectionTitle({ children }: { children: ReactNode }) { return <h3 className="text-caption font-medium text-muted-foreground">{children}</h3>; }
export function Placeholder({ children }: { children: ReactNode }) {
  return <div className="grid min-h-28 place-items-center p-4 text-center text-caption text-muted-foreground">{children}</div>;
}
export function Padded({ children }: { children: ReactNode }) { return <div className="p-4">{children}</div>; }
export function MetaCard({ label, children }: { label: string; children: ReactNode }) {
  return <Card size="compact"><CardHeader><CardDescription>{label}</CardDescription><CardTitle className="flex items-center gap-2 truncate tabular-nums">{children}</CardTitle></CardHeader></Card>;
}
