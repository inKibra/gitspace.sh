// Machines and Browsers, as monitoring dashboards. Machines: a stats strip (online, busy, offline, workspaces running,
// updates pending or failed, machine profiles ready), a note on how placement uses readiness, then a panel per machine
// with CPU, memory and disk gauges, its load over the last hour, what runs on it and for how long, the MCP servers it
// hosts (running, stopped or unavailable, with calls in the last hour), its readiness per machine profile with Run
// setup, Approve and Decline, its last heartbeat, release and update status, and recent
// events; offline ones are dimmed with "since". Browsers: a stats strip (sessions open, minutes today, takeovers
// waiting), a grid of live tab thumbnails with who drives each, for how long and how fast, with Watch, Take over and
// Stop, and the paired Chromes.
// Configuration is in Settings, linked. Owners and Admins see the whole team; a Member sees their own, plus the team's
// that run their projects' work.
import { glyph } from '../../glyph.js';
import { Button } from '@gitspace/ui';
import { Eye, Globe02, Hand, LayersThree01, Plus, StopCircle } from '@untitledui/icons';
import { useState } from 'react';
import { projectRoleIdOf, userOf, visibleProjects, WORKSPACES } from '../data.js';
import { machineProfiles, machineReadiness, projectProfiles } from '../flows/env-model.js';
import { MachineMcpBlock } from '../flows/machine-mcp.js';
import { machineMcpServers } from '../flows/machine-mcp-data.js';
import { needsApproval, placementText, ProfileReadiness } from '../flows/profiles.js';
import { AddComputerFlow } from '../flows/you-machines.js';
import { KIND_ICON, KIND_TONE } from '../scoped/machines.js';
import { BROWSERS, MACHINE_KIND_LABEL, MACHINES, projectName, revoked, type Machine } from '../settings/data.js';
import { Act, Note, Pill, Section, SettingRow, SettingRows, UserName, useHeld } from '../settings/parts.js';
import { useMock, useViewer } from '../viewer.js';
import { BROWSER_SESSIONS, CHROME_LIVE, MACHINE_LIVE, MACHINE_METRICS } from './data.js';
import { Dot, Events, Gauge, LivePage, Panel, PanelGrid, seesTeam, Sparkline, Stat, StatStrip } from './parts.js';
import { TabThumbnail } from './thumbs.js';

/** The workspaces a team machine runs (crumb-cell-1 is the default `cloud` machine). */
function teamRuns(machine: Machine, seen: ReadonlySet<string>): readonly string[] {
  return WORKSPACES.filter((workspace) => !workspace.archived && seen.has(workspace.projectId) && (workspace.machine === machine.id || (machine.id === 'crumb-cloud-1' && workspace.machine === 'cloud'))).map((workspace) => workspace.id);
}

