// Projects: a grid of project cards, each with its repository and base branch and its health (origin in sync or
// behind, how GitHub is reached, failed operations, members, workspaces running, automation runs going on). A card
// opens the project overview (recent workspaces, automation runs, members) with Settings one click away. New project (the
// wizard in project-setup.tsx, with the full Connect repositories steps) is here and as a "+" on the board. An Admin
// sees the projects they aren't in only as a Join project card.
import { PHASE_LABEL } from '../../GitSpaceShell.js';
import { glyph } from '../../glyph.js';
import { Button } from '@gitspace/ui';
import { AlertCircle, ArrowLeft, CheckCircle, FolderPlus, GitBranch01, Plus, Settings01, Zap } from '@untitledui/icons';
import { useState } from 'react';
import { findPrincipal, memberships, PROJECTS, visibleProjects, WORKSPACES } from '../data.js';
import { membersOf, HoldersOrFree } from '../people.js';
import { projectName } from '../settings/data.js';
import { Avatar, Note, Pill, Section, SettingRow, SettingRows } from '../settings/parts.js';
import { JoinProjectDialog } from '../settings/projects.js';
import { projectRoleOf, useRoles } from '../settings/roles.js';
import { useMock, useViewer } from '../viewer.js';
import { AUTOMATION_RUNS, PROJECT_HEALTH } from './data.js';
import { LivePage } from './parts.js';
import { NewProjectWizard } from '../project-setup.js';

const RUN_TONE = { running: 'blue', failed: 'red', succeeded: 'green' } as const;

export function ProjectsGrid({ creating: startCreating }: { creating: boolean }) {
  const viewer = useViewer();
  const { navigate } = useMock();
  useRoles();
  memberships.use();
  const [creating, setCreating] = useState(startCreating);
  const [joining, setJoining] = useState<string | null>(null);
  const seen = visibleProjects(viewer.id);
  const active = PROJECTS.filter((project) => !project.archived);
  const mine = active.filter((project) => seen.has(project.id));
  const joinable = viewer.accountRole === 'admin' ? active.filter((project) => !seen.has(project.id)) : [];
  return <LivePage title="Projects" viewer={viewer} description="Each project’s repository and health. A card opens the project; its settings are one click from there."
    actions={<Button variant="primary" leadingIcon={glyph(Plus)} onClick={() => setCreating(true)}>New project</Button>}>
    <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-4" data-project-grid="">
      {mine.map((project) => <ProjectCard key={project.id} projectId={project.id} onOpen={() => navigate('project', { project: project.id })} onSettings={() => navigate('project-settings', { project: project.id, page: 'members' })} />)}
      {joinable.map((project) => <div key={project.id} data-project-card={project.id} className="flex flex-col gap-3 rounded-2xl border border-dashed border-border p-4 opacity-80">
        <span className="flex items-center gap-2 text-body font-semibold text-foreground">{project.name}<Pill>Not a member</Pill></span>
        <Note>As an Admin you don’t see projects you aren’t in: not their workspaces, conversations or members. Joining shows in its member list and the audit log.</Note>
        <div><Button variant="secondary" leadingIcon={glyph(FolderPlus)} onClick={() => setJoining(project.id)}>Join project {project.name}</Button></div>
      </div>)}
    </div>
    {PROJECTS.some((project) => project.archived && seen.has(project.id)) ? <Note>Archived: {PROJECTS.filter((project) => project.archived && seen.has(project.id)).map((project) => project.name).join(', ')}.</Note> : null}
    {creating ? <NewProjectWizard onClose={() => setCreating(false)} /> : null}
    {joining ? <JoinProjectDialog projectId={joining} onClose={() => setJoining(null)} onJoined={() => navigate('project', { project: joining })} /> : null}
  </LivePage>;
}

function ProjectCard({ projectId, onOpen, onSettings }: { projectId: string; onOpen(): void; onSettings(): void }) {
  const viewer = useViewer();
  const project = PROJECTS.find((entry) => entry.id === projectId);
  const health = PROJECT_HEALTH[projectId];
  if (!project || !health) return null;
  const open = WORKSPACES.filter((workspace) => workspace.projectId === projectId && !workspace.archived);
  const running = open.filter((workspace) => workspace.color === 'green');
  const runs = AUTOMATION_RUNS.filter((run) => run.projectId === projectId && run.state === 'running');
  const members = membersOf(projectId);
  const bots = memberships.get().filter((entry) => entry.projectId === projectId && findPrincipal(entry.userId)?.kind === 'bot');
  return <div data-project-card={projectId} className="group flex flex-col gap-3 rounded-2xl bg-surface-2 p-4 shadow-[inset_0_0_0_1px_var(--border)] hover:shadow-[inset_0_0_0_1px_var(--foreground)]">
    <button type="button" aria-label={`Open ${project.name}`} onClick={onOpen} className="flex flex-col gap-1 text-left outline-none">
      <span className="flex items-center gap-2 text-subtitle font-semibold text-foreground">{project.name}<Pill tone="blue">{projectRoleOf(viewer.id, projectId)?.name}</Pill></span>
      <span className="flex items-center gap-1.5 font-mono text-caption text-muted-foreground"><GitBranch01 width={13} height={13} strokeWidth={1.75} />{health.origin.replace('github.com/', '')} · base {project.branch}</span>
    </button>
    <ul className="flex flex-col gap-1 text-caption">
      <li className="flex items-center gap-1.5">{health.behind ? <AlertCircle width={13} height={13} className="text-[#dc6803]" /> : <CheckCircle width={13} height={13} className="text-[#079455]" />}<span className="text-foreground">{health.behind ? `Behind origin by ${health.behind} commits` : 'In sync with origin'}</span></li>
      {health.reach.map((entry) => <li key={entry.repository} className="flex min-w-0 items-center gap-1.5 text-muted-foreground"><span className="truncate"><span className="font-mono">{entry.repository}</span> · {entry.via}</span></li>)}
      {health.failed.length ? <li className="flex items-start gap-1.5 text-[#d92d20]"><AlertCircle width={13} height={13} className="mt-0.5 shrink-0" /><span>{health.failed.length} failed {health.failed.length === 1 ? 'operation' : 'operations'}: {health.failed[0]?.what}</span></li> : <li className="text-muted-foreground">No failed operations</li>}
      {runs.map((run) => <li key={run.id} className="flex items-center gap-1.5 text-foreground"><Zap width={13} height={13} className="text-[#6B97FF]" />{run.automation} · running {run.when}</li>)}
    </ul>
    <div className="mt-auto flex items-center justify-between gap-2 border-t border-border pt-3">
      <span className="flex items-center gap-2 text-caption text-muted-foreground">
        <span className="flex -space-x-1">{members.slice(0, 5).map((id) => <Avatar key={id} userId={id} size={20} />)}</span>
        {members.length} members{bots.length ? ` · ${bots.length} bots` : ''} · {running.length} of {open.length} running
      </span>
      <Button variant="ghost" size="compact" leadingIcon={glyph(Settings01)} aria-label={`${project.name} settings`} onClick={onSettings}>Settings</Button>
    </div>
  </div>;
}

