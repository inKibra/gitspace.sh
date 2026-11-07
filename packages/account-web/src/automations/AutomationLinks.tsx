import { Button, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DropdownContent, DropdownMenu, DropdownTrigger, MenuItem, Select, SelectTrigger, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@gitspace/ui';
import { DotsHorizontal } from '@untitledui/icons';
import { useState, type ReactElement } from 'react';
import { automationErrors, automationSubjectKey, automationSubjectName, type AutomationLinkView, type AutomationSubject, type AutomationSubjectRef } from '@gitspace/protocol/automations-contract';
import { formatRelativeTime } from '../relative-time.js';
import { rpcClient } from '../rpc-client.js';
import { rpcErrorMessage } from '../rpc-error-message.js';
import { type AutomationWorkspace, type AutomationsProject } from './AutomationsPage.js';
import { Field, TextInput, options } from './automation-fields.js';
import { LINK_LABEL, LinkGlyph, SUBJECT_KINDS, SUBJECT_KIND_LABEL, type SubjectKind, UnlinkGlyph, parseSubjectRef, settle, subjectRef, subjectTitle, workspaceLabel } from './automation-formatters.js';

function SubjectLabel({ subject }: { subject: AutomationSubject }): ReactElement {
  const title = subjectTitle(subject);
  return subject.url ? <a href={subject.url} target="_blank" rel="noreferrer" className="hover:underline">{title}</a> : <>{title}</>;
}

function LinkMenu({ link, busy, onRelink, onUnlink }: { link: AutomationLinkView; busy: boolean; onRelink(subject: AutomationSubjectRef): void; onUnlink(subject: AutomationSubjectRef): void }): ReactElement | null {
  const ref = subjectRef(link.subject);
  if (!ref) return null;
  return <DropdownMenu>
    <DropdownTrigger render={<Button variant="ghost" size="icon" type="button" aria-label={`Actions for ${automationSubjectName(link.subject)}`} disabled={busy}><DotsHorizontal width={16} height={16} strokeWidth={1.5} /></Button>} />
    <DropdownContent align="end" className="min-w-[220px] w-[220px]">
      <MenuItem index={0} icon={LinkGlyph} label="Link to another workspace" onSelect={() => onRelink(ref)} />
      <MenuItem index={1} icon={UnlinkGlyph} label="Unlink" onSelect={() => onUnlink(ref)} />
    </DropdownContent>
  </DropdownMenu>;
}

export function LinksTable({ links, project, projectId, busy, now, onOpenWorkspace, onRelink, onUnlink }: { links: readonly AutomationLinkView[]; project: AutomationsProject | undefined; projectId: string; busy: string | null; now: number; onOpenWorkspace(workspaceId: string): void; onRelink(subject: AutomationSubjectRef): void; onUnlink(subject: AutomationSubjectRef): void }): ReactElement {
  const rows = links.map(link => ({
    link,
    key: automationSubjectKey(link.subject),
    activity: link.lastActivity ? `${link.lastActivity.label} · ${formatRelativeTime(link.lastActivity.at, now)}` : 'No activity yet',
    workspace: <button type="button" className="max-w-full truncate text-left font-mono text-caption underline decoration-dotted underline-offset-2" onClick={() => onOpenWorkspace(link.workspaceId)}>{workspaceLabel(project, projectId, link.workspaceId)}</button>,
  }));
  return <>
    <ul aria-label="Links" className="flex flex-col divide-y divide-border border-y border-border sm:hidden">
      {rows.map(({ link, key, activity, workspace }) => <li key={key} className="flex items-start gap-2 py-3">
        <div className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
          <span className="text-body [overflow-wrap:anywhere]"><SubjectLabel subject={link.subject} /></span>
          {workspace}
          <span className="text-caption text-muted-foreground [overflow-wrap:anywhere]">{LINK_LABEL[link.source]}{link.detail ? ` · ${link.detail}` : ''}</span>
          <span className="text-caption text-muted-foreground [overflow-wrap:anywhere]">{activity}</span>
        </div>
        <LinkMenu link={link} busy={busy === key} onRelink={onRelink} onUnlink={onUnlink} />
      </li>)}
    </ul>
    <div className="hidden sm:block"><Table size="compact">
      <TableHeader><TableRow>
        <TableHead className="w-[32%]">Pull request or issue</TableHead>
        <TableHead className="w-[17%]">Workspace</TableHead>
        <TableHead className="w-[27%]">Linked</TableHead>
        <TableHead>Last activity</TableHead>
        <TableHead className="w-10" />
      </TableRow></TableHeader>
      <TableBody>
        {rows.map(({ link, key, activity, workspace }, index) => <TableRow key={key} index={index}>
          <TableCell className="max-w-0"><span className="block truncate"><SubjectLabel subject={link.subject} /></span></TableCell>
          <TableCell className="max-w-0">{workspace}</TableCell>
          <TableCell className="max-w-0">
            <span className="block truncate">{LINK_LABEL[link.source]}</span>
            {link.detail ? <span className="block truncate text-caption text-muted-foreground">{link.detail}</span> : null}
          </TableCell>
          <TableCell className="max-w-0 text-caption text-muted-foreground"><span className="block truncate">{activity}</span></TableCell>
          <TableCell><LinkMenu link={link} busy={busy === key} onRelink={onRelink} onUnlink={onUnlink} /></TableCell>
        </TableRow>)}
      </TableBody>
    </Table></div>
  </>;
}

export function LinkDialog({ projectId, workspaces, subject, bot, onCancel, onLinked }: { projectId: string; workspaces: readonly AutomationWorkspace[]; subject: AutomationSubjectRef | null; bot: string | null; onCancel(): void; onLinked(): Promise<void> }): ReactElement {
  const [workspaceId, setWorkspaceId] = useState('');
  const [kind, setKind] = useState<SubjectKind>(subject?.kind ?? 'pullRequest');
  const [text, setText] = useState(subject ? subject.kind === 'branch' ? subject.branch : `#${subject.number}` : '');
  const [attempted, setAttempted] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const parsed = parseSubjectRef(kind, text);
  const key = `${workspaceId}\n${kind}\n${text}`;
  const workspace = workspaces.find(entry => entry.id === workspaceId);
  const subjectLabel = kind === 'branch' ? 'Branch' : 'Number or link';

  const link = async (): Promise<void> => {
    setAttempted(true);
    if (!parsed || !workspaceId || pending) return;
    setPending(true);
    try {
      await settle(rpcClient.automations.link({ projectId, subject: parsed, workspaceId }));
      await onLinked();
    } catch (cause) {
      setFailure({ key, message: automationErrors.automationInvalid.is(cause) ? cause.data.message : rpcErrorMessage(cause, 'Link') });
    } finally {
      setPending(false);
    }
  };

  return <>
    <DialogHeader>
      <DialogTitle>{subject ? `Link ${automationSubjectName(subject)} to another workspace` : 'Link a pull request or issue'}</DialogTitle>
      <DialogDescription>Its activity goes to this workspace{bot ? `, and mentions of ${bot} on it reach the workspace's agent` : ''}.</DialogDescription>
    </DialogHeader>
    <form id="automation-link" noValidate className="flex min-w-0 flex-col gap-4" onSubmit={event => { event.preventDefault(); void link(); }}>
      <Field label="Workspace" error={attempted && !workspaceId ? 'Choose the workspace to link it to.' : undefined}><Select value={workspaceId} onValueChange={setWorkspaceId} disabled={workspaces.length === 0}>
        <SelectTrigger aria-label="Workspace" placeholder={workspaces.length ? 'Choose a workspace' : 'No workspaces in this project'} />{options(workspaces.map(entry => ({ value: entry.id, label: entry.active ? entry.name : `${entry.name} (closed)` })))}
      </Select></Field>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[11rem_minmax(0,1fr)]">
        <Field label="Kind"><Select value={kind} onValueChange={value => { const next = SUBJECT_KINDS.find(entry => entry === value); if (next) setKind(next); }}>
          <SelectTrigger aria-label="Kind" />{options(SUBJECT_KINDS.map(entry => ({ value: entry, label: SUBJECT_KIND_LABEL[entry] })))}
        </Select></Field>
        <Field label={subjectLabel} error={attempted && !parsed ? kind === 'branch' ? 'Name the branch.' : 'Enter a number such as #1140, or paste the pull request or issue link.' : undefined}>
          <TextInput label={subjectLabel} value={text} onChange={setText} invalid={attempted && !parsed} mono placeholder={kind === 'branch' ? 'feature/login' : '#1140'} />
        </Field>
      </div>
      <p className="text-caption text-muted-foreground">A link you or an agent make replaces one found by branch. A pull request or issue has one workspace in this project; linking it here moves it from its current workspace.{workspace && !workspace.active ? ' Linking it reopens the closed workspace.' : ''}</p>
      {failure?.key === key ? <p role="alert" className="text-caption text-destructive [overflow-wrap:anywhere]">{failure.message}</p> : null}
    </form>
    <DialogFooter>
      <Button variant="secondary" type="button" onClick={onCancel}>Cancel</Button>
      <Button variant="primary" type="submit" form="automation-link" leadingIcon={LinkGlyph} loading={pending} disabled={pending}>Link</Button>
    </DialogFooter>
  </>;
}
