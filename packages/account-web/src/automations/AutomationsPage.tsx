import { Badge, Button, CardGroup, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DropdownContent, DropdownMenu, DropdownTrigger, MenuItem, ThinkingIndicator, useShape } from '@gitspace/ui';
import { ChevronDown } from '@untitledui/icons';
import { useRef, useState, type ReactElement } from 'react';
import { useResultQuery } from 'result-rpc/react';
import { AUTOMATION_DEFAULT_SETTINGS, automationSubjectKey, type AutomationMode, type AutomationRunView, type AutomationSubjectRef, type AutomationView } from '@gitspace/protocol/automations-contract';
import { BUILT_IN_MODEL_ROLES } from '@gitspace/protocol/inference';
import { accountLiveKey } from '@gitspace/protocol/live-notice';
import { EmptyState, PageCanvas, PageHeader } from '../GitSpaceShell.js';
import { useLiveChanges } from '../live-notices.js';
import { rpcClient } from '../rpc-client.js';
import { rpcErrorMessage } from '../rpc-error-message.js';
import { useEventRefresh } from '../SynchronizationProvider.js';
import { useRetainedRead } from '../useRetainedRead.js';
import { AutomationCard, type CardHandlers } from './AutomationCard.js';
import { AutomationEditor } from './AutomationEditor.js';
import { LimitsEditor } from './AutomationLimits.js';
import { LinkDialog, LinksTable } from './AutomationLinks.js';
import { AutomationPhaseGrid } from './AutomationPhaseGrid.js';
import { RunDetail, RunsTable } from './AutomationRuns.js';
import { TrustList } from './AutomationTrustedAuthors.js';
import { Section, Stat } from './automation-fields.js';
import { LimitsGlyph, LinkGlyph, NO_GITHUB, PHASE_ACTIONS, PROJECT_RUN_LIMIT, PlusGlyph, settle } from './automation-formatters.js';

export interface AutomationWorkspace {
  id: string;
  name: string;
  /** Closed (archived) workspaces only name past runs; automations cannot message them. */
  active: boolean;
  /** Its phase now, which decides whether an automation reaches it. */
  phase: AutomationMode;
}

export interface AutomationsProject {
  id: string;
  name: string;
  workspaces: readonly AutomationWorkspace[];
}

export interface AutomationsPageProps {
  projects: readonly AutomationsProject[];
  /** The project chosen in the header; null shows every project. */
  projectId: string | null;
  onSelectProject(projectId: string | null): void;
  /** `workspaceId` equal to `projectId` is the project agent. */
  onOpenWorkspace(projectId: string, workspaceId: string): void;
}

/** The page and the sidebar's failed-runs badge read the same overview entry. */
export const AUTOMATIONS_OVERVIEW_INPUT = { limit: 50 };

function ProjectPicker({ projects, project, onPick }: { projects: readonly AutomationsProject[]; project: string; onPick(projectId: string | null): void }): ReactElement {
  return <DropdownMenu>
    <DropdownTrigger render={<button type="button" className="-ml-1 flex max-w-full items-center gap-1 rounded px-1 text-caption font-medium text-muted-foreground hover:text-foreground" aria-label={`Project: ${project}`}><span className="truncate">{project}</span><ChevronDown className="shrink-0" width={14} height={14} strokeWidth={1.5} /></button>} />
    <DropdownContent align="start" className="min-w-[240px] w-[240px]">
      <MenuItem index={0} label="All projects" onSelect={() => onPick(null)} />
      {projects.map((entry, index) => <MenuItem key={entry.id} index={index + 1} label={entry.name} onSelect={() => onPick(entry.id)} />)}
    </DropdownContent>
  </DropdownMenu>;
}

/** Keeps a closing dialog's last content on screen while it animates out. */
function useClosingValue<T>(value: T | null): T | null {
  const last = useRef(value);
  if (value !== null) last.current = value;
  return value ?? last.current;
}