/** A project's overview: health, recent workspaces, automation runs and members, with Settings one click away. */
export function ProjectOverview({ projectId }: { projectId: string }) {
  const viewer = useViewer();
  const { navigate, open } = useMock();
  useRoles();
  const live = memberships.use();
  const project = PROJECTS.find((entry) => entry.id === projectId);
  const health = PROJECT_HEALTH[projectId];
  if (!project || !health || !visibleProjects(viewer.id).has(projectId)) return <LivePage title={projectName(projectId)} viewer={viewer} description={`${viewer.first} isn’t a member of ${projectName(projectId)}. Members see only the projects they’re added to.`}><span /></LivePage>;
  const workspaces = WORKSPACES.filter((workspace) => workspace.projectId === projectId && !workspace.archived);
  const runs = AUTOMATION_RUNS.filter((run) => run.projectId === projectId);
  const members = [...membersOf(projectId), ...live.filter((entry) => entry.projectId === projectId && findPrincipal(entry.userId)?.kind === 'bot').map((entry) => entry.userId)];
  return <LivePage title={project.name} viewer={viewer} description={`${health.origin} · base ${project.branch} · ${health.behind ? `behind origin by ${health.behind} commits` : 'in sync with origin'}`}
    actions={<><Button variant="ghost" leadingIcon={glyph(ArrowLeft)} onClick={() => navigate('projects')}>All projects</Button><Button variant="primary" leadingIcon={glyph(Settings01)} onClick={() => navigate('project-settings', { project: projectId, page: 'members' })}>Settings</Button></>}>
    <Section title="Health">
      <SettingRows label="Health">
        {health.reach.map((entry) => <SettingRow key={entry.repository} media={glyph(GitBranch01)} title={<span className="font-mono">{entry.repository}</span>} description={entry.via} />)}
        {health.failed.map((entry) => <SettingRow key={entry.what} media={glyph(AlertCircle)} title={<span className="text-[#d92d20]">{entry.what}</span>} description={entry.when} />)}
      </SettingRows>
    </Section>
    <Section title="Recent workspaces" description="Open one to work in it.">
      <SettingRows label="Recent workspaces">{workspaces.map((workspace) => <SettingRow key={workspace.id} title={<span className="inline-flex items-center gap-2">{workspace.name}<Pill>{PHASE_LABEL[workspace.phase]}</Pill></span>} description={workspace.preview}>
        <HoldersOrFree holders={workspace.holders} />
        <Button variant="ghost" aria-label={`Open ${workspace.name}`} onClick={() => open(workspace.id)}>Open</Button>
      </SettingRow>)}</SettingRows>
    </Section>
    <Section title="Automation runs" description="Running and recent runs. Failed ones also go to Needs you; definitions are in Settings → Automations.">
      {runs.length ? <SettingRows label="Automation runs">{runs.map((run) => <SettingRow key={run.id} media={glyph(Zap)} title={<span className="inline-flex items-center gap-2">{run.automation}<Pill tone={RUN_TONE[run.state]}>{run.state === 'running' ? 'Running' : run.state === 'failed' ? 'Failed' : 'Succeeded'}</Pill></span>} description={`${run.when} · ${run.detail}`}>
        {run.workspaceId ? <Button variant="ghost" onClick={() => open(run.workspaceId ?? '')}>Open workspace</Button> : null}
      </SettingRow>)}</SettingRows> : <Note>No automation runs.</Note>}
    </Section>
    <Section title="Members" description="Managed in Settings → Members.">
      <div className="flex flex-wrap gap-2">{members.map((id) => <span key={id} className="inline-flex items-center gap-1.5 rounded-full bg-surface-2 py-1 pl-1 pr-2.5 text-caption shadow-[inset_0_0_0_1px_var(--border)]"><Avatar userId={id} size={20} />{findPrincipal(id)?.name} · {projectRoleOf(id, projectId)?.name}</span>)}</div>
    </Section>
  </LivePage>;
}