export function LiveMachinesPage({ adding }: { adding: boolean }) {
  const viewer = useViewer();
  const { navigate } = useMock();
  const held = useHeld();
  const gone = revoked.use();
  const profiles = machineProfiles.use();
  const readiness = machineReadiness.use();
  const projectNeeds = projectProfiles.use();
  const [add, setAdd] = useState(adding);
  const team = seesTeam(viewer);
  const seen = visibleProjects(viewer.id);
  const runs = (machine: Machine): readonly string[] => machine.owner.scope === 'account' ? teamRuns(machine, seen) : held(machine.owner.userId).filter((id) => seen.has(WORKSPACES.find((workspace) => workspace.id === id)?.projectId ?? ''));
  // A project's Leads see the team machines that host an MCP server turned on in that project, even with no work there.
  const leads = machineMcpServers.use().filter((server) => server.scope.kind === 'team' && server.projects.some((projectId) => projectRoleIdOf(viewer.id, projectId) === 'lead')).map((server) => server.machineId);
  const list = MACHINES.filter((machine) => !gone.has(machine.id) && (team || (machine.owner.scope === 'user' ? machine.owner.userId === viewer.id : runs(machine).length > 0 || leads.includes(machine.id))));
  const online = list.filter((machine) => MACHINE_LIVE[machine.id]?.connected);
  const busy = online.filter((machine) => (MACHINE_METRICS[machine.id]?.cpu ?? 0) >= 50);
  const running = new Set(online.flatMap((machine) => runs(machine)));
  const failed = list.filter((machine) => MACHINE_LIVE[machine.id]?.updateFailed);
  const pending = list.filter((machine) => MACHINE_LIVE[machine.id]?.update);
  const pairs = list.flatMap((machine) => profiles.flatMap((profile) => {
    const entry = readiness[machine.id]?.[profile.id];
    return entry ? [{ state: needsApproval(machine, profile, entry) ? 'needs-approval' : entry.state }] : [];
  }));
  const count = (state: string): number => pairs.filter((pair) => pair.state === state).length;
  const waiting = count('needs-approval');
  const exampleProject = seen.has('crumb') ? 'crumb' : [...seen][0];
  const exampleProfile = profiles.find((profile) => profile.id === (projectNeeds[exampleProject ?? '']?.at(-1) ?? ''));
  const example = exampleProject && exampleProfile ? { projectId: exampleProject, profileId: exampleProfile.id, name: exampleProfile.name } : null;
  return <LivePage title="Machines" viewer={viewer} description="What each machine is doing now and over the last hour: load, what runs on it, its release, and what happened lately."
    configure={{ label: 'Machines settings', onClick: () => navigate('settings', { page: team ? 'machines' : 'my-machines' }) }}
    actions={<Button variant="primary" leadingIcon={glyph(Plus)} onClick={() => setAdd(true)}>Add a computer</Button>}>
    <StatStrip>
      <Stat label="Online" value={`${online.length} of ${list.length}`} tone="good" />
      <Stat label="Busy" value={String(busy.length)} detail="over 50% CPU" tone={busy.length ? 'warn' : undefined} />
      <Stat label="Offline" value={String(list.length - online.length)} detail={list.filter((machine) => !MACHINE_LIVE[machine.id]?.connected).map((machine) => machine.label).join(', ')} tone={list.length - online.length ? 'muted' : undefined} />
      <Stat label="Workspaces running" value={String(running.size)} />
      <Stat label="Updates pending" value={String(pending.length)} detail={pending.map((machine) => machine.label).join(', ') || 'All on rc.62 or updating'} />
      <Stat label="Updates failed" value={String(failed.length)} detail={failed.map((machine) => machine.label).join(', ')} tone={failed.length ? 'bad' : undefined} />
      <Stat label="Profiles ready" value={`${count('ready')} of ${pairs.length}`} detail={[waiting ? `${waiting} waiting for approval` : '', count('missing') ? `${count('missing')} missing something` : '', count('declined') ? `${count('declined')} declined` : ''].filter(Boolean).join(' · ') || 'Every machine is ready for its profiles'} tone={waiting || count('missing') ? 'warn' : 'good'} />
    </StatStrip>
    <div data-placement-note="" className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <Note>Placement prefers a machine that’s ready for the machine profiles a workspace needs, then one whose approved setup would install what it misses once someone presses Run setup; it never picks a machine where the profile is declined or waiting for approval. A new workspace waits for its first message: nothing runs setup on its own.{example ? ` A workspace in ${projectName(example.projectId)} needing ${example.name} goes to ${placementText(example.projectId, example.profileId)}.` : ''}</Note>
      <Button variant="ghost" size="compact" leadingIcon={glyph(LayersThree01)} onClick={() => navigate('settings', { page: 'machine-profiles' })}>Machine profiles</Button>
    </div>
    <Section title="Team machines" description={team ? 'Every team machine.' : 'The team’s machines that run your projects’ work.'}>
      {list.some((machine) => machine.owner.scope === 'account') ? <PanelGrid>{list.filter((machine) => machine.owner.scope === 'account').map((machine) => <MachinePanel key={machine.id} machine={machine} runs={runs(machine)} />)}</PanelGrid> : <Note>None runs your projects’ work now.</Note>}
    </Section>
    <Section title={team ? 'People’s machines' : 'Your machines'} description={team ? 'Personal machines; each joins a workspace while its owner holds the handle, with its owner’s own SSH key and GitHub setup.' : 'They join a workspace while you hold its handle.'}>
      {list.some((machine) => machine.owner.scope === 'user') ? <PanelGrid>{list.filter((machine) => machine.owner.scope === 'user').map((machine) => <MachinePanel key={machine.id} machine={machine} runs={runs(machine)} />)}</PanelGrid> : <Note>None.</Note>}
    </Section>
    {add ? <AddComputerFlow initialScope="mine" onClose={() => setAdd(false)} /> : null}
  </LivePage>;
}

