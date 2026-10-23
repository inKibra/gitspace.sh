import { useRef, useState, type ReactNode } from 'react';
import { RUNTIME_QA_FILED_EXCERPT_MAX, RuntimeQaDocumentSchema, type RuntimeQaActionInput, type RuntimeQaItem } from '@gitspace/protocol-runtime/workspace-controls';
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

export type IssueAction = RuntimeQaActionInput['action'];
export interface IssuesViewProps {
  /** The workspace's `gitspace.qa` snapshot document; absent until it has one. */
  document: unknown;
  onAct(itemId: string, action: IssueAction): Promise<{ shareDraft?: string }>;
}
type Panel = { itemId: string; kind: 'merge' | 'fixed' | 'review' };

const COMMIT = /^[0-9a-f]{40}$/u;
const stateColor: Record<RuntimeQaItem['state'], NonNullable<BadgeProps['color']>> = { open: 'amber', fixed: 'green', dismissed: 'gray', merged: 'gray', shared: 'blue' };
const draftTargets: Record<'gitspace' | 'repository', string> = { gitspace: 'GitSpace', repository: 'Project repository' };

/** The Issues tab's count: open issues, or none while the document is unreadable. */
export function openIssueCount(document: unknown): number | undefined {
  const parsed = RuntimeQaDocumentSchema.safeParse(document ?? { items: [] });
  return parsed.success ? parsed.data.items.filter((item) => item.state === 'open').length : undefined;
}
const draftTargetOptions = <SelectContent>{Object.entries(draftTargets).map(([value, label], index) => <SelectItem value={value} index={index} key={value}>{label}</SelectItem>)}</SelectContent>;

