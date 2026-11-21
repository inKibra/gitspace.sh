import { useRef, useState, type ReactNode } from 'react';
import { CHATTER_FIXED_IN_CHARACTERS, type ChatterFileAction, type ChatterIssueState, type ChatterTopic, type ChatterTopicAction } from '@gitspace/protocol/chatter-contract';
import { FILED_ISSUE_EXCERPT_MAX } from '@gitspace/protocol-runtime/workspace-controls';
import {
  Badge,
  Button,
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardGroup,
  CardHeader,
  CardTitle,
  InputField,
  InputGroup,
  ScrollArea,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  useShape,
  type BadgeProps,
} from '@gitspace/ui';
import { AlertCircle, Flag01 } from '@untitledui/icons';
import { EmptyState } from '../GitSpaceShell.js';
import { GitSpaceMarkdown } from '../GitSpaceMarkdown.js';
import { ResourceLink } from '../ResourceNavigation.js';
import { rpcErrorMessage } from '../rpc-error-message.js';
import type { WorkspaceIssues } from './useWorkspaceIssues.js';

export interface IssuesViewProps {
  /** The workspace's issue topics and their tooling posts; null until first read. */
  issues: WorkspaceIssues | null;
  /** Why the issues could not be read, if they could not. */
  error: string | null;
  /** Sets a topic's state or merges it; throws why not. */
  onAct(key: string, action: ChatterTopicAction): Promise<void>;
  /** Files a topic with GitSpace, or returns its GitHub draft link; throws why not. */
  onFile(key: string, action: ChatterFileAction): Promise<string | null>;
}
type Panel = { key: string; kind: 'merge' | 'resolve' | 'review' };

const stateColor: Record<ChatterIssueState, NonNullable<BadgeProps['color']>> = { open: 'amber', resolved: 'green', dismissed: 'gray' };
const draftTargets: Record<'gitspace' | 'repository', string> = { gitspace: 'GitSpace', repository: 'Project repository' };
const draftTargetOptions = <SelectContent>{Object.entries(draftTargets).map(([value, label], index) => <SelectItem value={value} index={index} key={value}>{label}</SelectItem>)}</SelectContent>;

/** The Issues tab's count: open issue topics, or none while they are unread. */
export function openIssueCount(issues: WorkspaceIssues | null): number | undefined {
  return issues ? issues.topics.filter((topic) => topic.state === 'open').length : undefined;
}