function MachinePanel({ machine, runs }: { machine: Machine; runs: readonly string[] }) {
  const viewer = useViewer();
  const { say } = useMock();
  const [stopped, setStopped] = useState<ReadonlySet<string>>(new Set());
  const live = MACHINE_LIVE[machine.id];
  const metrics = MACHINE_METRICS[machine.id];
  const owner = machine.owner.scope === 'user' ? machine.owner.userId : null;
  const connected = live?.connected ?? false;
  const manage = owner ? (owner === viewer.id ? null : `Only ${userOf(owner).first} manages their machine`) : seesTeam(viewer) ? null : 'Owners and Admins manage team machines';
  const Icon = KIND_ICON[machine.kind];
  return <Panel id={machine.id} dim={!connected} head={<>
    <Icon size={16} strokeWidth={1.5} />
    <span title={machine.label} data-live-machine={machine.id} className="min-w-0 max-w-full truncate text-body font-semibold text-foreground">{machine.label}</span>
    <Pill tone={KIND_TONE[machine.kind]}>{MACHINE_KIND_LABEL[machine.kind]}</Pill>
    {owner ? <Pill tone="violet">{owner === viewer.id ? 'Yours' : `${userOf(owner).first}’s`}</Pill> : <Pill>Team</Pill>}
    <span className="ml-auto inline-flex items-center gap-1.5 text-caption text-muted-foreground"><Dot tone={connected ? 'good' : 'muted'} pulse={connected} />{connected ? `Online · heartbeat ${live?.heartbeat}` : `Offline since ${metrics?.offlineSince ?? live?.heartbeat}`}</span>
  </>}>
    {metrics ? <div className="grid grid-cols-3 gap-3">
      <Gauge label="CPU" used={metrics.cpu} />
      <Gauge label="Memory" used={metrics.mem} detail={metrics.memDetail} />
      <Gauge label="Disk" used={metrics.disk} detail={metrics.diskDetail} />
    </div> : null}
    {metrics ? <div className="flex min-w-0 items-end justify-between gap-3">
      <span className="flex flex-col text-caption"><span className="text-muted-foreground">Load, last hour</span><span className="tabular-nums text-foreground">{connected ? `${metrics.load.at(-1) ?? 0}% now` : 'no data since offline'}</span></span>
      <Sparkline values={metrics.load} max={100} tone={metrics.cpu >= 80 ? 'warn' : connected ? 'good' : 'muted'} width={160} label={`${machine.label} load over the last hour`} />
    </div> : null}
    <div className="flex flex-col gap-1">
      <span className="text-caption font-medium text-foreground">{runs.length ? `${owner ? 'Joined while held' : 'Runs'}: ${runs.length} ${runs.length === 1 ? 'workspace' : 'workspaces'}` : owner ? 'In no workspace: its owner holds no handle' : 'No workspace on it now'}</span>
      {(metrics?.processes ?? []).filter((process) => !stopped.has(process.workspaceId + process.process)).map((process) => <span key={process.workspaceId + process.process} className="flex min-w-0 flex-wrap items-center gap-x-2 text-caption">
        <span className="font-mono text-foreground">{process.process}</span><span className="text-muted-foreground">{process.workspaceId} · {process.ran}</span>
        {process.process.includes('detached') ? <Act reason={owner === viewer.id ? null : `Only ${owner ? userOf(owner).first : 'its owner'} stops processes on their machine`} size="compact" variant="ghost" onClick={() => { setStopped((set) => new Set([...set, process.workspaceId + process.process])); say(`Stopped ${process.process} on ${machine.label}`); }}>Stop</Act> : null}
      </span>)}
    </div>
    <MachineMcpBlock machineId={machine.id} />
    <ProfileReadiness machine={machine} />
    <span className={`text-caption ${live?.updateFailed ? 'text-[#d92d20]' : 'text-muted-foreground'}`} data-update-failed={live?.updateFailed ? machine.id : undefined}>
      On {live?.release}{live?.updateFailed ? ` · update failed: ${live.updateFailed}` : live?.update ? ` · update: ${live.update}` : ' · up to date'}
    </span>
    {metrics?.events.length ? <Events items={metrics.events.slice(0, 3)} /> : null}
    {live?.updateFailed || !connected ? <div className="flex flex-wrap justify-end gap-2">
      {live?.updateFailed ? <Act reason={manage} variant="secondary" size="compact" onClick={() => say(`Retries the update on ${machine.label}`)}>Retry update</Act> : null}
      {!connected && machine.kind !== 'computer' ? <Act reason={manage} variant="ghost" size="compact" onClick={() => say(`Starts ${machine.label}`)}>Start</Act> : null}
    </div> : null}
  </Panel>;
}