/** The workspace's own issues, from its `gitspace.qa` document and nothing else. */
export function IssuesView({ document, onAct }: IssuesViewProps) {
  const shape = useShape();
  const parsed = RuntimeQaDocumentSchema.safeParse(document ?? { items: [] });
  const [panel, setPanel] = useState<Panel | null>(null);
  const [mergeTarget, setMergeTarget] = useState('');
  const [commit, setCommit] = useState('');
  const [excerpt, setExcerpt] = useState('');
  const [draftTarget, setDraftTarget] = useState<'gitspace' | 'repository'>('gitspace');
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [shareDraft, setShareDraft] = useState<string | null>(null);
  if (!parsed.success) return <div className="p-4"><div role="alert"><EmptyState icon={<AlertCircle width={22} height={22} strokeWidth={1.5} />} title="Issues could not be read" description="This workspace's saved issues document is invalid. No issue has been discarded." /></div></div>;
  const items = [...parsed.data.items].sort((a, b) => Number(b.state === 'open') - Number(a.state === 'open') || b.createdAt.localeCompare(a.createdAt));
  const openPanel = (item: RuntimeQaItem, kind: Panel['kind']): void => {
    setPanel({ itemId: item.id, kind }); setMergeTarget(''); setCommit(''); setExcerpt(kind === 'review' ? item.description : ''); setError(null);
  };
  const act = async (itemId: string, action: IssueAction): Promise<void> => {
    if (busy.current) return;
    busy.current = true; setPending(true); setError(null);
    try {
      const result = await onAct(itemId, action);
      if (result.shareDraft) {
        const url = new URL(result.shareDraft);
        if (url.protocol !== 'https:') throw new Error('The issue draft is not a secure link.');
        setShareDraft(url.href);
        window.open(url.href, '_blank', 'noopener,noreferrer');
      }
      setPanel(null);
    } catch (cause) { setError(rpcErrorMessage(cause, 'Update issue')); }
    finally { busy.current = false; setPending(false); }
  };
  const commitError = commit && !COMMIT.test(commit) ? 'Enter the full 40-character commit hash' : undefined;
  const reviewed = excerpt.trim();
  const panelBody = (item: RuntimeQaItem): ReactNode => {
    if (panel?.itemId !== item.id) return null;
    const cancel = <Button variant="ghost" size="compact" disabled={pending} onClick={() => setPanel(null)}>Cancel</Button>;
    if (panel.kind === 'merge') {
      const targets = items.filter((candidate) => candidate.id !== item.id && candidate.state !== 'merged');
      return <CardContent className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
        <Select value={mergeTarget} size="compact" onValueChange={setMergeTarget}><SelectTrigger aria-label="Merge into" placeholder="Choose the issue this repeats" /><SelectContent>{targets.map((candidate, index) => <SelectItem value={candidate.id} index={index} key={candidate.id}>{candidate.title}</SelectItem>)}</SelectContent></Select>
        <Button variant="secondary" size="compact" disabled={pending || !mergeTarget} onClick={() => void act(item.id, { kind: 'merge', targetId: mergeTarget })}>Merge</Button>{cancel}
      </CardContent>;
    }
    if (panel.kind === 'fixed') return <CardContent className="flex flex-col gap-2 border-t border-border pt-3">
      <InputGroup className="w-full"><InputField index={0} label="Fixed in commit" value={commit} placeholder="40-character commit hash" autoComplete="off" spellCheck={false} onChange={(value) => setCommit(value.trim().toLowerCase())} error={commitError} /></InputGroup>
      <div className="flex gap-2"><Button variant="secondary" size="compact" disabled={pending || !COMMIT.test(commit)} onClick={() => void act(item.id, { kind: 'fixed', commit })}>Mark fixed</Button>{cancel}</div>
    </CardContent>;
    return <CardContent className="flex flex-col gap-3 border-t border-border pt-3">
      <p className="text-caption text-muted-foreground">Remove credentials, personal data and private source. Only this text is sent, with the title, tool, model, workspace and history link.</p>
      <label className="flex flex-col gap-1 text-caption">Excerpt to send<textarea aria-label="Excerpt to send" rows={8} value={excerpt} maxLength={RUNTIME_QA_FILED_EXCERPT_MAX} className={`${shape.input} w-full border border-border bg-surface-2 p-2 text-body text-foreground`} onChange={(event) => setExcerpt(event.currentTarget.value)} /></label>
      <span className="text-caption text-muted-foreground tabular-nums">{excerpt.length} / {RUNTIME_QA_FILED_EXCERPT_MAX}</span>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" size="compact" disabled={pending || !reviewed} loading={pending} onClick={() => void act(item.id, { kind: 'file', excerpt: reviewed })}>{item.filedAt ? 'File again with GitSpace' : 'File with GitSpace'}</Button>
        <Select value={draftTarget} size="compact" onValueChange={(value) => { if (value === 'gitspace' || value === 'repository') setDraftTarget(value); }}><SelectTrigger aria-label="GitHub draft destination" />{draftTargetOptions}</Select>
        <Button variant="secondary" size="compact" disabled={pending || !reviewed} onClick={() => { if (window.confirm(`Open a GitHub issue draft at ${draftTargets[draftTarget]} containing this excerpt? It leaves your account, and you submit it there.`)) void act(item.id, { kind: 'share', target: draftTarget, redactedExcerpt: reviewed, confirmed: true }); }}>Open GitHub draft</Button>
        {cancel}
      </div>
    </CardContent>;
  };
  return <ScrollArea className="min-h-0 flex-1" viewportClassName="h-full"><div className="flex flex-col gap-3 p-4">
    <p className="text-caption text-muted-foreground">Problems agents reported in this workspace. Filing one with GitSpace sends the copy you review; nothing comes back here.</p>
    {shareDraft ? <p role="status" className="text-caption"><a className="underline underline-offset-4" href={shareDraft} target="_blank" rel="noopener noreferrer">Open the GitHub issue draft</a></p> : null}
    {error ? <p role="alert" className="text-caption text-destructive">{error}</p> : null}
    {!items.length ? <EmptyState icon={<Flag01 width={22} height={22} strokeWidth={1.5} />} title="No issues" description="Problems agents report with report_issue in this workspace appear here." /> : <CardGroup border="outlined">{items.map((item) => <Card key={item.id} data-issue-id={item.id}>
      <CardHeader>
        <CardTitle className="break-words">{item.title}</CardTitle>
        <CardDescription>{item.tool ?? 'Conversation'} · {item.model}</CardDescription>
        <CardAction className="flex flex-wrap gap-1">
          <Badge variant="dot" color={stateColor[item.state]}>{item.state === 'fixed' && item.fixedIn ? `Fixed in ${item.fixedIn.slice(0, 8)}` : item.state}</Badge>
          {item.filedAt ? <Badge color="blue">Filed</Badge> : null}
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <GitSpaceMarkdown>{item.description}</GitSpaceMarkdown>
        <ResourceLink href={item.historyRef} className="break-all font-mono text-caption text-muted-foreground">{item.historyRef}</ResourceLink>
        {item.duplicateOf ? <p className="text-caption text-muted-foreground">Merged into {items.find((candidate) => candidate.id === item.duplicateOf)?.title ?? item.duplicateOf}</p> : null}
      </CardContent>
      {item.state !== 'merged' ? <CardFooter className="flex-wrap gap-2">
        {item.state === 'open' ? <>
          <Button variant="ghost" size="compact" disabled={pending} onClick={() => void act(item.id, { kind: 'dismiss' })}>Dismiss</Button>
          <Button variant="ghost" size="compact" disabled={pending} onClick={() => openPanel(item, 'merge')}>Merge into…</Button>
          <Button variant="ghost" size="compact" disabled={pending} onClick={() => openPanel(item, 'fixed')}>Mark fixed…</Button>
        </> : null}
        <Button variant="secondary" size="compact" disabled={pending} onClick={() => openPanel(item, 'review')}>Review</Button>
      </CardFooter> : null}
      {panelBody(item)}
    </Card>)}</CardGroup>}
  </div></ScrollArea>;
}