export function AutomationsPage({ projects, projectId, onSelectProject, onOpenWorkspace }: AutomationsPageProps): ReactElement {
  const shape = useShape();
  const now = Date.now();
  const project = projectId === null ? undefined : projects.find(entry => entry.id === projectId);
  const overview = useResultQuery(rpcClient.automations.overview, AUTOMATIONS_OVERVIEW_INPUT);
  const overviewRead = useRetainedRead(overview, 'automations-overview');
  const list = useResultQuery(rpcClient.automations.list, { projectId: projectId ?? '' }, { enabled: projectId !== null });
  const listRead = useRetainedRead(list, projectId);
  const runs = useResultQuery(rpcClient.automations.runs, { projectId: projectId ?? '', limit: PROJECT_RUN_LIMIT }, { enabled: projectId !== null });
  const runsRead = useRetainedRead(runs, projectId);
  const exceptionsQuery = useResultQuery(rpcClient.automations.exceptions.list, { projectId: projectId ?? '' }, { enabled: projectId !== null });
  const exceptionsRead = useRetainedRead(exceptionsQuery, projectId);
  const refresh = (): Promise<unknown> => Promise.all(projectId === null ? [overview.refetch()] : [overview.refetch(), list.refetch(), runs.refetch(), exceptionsQuery.refetch()]);
  useEventRefresh(useLiveChanges(accountLiveKey('automations')), refresh);

  const [editor, setEditor] = useState<{ id: number; source: AutomationView | null; test: boolean } | null>(null);
  const [linking, setLinking] = useState<{ id: number; subject: AutomationSubjectRef | null } | null>(null);
  const [deleting, setDeleting] = useState<AutomationView | null>(null);
  const [openRun, setOpenRun] = useState<AutomationRunView | null>(null);
  const [limitsOpen, setLimitsOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const shownEditor = useClosingValue(editor);
  const shownLink = useClosingValue(linking);
  const shownDelete = useClosingValue(deleting);
  const shownRun = useClosingValue(openRun);

  /** Runs one change, then rereads; the change's value, or null when it failed and its error is shown. */
  const perform = async <T,>(id: string, operation: string, work: () => Promise<T>): Promise<{ value: T } | null> => {
    setBusy(id);
    setActionError(null);
    try {
      const value = await work();
      await refresh();
      return { value };
    } catch (cause) {
      setActionError(rpcErrorMessage(cause, operation));
      return null;
    } finally {
      setBusy(null);
    }
  };

  const summaries = overviewRead.value?.projects ?? [];
  const automations = listRead.value?.automations ?? [];
  const settings = listRead.value?.settings ?? AUTOMATION_DEFAULT_SETTINGS;
  const links = listRead.value?.links ?? [];
  const github = listRead.value?.github ?? NO_GITHUB;
  const modelRoles = listRead.value?.modelRoles ?? BUILT_IN_MODEL_ROLES;
  const exceptions = exceptionsRead.value ?? [];
  const bot = github.bot ?? 'the GitSpace bot';
  const ordered = [...automations.filter(automation => automation.proposal !== null), ...automations.filter(automation => automation.proposal === null)];
  const groups = [
    { title: 'Start work', aside: null, automations: ordered.filter(automation => automation.action.kind !== 'sendToLinked') },
    { title: 'Sent to linked workspaces', aside: 'Events on a linked pull request or issue that no automation matches are not sent', automations: ordered.filter(automation => automation.action.kind === 'sendToLinked') },
  ];
  const totals = (projectId === null ? summaries : summaries.filter(entry => entry.projectId === projectId)).reduce((sum, entry) => ({
    total: sum.total + entry.total, on: sum.on + entry.on, proposed: sum.proposed + entry.proposed,
    working: sum.working + entry.working, queued: sum.queued + entry.queued, failedToday: sum.failedToday + entry.failedToday,
  }), { total: 0, on: 0, proposed: 0, working: 0, queued: 0, failedToday: 0 });
  const empty = projectId !== null && listRead.value !== undefined && automations.length === 0;
  const projectName = projectId === null ? 'All projects' : project?.name ?? projectId;
  const openEditor = (source: AutomationView | null, test = false): void => setEditor({ id: Date.now(), source, test });

  const handlers: CardHandlers = {
    toggle: automation => void perform(automation.id, automation.enabled ? 'Switch off' : 'Switch on', () => settle(rpcClient.automations.update({
      projectId: automation.projectId, automationId: automation.id,
      draft: { name: automation.name, trigger: automation.trigger, conditions: [...automation.conditions], action: automation.action, enabled: !automation.enabled, ...(automation.phases ? { phases: [...automation.phases] } : {}) },
    }))),
    runNow: automation => void perform(automation.id, 'Run now', () => settle(rpcClient.automations.runNow({ projectId: automation.projectId, automationId: automation.id }))),
    test: automation => openEditor(automation, true),
    edit: automation => openEditor(automation),
    remove: automation => setDeleting(automation),
    approve: automation => void perform(automation.id, 'Switch on', () => settle(rpcClient.automations.approve({ projectId: automation.projectId, automationId: automation.id, revision: automation.revision }))),
    dismiss: automation => void perform(automation.id, 'Dismiss', () => settle(rpcClient.automations.delete({ projectId: automation.projectId, automationId: automation.id }))),
    openConversation: automation => onOpenWorkspace(automation.projectId, automation.projectId),
    setException: (automation, workspaceId, phase, enabled) => void perform(automation.id, enabled === null ? 'Remove the exception' : 'Make an exception', () => settle(rpcClient.automations.exceptions.set({ projectId: automation.projectId, automationId: automation.id, workspaceId, phase, enabled }))),
  };

  const cancelRun = async (run: AutomationRunView): Promise<void> => {
    const done = await perform(run.id, run.state === 'queued' ? 'Cancel run' : 'Stop run', () => settle(rpcClient.automations.cancelRun({ projectId: run.projectId, runId: run.id })));
    if (done) setOpenRun(done.value);
  };

  const readError = [overviewRead.error ? rpcErrorMessage(overviewRead.error, 'Read automations overview') : null, projectId !== null && listRead.error ? rpcErrorMessage(listRead.error, 'Read automations') : null, projectId !== null && runsRead.error ? rpcErrorMessage(runsRead.error, 'Read runs') : null, projectId !== null && exceptionsRead.error ? rpcErrorMessage(exceptionsRead.error, 'Read workspace exceptions') : null].filter(Boolean).join(' · ');

  return <PageCanvas>
    <PageHeader kicker={<ProjectPicker projects={projects} project={projectName} onPick={onSelectProject} />} title="Automations"
      description={projectId === null ? 'Every project\'s automations and runs. Choose a project to change its automations, links and trusted authors.' : 'When something happens in this project, start work. Activity on a linked pull request or issue goes to its workspace.'}
      actions={projectId !== null && !empty ? <Button variant="primary" type="button" leadingIcon={PlusGlyph} onClick={() => openEditor(null)}>New automation</Button> : undefined} />

    {readError ? <div role="alert" className="mb-4 flex flex-wrap items-center gap-2 text-caption text-destructive"><span className="min-w-0 [overflow-wrap:anywhere]">{readError}</span><Button variant="ghost" size="compact" type="button" onClick={() => void refresh()}>Retry</Button></div> : null}
    {actionError ? <div role="alert" className="mb-4 flex flex-wrap items-center gap-2 text-caption text-destructive"><span className="min-w-0 [overflow-wrap:anywhere]">{actionError}</span><Button variant="ghost" size="compact" type="button" onClick={() => setActionError(null)}>Dismiss</Button></div> : null}

    {empty ? null : <section aria-label="Automation summary" className={`${shape.container} mb-6 flex flex-col bg-surface-2 shadow-surface-1`}>
      <div className="grid grid-cols-2 divide-border sm:grid-cols-4 sm:divide-x [&>*:nth-child(-n+2)]:border-b [&>*:nth-child(-n+2)]:border-border sm:[&>*:nth-child(-n+2)]:border-b-0">
        <Stat value={`${totals.on} of ${totals.total}`} label={totals.proposed ? `On · ${totals.proposed} proposed` : 'On'} />
        <Stat value={projectId === null ? totals.working : `${totals.working} / ${settings.concurrency}`} label="Working now" />
        <Stat value={totals.queued} label="Queued" />
        <Stat value={totals.failedToday} label="Failed today" />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-5 py-3">
        <p className="min-w-0 flex-[1_1_16rem] text-caption text-muted-foreground">{projectId === null
          ? 'Each project has its own limits; choose one to change them.'
          : `At most ${settings.concurrency} ${settings.concurrency === 1 ? 'run works' : 'runs work'} at once, and each automation runs at most ${settings.dailyRunCap} ${settings.dailyRunCap === 1 ? 'time' : 'times'} a day.`} A run holds a slot only while its agent works; a workspace waiting for you does not.</p>
        {projectId !== null && listRead.value ? <Button variant="ghost" size="compact" type="button" leadingIcon={LimitsGlyph} onClick={() => setLimitsOpen(true)}>Limits</Button> : null}
      </div>
    </section>}

    {projectId === null ? <>
      <Section title="Projects">
        {projects.length ? <ul className={`${shape.container} flex flex-col divide-y divide-border bg-surface-2 shadow-surface-1`}>
          {projects.map(entry => {
            const summary = summaries.find(item => item.projectId === entry.id);
            const parts = summary && summary.total ? [`${summary.on} of ${summary.total} on`, summary.proposed ? `${summary.proposed} proposed` : null, summary.working ? `${summary.working} working` : null, summary.queued ? `${summary.queued} queued` : null].filter(Boolean).join(' · ') : 'No automations';
            return <li key={entry.id}><button type="button" aria-label={`Open automations for ${entry.name}`} className="flex w-full min-w-0 flex-wrap items-center justify-between gap-2 px-5 py-3 text-left" onClick={() => onSelectProject(entry.id)}>
              <span className="flex min-w-0 flex-col gap-0.5"><span className="text-body font-medium [overflow-wrap:anywhere]">{entry.name}</span><span className="text-caption text-muted-foreground">{parts}</span></span>
              {summary?.failedToday ? <Badge size="compact" color="red">{summary.failedToday} failed today</Badge> : null}
            </button></li>;
          })}
        </ul> : <p className="text-caption text-muted-foreground">No projects yet.</p>}
      </Section>
      <Section title="Recent runs" aside={<span className="text-caption text-muted-foreground">Every project · choose one to change its automations</span>}>
        {overviewRead.initialLoading ? <p role="status" className="text-caption text-muted-foreground">Loading runs…</p>
          : overviewRead.value?.runs.length ? <RunsTable runs={overviewRead.value.runs} projects={projects} showProject now={now} onOpen={setOpenRun} />
            : <p className="text-caption text-muted-foreground">No runs yet. Every event an automation sees appears here, skipped ones included.</p>}
      </Section>
    </> : listRead.initialLoading ? <EmptyState icon={<ThinkingIndicator />} title="Loading automations…" />
      : empty ? <div className={`${shape.container} flex flex-col items-start gap-3 bg-surface-2 px-5 py-6 shadow-surface-1`}>
        <strong className="text-body font-semibold [overflow-wrap:anywhere]">No automations in {projectName}</strong>
        <p className="max-w-xl text-body text-muted-foreground">Start work when a pull request opens, an issue is labeled, or on a schedule. Installing the GitSpace GitHub App on its repository adds the default automations that send review feedback, failed checks and mentions to linked workspaces. You can also ask the project agent to set one up; what it proposes waits here until you switch it on.</p>
        <Button variant="primary" type="button" leadingIcon={PlusGlyph} onClick={() => openEditor(null)}>New automation</Button>
      </div>
        : listRead.value ? <>
          {groups.filter(group => group.automations.length).map(group => <Section key={group.title} title={group.title} aside={group.aside ? <span className="text-caption text-muted-foreground">{group.aside}</span> : undefined}>
            <CardGroup border="outlined" separated proximityHover={false} className="gap-4">
              {group.automations.map((automation, index) => <AutomationCard key={automation.id} automation={automation} exceptions={exceptions.filter(exception => exception.automationId === automation.id)} index={index} project={project} bot={bot} busy={busy === automation.id} now={now} handlers={handlers} />)}
            </CardGroup>
          </Section>)}
          {automations.some(automation => PHASE_ACTIONS.includes(automation.action.kind)) ? <Section title="By workspace" aside={<span className="text-caption text-muted-foreground">{exceptions.length} workspace {exceptions.length === 1 ? 'exception' : 'exceptions'}</span>}>
            <AutomationPhaseGrid automations={automations} workspaces={project?.workspaces ?? []} exceptions={exceptions} busy={busy} now={now} onSet={handlers.setException} />
          </Section> : null}
          <Section title="Linked pull requests and issues"
            aside={<Button variant="secondary" size="compact" type="button" leadingIcon={LinkGlyph} onClick={() => setLinking({ id: Date.now(), subject: null })}>Link a pull request or issue</Button>}>
            <p className="text-caption text-muted-foreground">Each has one workspace in this project, linked when GitSpace starts the workspace for it, when an agent or you link it, or by branch. What reaches the workspace is set by the automations under Sent to linked workspaces.</p>
            {links.length ? <LinksTable links={links} project={project} projectId={projectId} busy={busy} now={now} onOpenWorkspace={workspaceId => onOpenWorkspace(projectId, workspaceId)}
              onRelink={subject => setLinking({ id: Date.now(), subject })}
              onUnlink={subject => void perform(automationSubjectKey(subject), 'Unlink', () => settle(rpcClient.automations.unlink({ projectId, subject })))} />
              : <p className="text-caption text-muted-foreground">No pull request or issue is linked yet.</p>}
          </Section>
          <Section title="Trusted authors">
            <TrustList repository={github.repository} trusted={settings.trusted} onSave={async trusted => {
              await settle(rpcClient.automations.updateSettings({ projectId, settings: { ...settings, trusted } }));
              await refresh();
            }} />
          </Section>
          <Section title="Recent runs" aside={<span className="text-caption text-muted-foreground">Every event seen, skipped ones included</span>}>
            {runsRead.value?.length ? <RunsTable runs={runsRead.value} projects={projects} showProject={false} now={now} onOpen={setOpenRun} />
              : <p className="text-caption text-muted-foreground">{runsRead.initialLoading ? 'Loading runs…' : 'No runs yet.'}</p>}
          </Section>
        </> : null}

    <Dialog open={editor !== null} onOpenChange={open => { if (!open) setEditor(null); }}>
      <DialogContent size="lg">{shownEditor && projectId !== null ? <AutomationEditor key={shownEditor.id} projectId={projectId} workspaces={project?.workspaces ?? []} github={github} modelRoles={modelRoles} source={shownEditor.source} testFirst={shownEditor.test} now={now}
        onCancel={() => setEditor(null)} onSaved={async () => { setEditor(null); await refresh(); }}
        onRan={async run => { setEditor(null); await refresh(); setOpenRun(run); }} /> : null}</DialogContent>
    </Dialog>
    <Dialog open={linking !== null} onOpenChange={open => { if (!open) setLinking(null); }}>
      <DialogContent>{shownLink && projectId !== null ? <LinkDialog key={shownLink.id} projectId={projectId} workspaces={project?.workspaces ?? []} subject={shownLink.subject} bot={github.bot}
        onCancel={() => setLinking(null)} onLinked={async () => { setLinking(null); await refresh(); }} /> : null}</DialogContent>
    </Dialog>
    <Dialog open={deleting !== null} onOpenChange={open => { if (!open) setDeleting(null); }}>
      <DialogContent size="sm">{shownDelete ? <>
        <DialogHeader>
          <DialogTitle>Delete {shownDelete.name}?</DialogTitle>
          <DialogDescription>It stops running. This cannot be undone.</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="secondary" type="button" onClick={() => setDeleting(null)}>Keep it</Button>
          <Button variant="primary" type="button" loading={busy === shownDelete.id} disabled={busy !== null} onClick={() => void perform(shownDelete.id, 'Delete automation', () => settle(rpcClient.automations.delete({ projectId: shownDelete.projectId, automationId: shownDelete.id }))).then(done => { if (done) setDeleting(null); })}>Delete</Button>
        </DialogFooter>
      </> : null}</DialogContent>
    </Dialog>
    <Dialog open={openRun !== null} onOpenChange={open => { if (!open) setOpenRun(null); }}>
      <DialogContent size="lg">{shownRun ? <RunDetail key={shownRun.id} run={shownRun} project={projects.find(entry => entry.id === shownRun.projectId)} busy={busy === shownRun.id} onCancel={run => void cancelRun(run)}
        onOpenWorkspace={workspaceId => { setOpenRun(null); onOpenWorkspace(shownRun.projectId, workspaceId); }} /> : null}</DialogContent>
    </Dialog>
    <Dialog open={limitsOpen} onOpenChange={setLimitsOpen}>
      <DialogContent size="sm">{limitsOpen && projectId !== null ? <LimitsEditor settings={settings} onCancel={() => setLimitsOpen(false)} onSave={async next => {
        await settle(rpcClient.automations.updateSettings({ projectId, settings: next }));
        setLimitsOpen(false);
        await refresh();
      }} /> : null}</DialogContent>
    </Dialog>
  </PageCanvas>;
}