export function LiveBrowsersPage() {
  const viewer = useViewer();
  const { navigate, say } = useMock();
  const gone = revoked.use();
  const held = useHeld();
  const [stopped, setStopped] = useState<ReadonlySet<string>>(new Set());
  const team = seesTeam(viewer);
  const seen = visibleProjects(viewer.id);
  const projectOf = (workspaceId: string): string => WORKSPACES.find((workspace) => workspace.id === workspaceId)?.projectId ?? '';
  const sessions = BROWSER_SESSIONS.filter((session) => !stopped.has(session.id) && seen.has(projectOf(session.workspaceId)));
  const chromes = BROWSERS.filter((browser) => !browser.builtIn && !gone.has(browser.id) && (team || (browser.owner.scope === 'user' ? browser.owner.userId === viewer.id : browser.projects.some((id) => seen.has(id)))));
  const waiting = sessions.filter((session) => session.waiting);
  const driver = (value: string, workspaceId: string) => value === 'agent' ? <span>the agent in {workspaceId}</span> : value === 'detached' ? <span>no one: detached when its owner let go of {workspaceId}</span> : <span className="inline-flex items-center gap-1"><UserName userId={value} /> in {workspaceId}</span>;
  return <LivePage title="Browsers" viewer={viewer} description="Every browser tab agents and people drive right now, as it looks now: who drives it, for how long, how fast. Watch it, take it over, or stop it."
    configure={{ label: 'Browsers settings', onClick: () => navigate('settings', { page: team ? 'plugins' : 'my-plugins' }) }}>
    <StatStrip>
      <Stat label="Sessions open" value={String(sessions.length)} detail={`${sessions.filter((session) => session.browser === 'cloud').length} cloud · ${sessions.filter((session) => session.browser !== 'cloud').length} paired Chrome`} />
      <Stat label="Minutes today" value={String(sessions.reduce((sum, session) => sum + session.minutes, 0) + 184)} detail="all sessions, closed ones included" />
      <Stat label="Takeovers waiting" value={String(waiting.length)} detail={waiting.map((session) => session.workspaceId).join(', ') || 'None'} tone={waiting.length ? 'warn' : undefined} />
      <Stat label="Actions a minute" value={String(sessions.reduce((sum, session) => sum + session.apm, 0))} detail="clicks, typing and navigations, all agents" />
      <Stat label="Chromes connected" value={`${chromes.filter((browser) => browser.online).length} of ${chromes.length}`} tone="good" />
    </StatStrip>
    <Section title="Open sessions" description="Each tab as it looks now. Watch follows it live; Take over hands you the mouse and keyboard while the agent waits. The workspace’s holders, its project’s Leads, Owners and Admins take over or stop a tab.">
      {sessions.length ? <PanelGrid min="15rem">{sessions.map((session) => {
        const holds = held(viewer.id).includes(session.workspaceId);
        const lead = !holds && !team && projectRoleIdOf(viewer.id, projectOf(session.workspaceId)) === 'lead';
        const reason = holds || team || lead ? null : `Only ${session.workspaceId}’s holders, ${projectName(projectOf(session.workspaceId))}’s Leads, Owners and Admins take over or stop its browser`;
        const where = session.browser === 'cloud' ? 'Cloud browser' : BROWSERS.find((browser) => browser.id === session.browser)?.label ?? session.browser;
        return <Panel key={session.id} id={session.id} head={<>
          <span data-browser-session={session.id} className="min-w-0 flex-1 truncate text-body font-medium text-foreground" title={session.site}>{session.site}</span>
          {session.waiting ? <Pill tone="amber">Waiting for a person</Pill> : session.driver === 'detached' ? <Pill>Detached</Pill> : <Pill tone="green">Live</Pill>}
        </>}>
          <TabThumbnail thumb={session.thumb} url={session.url} live={session.driver !== 'detached'} />
          {session.waiting ? <span className="text-caption text-[#b54708]">{session.waiting}</span> : null}
          <span className="flex flex-col gap-0.5 text-caption text-muted-foreground">
            <span className="inline-flex flex-wrap items-center gap-1">Driven by {driver(session.driver, session.workspaceId)}</span>
            <span>{where} · {session.tabs} {session.tabs === 1 ? 'tab' : 'tabs'} · open {session.since} · {session.apm} actions/min · {projectName(projectOf(session.workspaceId))}</span>
          </span>
          {lead ? <span className="text-caption text-foreground">You can take over as Lead in {projectName(projectOf(session.workspaceId))}; it’s audited as Lead and its holders are told.</span> : null}
          <div className="flex flex-wrap justify-end gap-1.5">
            <Button variant="ghost" size="compact" leadingIcon={glyph(Eye)} onClick={() => say(`Watching ${session.url} live`)}>Watch</Button>
            <Act reason={reason} variant={session.waiting ? 'primary' : 'secondary'} size="compact" leadingIcon={glyph(Hand)} onClick={() => say(`You drive ${session.url}${lead ? ' as Lead' : ''}; the agent in ${session.workspaceId} waits until you hand it back`)}>Take over</Act>
            <Act reason={reason} variant="ghost" size="compact" leadingIcon={glyph(StopCircle)} onClick={() => { setStopped((set) => new Set([...set, session.id])); say(`Closed ${session.tabs === 1 ? 'the tab' : 'the tabs'} in ${session.workspaceId}`); }}>Stop</Act>
          </div>
        </Panel>;
      })}</PanelGrid> : <Note>No sessions open.</Note>}
    </Section>
    <Section title="Paired Chromes" description={team ? 'Every Chrome paired to the team or to someone.' : 'Yours, and the team’s that serve your projects.'}>
      <SettingRows label="Paired Chromes">{chromes.map((browser) => {
        const live = CHROME_LIVE[browser.id];
        return <SettingRow key={browser.id} media={glyph(Globe02)}
          title={<span data-live-browser={browser.id} className="inline-flex flex-wrap items-center gap-2">{browser.label}{browser.owner.scope === 'user' ? <Pill tone="violet">{browser.owner.userId === viewer.id ? 'Yours' : `${userOf(browser.owner.userId).first}’s`}</Pill> : <Pill>Team</Pill>}<Pill tone={browser.online ? 'green' : 'gray'}>{browser.online ? 'Connected' : 'Offline'}</Pill></span>}
          description={`${live?.tabs ?? 0} ${live?.tabs === 1 ? 'tab' : 'tabs'} in use by agents · last activity ${live?.last ?? browser.lastUsed}`} />;
      })}</SettingRows>
    </Section>
  </LivePage>;
}