/** The workspace's issues: the Chatter issue topics it posted in, and GitSpace's runtime topics for it, open first. */
export function IssuesView({ issues, error: readError, onAct, onFile }: IssuesViewProps) {
  const shape = useShape();
  const [panel, setPanel] = useState<Panel | null>(null);
  const [mergeTarget, setMergeTarget] = useState('');
  const [fixedIn, setFixedIn] = useState('');
  const [excerpt, setExcerpt] = useState('');
  const [draftTarget, setDraftTarget] = useState<'gitspace' | 'repository'>('gitspace');
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [shareDraft, setShareDraft] = useState<string | null>(null);
  if (!issues) {
    return <div className="p-4">{readError
      ? <div role="alert"><EmptyState icon={<AlertCircle width={22} height={22} strokeWidth={1.5} />} title="Issues could not be read" description={readError} /></div>
      : <p className="text-caption text-muted-foreground">Reading issues…</p>}</div>;
  }
  const { topics } = issues;
  const openPanel = (topic: ChatterTopic, kind: Panel['kind']): void => {
    setPanel({ key: topic.key, kind }); setMergeTarget(''); setFixedIn(''); setExcerpt(kind === 'review' ? issues.posts.find((post) => post.topicKey === topic.key)?.text ?? topic.display : ''); setError(null);
  };
  const run = async (work: () => Promise<void>): Promise<void> => {
    if (busy.current) return;
    busy.current = true; setPending(true); setError(null);
    try { await work(); setPanel(null); }
    catch (cause) { setError(rpcErrorMessage(cause, 'Update issue')); }
    finally { busy.current = false; setPending(false); }
  };
  const act = (key: string, action: ChatterTopicAction) => run(() => onAct(key, action));
  const file = (key: string, action: ChatterFileAction) => run(async () => {
    const draft = await onFile(key, action);
    if (!draft) return;
    const url = new URL(draft);
    if (url.protocol !== 'https:') throw new Error('The issue draft is not a secure link.');
    setShareDraft(url.href);
    window.open(url.href, '_blank', 'noopener,noreferrer');
  });
  const reviewed = excerpt.trim();
  const panelBody = (topic: ChatterTopic): ReactNode => {
    if (panel?.key !== topic.key) return null;
    const cancel = <Button variant="ghost" size="compact" disabled={pending} onClick={() => setPanel(null)}>Cancel</Button>;
    if (panel.kind === 'merge') {
      const targets = topics.filter((candidate) => candidate.key !== topic.key);
      return <CardContent className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
        <Select value={mergeTarget} size="compact" onValueChange={setMergeTarget}><SelectTrigger aria-label="Merge into" placeholder="Choose the issue this repeats" /><SelectContent>{targets.map((candidate, index) => <SelectItem value={candidate.key} index={index} key={candidate.key}>{candidate.display}</SelectItem>)}</SelectContent></Select>
        <Button variant="secondary" size="compact" disabled={pending || !mergeTarget} onClick={() => void act(topic.key, { kind: 'merge', into: mergeTarget })}>Merge</Button>{cancel}
      </CardContent>;
    }
    if (panel.kind === 'resolve') return <CardContent className="flex flex-col gap-2 border-t border-border pt-3">
      <InputGroup className="w-full"><InputField index={0} label="Fixed in (optional)" value={fixedIn} placeholder="Commit or pull request" autoComplete="off" spellCheck={false} maxLength={CHATTER_FIXED_IN_CHARACTERS} onChange={(value) => setFixedIn(value)} /></InputGroup>
      <div className="flex gap-2"><Button variant="secondary" size="compact" disabled={pending} onClick={() => void act(topic.key, { kind: 'state', state: 'resolved', fixedIn: fixedIn.trim() || null })}>Resolve</Button>{cancel}</div>
    </CardContent>;
    return <CardContent className="flex flex-col gap-3 border-t border-border pt-3">
      <p className="text-caption text-muted-foreground">Remove credentials, personal data and private source. Only this text is sent, with the topic, tool, workspace and history link.</p>
      <label className="flex flex-col gap-1 text-caption">Excerpt to send<textarea aria-label="Excerpt to send" rows={8} value={excerpt} maxLength={FILED_ISSUE_EXCERPT_MAX} className={`${shape.input} w-full border border-border bg-surface-2 p-2 text-body text-foreground`} onChange={(event) => setExcerpt(event.currentTarget.value)} /></label>
      <span className="text-caption text-muted-foreground tabular-nums">{excerpt.length} / {FILED_ISSUE_EXCERPT_MAX}</span>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" size="compact" disabled={pending || !reviewed} loading={pending} onClick={() => void file(topic.key, { kind: 'file', excerpt: reviewed })}>{topic.filed?.target === 'gitspace' ? 'File again with GitSpace' : 'File with GitSpace'}</Button>
        <Select value={draftTarget} size="compact" onValueChange={(value) => { if (value === 'gitspace' || value === 'repository') setDraftTarget(value); }}><SelectTrigger aria-label="GitHub draft destination" />{draftTargetOptions}</Select>
        <Button variant="secondary" size="compact" disabled={pending || !reviewed} onClick={() => { if (window.confirm(`Open a GitHub issue draft at ${draftTargets[draftTarget]} containing this excerpt? It leaves your account, and you submit it there.`)) void file(topic.key, { kind: 'share', target: draftTarget, redactedExcerpt: reviewed, confirmed: true }); }}>Open GitHub draft</Button>
        {cancel}
      </div>
    </CardContent>;
  };
  return <ScrollArea className="min-h-0 flex-1" viewportClassName="h-full"><div className="flex flex-col gap-3 p-4">
    <p className="text-caption text-muted-foreground">Issues are Chatter topics: what this workspace's agents posted as tooling posts, and failures GitSpace recorded for it. Resolving or dismissing one changes it for the whole project.</p>
    {shareDraft ? <p role="status" className="text-caption"><a className="underline underline-offset-4" href={shareDraft} target="_blank" rel="noopener noreferrer">Open the GitHub issue draft</a></p> : null}
    {error ? <p role="alert" className="text-caption text-destructive">{error}</p> : null}
    {readError ? <p role="alert" className="text-caption text-destructive">{readError}</p> : null}
    {!topics.length ? <EmptyState icon={<Flag01 width={22} height={22} strokeWidth={1.5} />} title="No issues" description="Tooling posts this workspace's agents make in Chatter, and failures GitSpace records for it, appear here." /> : <CardGroup border="outlined">{topics.map((topic) => {
      const latest = issues.posts.find((post) => post.topicKey === topic.key);
      const state = topic.state ?? 'open';
      const others = topic.participants.filter((participant) => participant.kind !== 'person').length - 1;
      return <Card key={topic.key} data-issue-key={topic.key}>
        <CardHeader>
          <CardTitle className="break-words">{topic.display}</CardTitle>
          <CardDescription>{latest?.spot?.tool ?? 'Chatter'} · {topic.posts} post{topic.posts === 1 ? '' : 's'}{topic.repeats ? ` · repeated ${topic.repeats}×` : ''}{others > 0 ? ` · ${others} other workspace${others === 1 ? '' : 's'}` : ''}</CardDescription>
          <CardAction className="flex flex-wrap gap-1">
            <Badge variant="dot" color={stateColor[state]}>{state === 'resolved' && topic.fixedIn ? `Resolved in ${topic.fixedIn.slice(0, 12)}` : state}</Badge>
            {topic.filed ? <Badge color="blue">{topic.filed.target === 'gitspace' ? 'Filed' : 'Draft shared'}</Badge> : null}
          </CardAction>
        </CardHeader>
        {latest ? <CardContent className="flex flex-col gap-2">
          <GitSpaceMarkdown>{latest.text}</GitSpaceMarkdown>
          {latest.spot ? <ResourceLink href={latest.spot.reference} className="break-all font-mono text-caption text-muted-foreground">{latest.spot.reference}</ResourceLink> : null}
          {latest.spot?.machine ? <p className="text-caption text-muted-foreground">On {latest.spot.machine}</p> : null}
        </CardContent> : null}
        <CardFooter className="flex-wrap gap-2">
          {state === 'open' ? <>
            <Button variant="ghost" size="compact" disabled={pending} onClick={() => openPanel(topic, 'resolve')}>Resolve…</Button>
            <Button variant="ghost" size="compact" disabled={pending} onClick={() => void act(topic.key, { kind: 'state', state: 'dismissed', fixedIn: null })}>Dismiss</Button>
            <Button variant="ghost" size="compact" disabled={pending || topics.length < 2} onClick={() => openPanel(topic, 'merge')}>Merge into…</Button>
          </> : <Button variant="ghost" size="compact" disabled={pending} onClick={() => void act(topic.key, { kind: 'state', state: 'open', fixedIn: null })}>Reopen</Button>}
          <Button variant="secondary" size="compact" disabled={pending} onClick={() => openPanel(topic, 'review')}>Review</Button>
        </CardFooter>
        {panelBody(topic)}
      </Card>;
    })}</CardGroup>}
  </div></ScrollArea>;
}
