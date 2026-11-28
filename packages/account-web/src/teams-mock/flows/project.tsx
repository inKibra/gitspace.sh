// A project's settings flows, drawn with the shared kit: members (add, change a project role, remove), automations
// (new, enable, pause), secrets (add, with its rule), the inference profile and plugins (change,
// with what it changes). The environment's flows are in env-page.tsx. A refused viewer gets the dialog with the reason
// and who can. Every flow ends in a success state that has already changed the mock's stores and, for a Lead's change,
// the audit log.
import { PHASE_LABEL, PHASES } from '../../GitSpaceShell.js';
import { Button, InputCopy, InputField, InputGroup, Select, SelectContent, SelectItem, SelectTrigger, Switch, Tooltip } from '@gitspace/ui';
import { AlertCircle, Clock, Cloud01, Dataflow03, Key01, Lock01, Monitor01, Server01, Zap } from '@untitledui/icons';
import { useState, type ComponentProps, type ReactNode } from 'react';
import { actorLabel, bots, findPrincipal, memberships, PROJECTS, setMembership, USERS, WORKSPACES, type Phase, type Principal } from '../data.js';
import { AUTOMATIONS, MACHINES, MODEL_CREDENTIALS, PLUGINS, PROFILES, projectName, projectSettings, recordAudit, SECRET_KIND_LABEL, TEAM_SSH_KEY, appCovers, type Machine, type ProjectSettings } from '../settings/data.js';
import { useHeld } from '../settings/parts.js';
import { PROJECT_PERMISSIONS, projectRoleById, projectRoleOf, roleName, useRoles, why, whyMembers, type ProjectAction } from '../settings/roles.js';
import { createStore } from '../store.js';
import { useMock, useViewer } from '../viewer.js';
import { ChipPicker, ChoiceCards, FlowDialog, FlowError, FlowSuccess, Hint, StepButtons, Summary, TextArea, ShownOnce, type FlowIcon } from './kit.js';
import { STRIPE_SECRET_LIVE } from './token-shapes.js';
import { secretRules } from './env-model.js';
import { ruleLine, useRuleStep } from './secret-rules.js';
import { ENV_NAME, secrets } from './team-data.js';

// ── Mock state these flows change ──

export interface AutomationDef { name: string; trigger: string; state: 'on' | 'paused' | 'proposed'; by: string; enabledBy?: string; detail?: string }
/** Each project's automations, starting from the mock's; New automation adds, Enable and Pause change the state. */
export const automations = createStore<Readonly<Record<string, readonly AutomationDef[]>>>(AUTOMATIONS);

export function changeProject(project: string, next: Partial<ProjectSettings>): void {
  const current = projectSettings.get()[project];
  if (current) projectSettings.set({ ...projectSettings.get(), [project]: { ...current, ...next } });
}

// ── Shared pieces ──

/** People who may do `action` in `project` (by first name): its members and the Owners whose role allows it. */
export function whoCan(project: string, action: ProjectAction | 'members'): string {
  const names = USERS.filter((user) => (action === 'members' ? whyMembers(user.id, project) : why(user.id, project, action)) === null).map((user) => user.first);
  return names.length ? names.join(', ') : 'nobody yet';
}

/** People (not bots) who are Lead in `project`, Owners first. */
export function leadsOf(project: string): readonly string[] {
  return USERS.filter((user) => projectRoleOf(user.id, project)?.id === 'lead').map((user) => user.id);
}

/** A section's main action: with a reason it stays visible but dimmed and says why on hover; pressing it opens the
 * flow, which shows the refusal and who can. */
export function Gate({ reason, onOpen, children, ...props }: Omit<ComponentProps<typeof Button>, 'onClick'> & { reason: string | null; onOpen(): void }) {
  const button = <Button {...props} data-refused={reason ? '' : undefined} className={`${props.className ?? ''} ${reason ? 'opacity-50' : ''}`} onClick={onOpen}>{children}</Button>;
  return reason ? <Tooltip content={reason}>{button}</Tooltip> : button;
}

/** The refusal as a dialog: the role that refuses, and who can do it instead. */
export function RefusedDialog({ id, title, reason, who, onClose }: { id: string; title: ReactNode; reason: string; who: string; onClose(): void }) {
  return <FlowDialog id={id} title={title} wide={false} onClose={onClose} footer={<Button variant="secondary" onClick={onClose}>Close</Button>}>
    <div role="alert" data-flow-refused="" className="flex items-start gap-3 rounded-xl bg-[color-mix(in_oklab,var(--destructive)_7%,transparent)] px-3 py-3 shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--destructive)_30%,transparent)]">
      <AlertCircle width={20} height={20} strokeWidth={1.75} className="mt-0.5 shrink-0 text-destructive" />
      <span className="flex min-w-0 flex-col gap-1 text-body text-foreground"><span className="font-medium">{reason}.</span><span className="text-caption text-muted-foreground">Who can: {who}. Ask one of them, or a Lead can change your project role.</span></span>
    </div>
  </FlowDialog>;
}

/** A diff: added lines green, removed lines red. */
export function DiffBlock({ lines, label }: { lines: readonly string[]; label?: string }) {
  return <pre aria-label={label ?? 'Diff'} data-diff="" className="overflow-x-auto rounded-lg bg-surface-2 px-2.5 py-2 font-mono text-[11.5px] leading-5">
    {lines.length ? lines.map((line, index) => <div key={`${index}:${line}`} className={line.startsWith('+') ? 'text-[#067647]' : line.startsWith('-') ? 'text-destructive' : 'text-muted-foreground'}>{line}</div>) : <div className="text-muted-foreground">No differences.</div>}
  </pre>;
}

/** Checkbox cards: one row per person, bot or repository; a disabled one says why. */
export function PickRows({ label, rows, picked, onChange }: { label: string; rows: ReadonlyArray<{ id: string; title: ReactNode; detail: ReactNode; disabled: string | null }>; picked: ReadonlySet<string>; onChange(next: ReadonlySet<string>): void }) {
  return <ul role="group" aria-label={label} className="flex max-h-80 flex-col gap-1.5 overflow-y-auto">{rows.map((row) => {
    const on = picked.has(row.id);
    return <li key={row.id}><button type="button" role="checkbox" aria-checked={on} data-pick={row.id} disabled={row.disabled !== null}
      onClick={() => { const next = new Set(picked); if (on) next.delete(row.id); else next.add(row.id); onChange(next); }}
      className={`flex w-full min-w-0 items-start gap-2.5 rounded-xl p-2.5 text-left disabled:cursor-not-allowed disabled:opacity-60 ${on ? 'bg-[color-mix(in_oklab,#6B97FF_10%,transparent)] shadow-[inset_0_0_0_1.5px_#6B97FF]' : 'shadow-[inset_0_0_0_1px_var(--border)] hover:bg-hover'}`}>
      <span aria-hidden className={`mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-[5px] text-[10px] ${on ? 'bg-[#6B97FF] text-white' : 'shadow-[inset_0_0_0_1.5px_var(--border)]'}`}>{on ? '✓' : ''}</span>
      <span className="flex min-w-0 flex-col gap-0.5"><span className="text-body text-foreground">{row.title}</span><span className="text-caption text-muted-foreground">{row.disabled ?? row.detail}</span></span>
    </button></li>;
  })}</ul>;
}

export function Labelled({ label, children }: { label: string; children: ReactNode }) {
  return <div className="flex flex-col gap-1.5"><span className="text-caption font-medium text-foreground">{label}</span>{children}</div>;
}

function Picker({ label, value, options, onChange }: { label: string; value: string; options: ReadonlyArray<{ id: string; label: string }>; onChange(value: string): void }) {
  return <Labelled label={label}><Select value={value} onValueChange={onChange}><SelectTrigger aria-label={label} /><SelectContent>{options.map((option, index) => <SelectItem key={option.id} value={option.id} index={index}>{option.label}</SelectItem>)}</SelectContent></Select></Labelled>;
}

function principalName(principal: Principal): string { return principal.kind === 'bot' ? actorLabel(principal.id) : principal.name; }
export function listNames(names: readonly string[]): string { return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`; }

/** The machines a project's runs may use: team machines (Ledger's own only in Ledger) and, when `personal`, the
 * viewer's own; an offline one says so. */
export function machineChoices(project: string, viewerId: string, personal: boolean) {
  const usable = MACHINES.filter((machine) => (machine.owner.scope === 'account' ? machine.id !== 'ledger-cloud-2' || project === 'ledger' : personal && machine.owner.userId === viewerId));
  const icon = (machine: Machine): FlowIcon => (machine.kind === 'container' ? Cloud01 : machine.kind === 'vm' ? Server01 : Monitor01);
  return usable.map((machine) => ({
    id: machine.id, title: machine.label, icon: icon(machine),
    badge: <span className="rounded-full bg-muted px-1.5 text-[11px] text-muted-foreground">{machine.owner.scope === 'account' ? 'Team' : 'Yours'}</span>,
    detail: `${machine.notes || 'No notes'}${machine.state === 'sleeping' ? ' · sleeping: starting it wakes it (about 30 s)' : ''}`,
    disabled: machine.state === 'offline' ? `${machine.label} is offline: start it, or pick another` : null,
  }));
}
export function machineOf(id: string): Machine | undefined { return MACHINES.find((machine) => machine.id === id); }

// ── Members ──

export function AddMemberWizard({ project, onClose }: { project: string; onClose(): void }) {
  const viewer = useViewer();
  const { say } = useMock();
  const roles = useRoles();
  const live = memberships.use();
  const [step, setStep] = useState(0);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [roleId, setRoleId] = useState('contributor');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<readonly string[] | null>(null);
  const name = projectName(project);
  const refused = whyMembers(viewer.id, project);
  if (refused) return <RefusedDialog id="add-member" title={`Add to ${name}`} reason={refused} who={`${name}’s Leads (${listNames(leadsOf(project).map((id) => findPrincipal(id)?.first ?? id))}), and Admins who are members`} onClose={onClose} />;
  const viewerRole = projectRoleOf(viewer.id, project);
  const canLead = viewer.accountRole === 'owner' || viewer.accountRole === 'admin' || viewerRole?.id === 'lead';
  const reasonFor = (principal: Principal): string | null => {
    if (principal.accountRole === 'owner') return `${principal.first} is an Owner: Lead in every project already`;
    const membership = live.find((entry) => entry.userId === principal.id && entry.projectId === project);
    if (membership) return `Already ${roleName(membership.roleId)} in ${name}`;
    if (principal.id === viewer.id) return 'You: use Join project instead; joining is recorded in the audit log';
    if (principal.kind === 'bot' && !principal.sponsor) return 'Sign-ins blocked (no sponsor): an Admin or Owner takes it over in Bots first';
    return null;
  };
  const everyone: readonly Principal[] = [...USERS, ...bots.get()];
  const rows = everyone.map((principal) => ({ id: principal.id, title: <span className="inline-flex flex-wrap items-center gap-2">{principalName(principal)}{principal.id === viewer.id ? ' (you)' : ''}<span className="text-caption text-muted-foreground">{principal.kind === 'bot' ? 'Bot' : principal.accountRole === 'admin' ? 'Admin' : principal.accountRole === 'owner' ? 'Owner' : 'Member'}</span></span>,
    detail: principal.kind === 'bot' ? principal.description : principal.email, disabled: reasonFor(principal) }));
  const chosen = everyone.filter((principal) => picked.has(principal.id));
  const leadReason = !canLead ? `Only a Lead, an Owner or an Admin makes someone Lead; your project role here is ${viewerRole?.name ?? 'none'}`
    : chosen.some((principal) => principal.kind === 'bot') ? 'A bot can’t be Lead: Lead manages members and approves, which is a person’s call' : null;
  const role = projectRoleById(roleId);
  const next = (): void => {
    setError(null);
    if (step === 0) { if (!picked.size) { setError('Pick at least one person or bot to add.'); return; } if (roleId === 'lead' && leadReason) setRoleId('contributor'); setStep(1); return; }
    if (step === 1) { if (roleId === 'lead' && leadReason) { setError(leadReason); return; } setStep(2); return; }
    for (const principal of chosen) {
      setMembership(principal.id, project, roleId);
      recordAudit({ actor: viewer.id, kind: 'team', project, text: `Added ${actorLabel(principal.id)} to ${name} as ${roleName(roleId)}` });
    }
    const names = chosen.map((principal) => principal.first);
    setDone(names);
    say(`${listNames(names)} ${names.length === 1 ? 'is' : 'are'} now ${roleName(roleId)} in ${name}`);
  };
  return <FlowDialog id="add-member" title={`Add to ${name}`} description={`People in Crumb & Co and the team’s bots. They see ${name} with the project role you pick; someone outside the team is invited from Team › People first.`}
    steps={['People', 'Project role', 'Review']} step={step} done={done !== null} onClose={onClose}
    footer={done ? <Button variant="primary" onClick={onClose}>Done</Button> : <StepButtons step={step} onBack={() => { setError(null); setStep(step - 1); }} onCancel={onClose} next={next} nextLabel={step === 2 ? `Add ${picked.size === 1 ? chosen[0]?.first ?? '' : `${picked.size} members`}` : 'Next'} />}>
    {done ? <FlowSuccess title={`${listNames(done)} ${done.length === 1 ? 'is' : 'are'} now ${roleName(roleId)} in ${name}`}>They see {name}’s workspaces, conversations and members from their next page load. The audit log records that {viewer.first} added them.</FlowSuccess>
      : step === 0 ? <PickRows label="People and bots" rows={rows} picked={picked} onChange={(value) => { setPicked(value); setError(null); }} />
        : step === 1 ? <><ChoiceCards label="Project role" value={roleId} onChange={setRoleId}
          choices={roles.map((entry) => ({ id: entry.id, title: entry.name, detail: entry.description, badge: entry.fixed ? <span className="text-caption text-muted-foreground">Fixed</span> : undefined, disabled: entry.id === 'lead' ? leadReason : null }))} />
          <Hint>Project roles are the team’s (Team › People › Roles); Lead is fixed, with every permission including Manage members.</Hint></>
          : <Summary rows={[['Adding', listNames(chosen.map(principalName))], ['Project', name], ['Project role', role?.name ?? roleId], ['They can', role?.description ?? ''], ['Audit log', `${viewer.first} added ${listNames(chosen.map((principal) => principal.first))} to ${name} as ${role?.name ?? roleId}`]]} />}
    {error ? <FlowError>{error}</FlowError> : null}
  </FlowDialog>;
}

/** The permissions `to` gains and loses compared with `from`, as the role editor phrases them. */
function roleDelta(from: string, to: string): { gains: readonly string[]; loses: readonly string[] } {
  const a = projectRoleById(from)?.allowed ?? new Set<ProjectAction>();
  const b = projectRoleById(to)?.allowed ?? new Set<ProjectAction>();
  const rows = PROJECT_PERMISSIONS.flatMap((group) => group.rows);
  return { gains: rows.filter((row) => b.has(row.action) && !a.has(row.action)).map((row) => row.phrase), loses: rows.filter((row) => a.has(row.action) && !b.has(row.action)).map((row) => row.phrase) };
}

export function ChangeRoleDialog({ project, userId, to, onClose }: { project: string; userId: string; to: string; onClose(): void }) {
  const viewer = useViewer();
  const { say } = useMock();
  useRoles();
  const [done, setDone] = useState(false);
  const principal = findPrincipal(userId);
  const name = projectName(project);
  const from = memberships.get().find((entry) => entry.userId === userId && entry.projectId === project)?.roleId ?? '';
  const viewerRole = projectRoleOf(viewer.id, project);
  const canLead = viewer.accountRole === 'owner' || viewer.accountRole === 'admin' || viewerRole?.id === 'lead';
  const refused = to === 'lead' && !canLead ? `Only a Lead, an Owner or an Admin makes someone Lead; your project role here is ${viewerRole?.name ?? 'none'}`
    : to === 'lead' && principal?.kind === 'bot' ? 'A bot can’t be Lead: Lead manages members and approves, which is a person’s call' : null;
  const delta = roleDelta(from, to);
  const who = principal ? principalName(principal) : userId;
  const confirm = (): void => {
    setMembership(userId, project, to);
    recordAudit({ actor: viewer.id, kind: 'team', project, text: `Changed ${actorLabel(userId)}’s project role in ${name}: ${roleName(from)} → ${roleName(to)}` });
    say(`${actorLabel(userId)} is now ${roleName(to)} in ${name}`);
    setDone(true);
  };
  return <FlowDialog id="change-role" title={`Make ${principal?.first ?? userId} ${roleName(to)} in ${name}?`} done={done} wide={false} onClose={onClose}
    footer={done ? <Button variant="primary" onClick={onClose}>Done</Button> : <><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={refused !== null} onClick={confirm}>Change role</Button></>}>
    {done ? <FlowSuccess title={`${who} is now ${roleName(to)} in ${name}`}>It applies to their next action; handles they hold stay theirs. The audit log records the change under {viewer.first}.</FlowSuccess> : <>
      <Summary rows={[['Who', who], ['Project role', `${roleName(from)} → ${roleName(to)}`], ['Gains', delta.gains.length ? delta.gains.join(', ') : 'Nothing'], ['Loses', delta.loses.length ? delta.loses.join(', ') : 'Nothing']]} />
      {refused ? <FlowError>{refused}.</FlowError> : <Hint>If they lose a phase move, workspaces they hold stay where they are; their next move in that phase is proposed instead.</Hint>}
    </>}
  </FlowDialog>;
}

export function RemoveMemberDialog({ project, userId, onClose }: { project: string; userId: string; onClose(): void }) {
  const viewer = useViewer();
  const { say } = useMock();
  const held = useHeld();
  const [done, setDone] = useState(false);
  const principal = findPrincipal(userId);
  const name = projectName(project);
  const holding = held(userId).filter((id) => WORKSPACES.some((workspace) => workspace.id === id && workspace.projectId === project));
  const who = principal ? principalName(principal) : userId;
  const confirm = (): void => {
    setMembership(userId, project, null);
    recordAudit({ actor: viewer.id, kind: 'team', project, text: `Removed ${actorLabel(userId)} from ${name}` });
    say(`Removed ${actorLabel(userId)} from ${name} · their handles there are released`);
    setDone(true);
  };
  return <FlowDialog id="remove-member" title={`Remove ${principal?.first ?? userId} from ${name}?`} done={done} wide={false} onClose={onClose}
    footer={done ? <Button variant="primary" onClick={onClose}>Done</Button> : <><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={confirm}>Remove from {name}</Button></>}>
    {done ? <FlowSuccess title={`${who} is no longer in ${name}`}>{holding.length ? `${holding.join(', ')} ${holding.length === 1 ? 'is' : 'are'} free now. ` : ''}They stay in Crumb & Co; add them again any time. The audit log records it under {viewer.first}.</FlowSuccess> : <>
      <Summary rows={[['Who', who], ['Project role', roleName(memberships.get().find((entry) => entry.userId === userId && entry.projectId === project)?.roleId ?? '')],
        ['Handles', holding.length ? `Releases ${holding.join(', ')}` : `Holds no workspace in ${name}`],
        [principal?.kind === 'bot' ? 'Sign-ins' : 'Their resources', principal?.kind === 'bot' ? `Its MCP sign-ins lose ${name} from their slice` : `Their providers, plugins and browsers detach from ${name}’s workspaces`]]} />
      <Hint>{name} disappears from their sidebar and board. Work they did stays, under their name.</Hint>
    </>}
  </FlowDialog>;
}

// ── Inference and plugins ──

export function ProfileChangeDialog({ project, to, onClose }: { project: string; to: string; onClose(): void }) {
  const viewer = useViewer();
  const { say } = useMock();
  const settings = projectSettings.use();
  const [done, setDone] = useState(false);
  const name = projectName(project);
  const fromProfile = PROFILES.find((entry) => entry.id === settings[project]?.profile);
  const toProfile = PROFILES.find((entry) => entry.id === to);
  const providers = (ids: readonly string[] | undefined) => (ids ?? []).map((id) => MODEL_CREDENTIALS.find((entry) => entry.id === id)?.label ?? id).join(', ');
  const model = (id: string | undefined, role: string) => PROFILES.find((entry) => entry.id === id)?.models.find((entry) => entry.role === role)?.model ?? '—';
  const confirm = (): void => {
    changeProject(project, { profile: to });
    recordAudit({ actor: viewer.id, kind: 'setting', project, text: `Set ${name}’s inference profile to ${toProfile?.name}` });
    say(`${name} now uses ${toProfile?.name}`);
    setDone(true);
  };
  return <FlowDialog id="inference-profile" title={`Use ${toProfile?.name ?? to} in ${name}?`} description="The profile decides the models, the services, which team providers pay and which holders’ own providers may." done={done} onClose={onClose}
    footer={done ? <Button variant="primary" onClick={onClose}>Done</Button> : <><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={confirm}>Use {toProfile?.name}</Button></>}>
    {done ? <FlowSuccess title={`${name} uses ${toProfile?.name}`}>New turns use it; turns running now finish on {fromProfile?.name}. Recorded in the audit log.</FlowSuccess> : <>
      <Summary rows={[['Profile', `${fromProfile?.name ?? '—'} → ${toProfile?.name ?? to}`], ...['default', 'plan', 'review'].map((role): readonly [string, ReactNode] => [`${role} model`, `${model(fromProfile?.id, role)} → ${model(toProfile?.id, role)}`]),
        ['Team providers', `${providers(fromProfile?.teamProviders)} → ${providers(toProfile?.teamProviders)}`],
        ['Holders’ own', `${fromProfile?.personal.length ? fromProfile.personal.join(', ') : 'none'} → ${toProfile?.personal.length ? toProfile.personal.join(', ') : 'none'}`]]} />
      {fromProfile?.personal.length && !toProfile?.personal.length ? <Hint>Holders’ own subscriptions and keys stop paying here; team providers pay every turn.</Hint> : null}
    </>}
  </FlowDialog>;
}

export function PluginToggleDialog({ project, plugin, onClose }: { project: string; plugin: string; onClose(): void }) {
  const viewer = useViewer();
  const { say } = useMock();
  const settings = projectSettings.use();
  const [done, setDone] = useState(false);
  const own = settings[project];
  const name = projectName(project);
  const holders = plugin === 'holders';
  const entry = PLUGINS.find((candidate) => candidate.id === plugin);
  const on = holders ? own?.holdersPlugins ?? false : own?.teamPlugins.includes(plugin) ?? false;
  const label = holders ? 'Holders’ own plugins' : entry?.name ?? plugin;
  const open = WORKSPACES.filter((workspace) => workspace.projectId === project && !workspace.archived).length;
  const confirm = (): void => {
    if (!own) return;
    if (holders) changeProject(project, { holdersPlugins: !on });
    else changeProject(project, { teamPlugins: on ? own.teamPlugins.filter((id) => id !== plugin) : [...own.teamPlugins, plugin] });
    recordAudit({ actor: viewer.id, kind: 'setting', project, text: `Turned ${label} ${on ? 'off' : 'on'} in ${name}` });
    say(`${label} ${on ? 'off' : 'on'} in ${name}`);
    setDone(true);
  };
  const effect = holders
    ? on ? `Each holder’s own Slack, Linear, Composio links and paired Chrome stop joining ${name}’s workspaces; only the team’s and the repository’s plugins work.` : `Each holder’s own plugins join the workspaces they hold in ${name}, only while they hold the handle.`
    : on ? `${label}’s tools leave ${name}’s ${open} open workspaces on their next turn.` : `${label}’s tools join ${name}’s ${open} open workspaces on their next turn, acting as ${entry?.auth.toLowerCase()} (${entry?.detail}).`;
  return <FlowDialog id="plugin-toggle" title={`Turn ${label} ${on ? 'off' : 'on'} in ${name}?`} done={done} wide={false} onClose={onClose}
    footer={done ? <Button variant="primary" onClick={onClose}>Done</Button> : <><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={confirm}>Turn {on ? 'off' : 'on'}</Button></>}>
    {done ? <FlowSuccess title={`${label} is ${on ? 'off' : 'on'} in ${name}`}>Recorded in the audit log under {viewer.first}.</FlowSuccess> : <Hint>{effect}</Hint>}
  </FlowDialog>;
}

/** How a repository is reached: the GitHub App, the team SSH key where it's registered (team machines only), or not at
 * all, with what would fix it. */
export function reachOf(repository: string): { state: 'app' | 'machine' | 'none'; label: string; fix: string | null } {
  const org = appCovers(repository);
  if (org) return { state: 'app', label: `GitHub App (${org}) on every machine`, fix: null };
  const host = repository.split('/')[0] ?? repository;
  if (TEAM_SSH_KEY.registered.some((place) => place.includes(repository) || place.includes(host))) return { state: 'machine', label: 'Through team machines, with the team SSH key (personal machines use their owner’s key)', fix: null };
  const owner = repository.split('/')[1] ?? '';
  return { state: 'none', label: 'Not reachable', fix: host === 'github.com' ? `Install the GitHub App on ${owner}, or ask its owners to install it` : `Register the team SSH key on ${host}` };
}

// ── Automations ──

const CRON_FIELDS: ReadonlyArray<readonly [string, number, number]> = [['minute', 0, 59], ['hour', 0, 23], ['day of month', 1, 31], ['month', 1, 12], ['day of week', 0, 6]];
const DAYS = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];

/** Why a five-field cron schedule is invalid, or null. */
export function cronError(text: string): string | null {
  const parts = text.trim().split(/\s+/).filter(Boolean);
  if (parts.length !== 5) return `A schedule has 5 fields (minute hour day-of-month month day-of-week); this has ${parts.length}. Example: 0 2 * * * runs daily at 02:00 UTC.`;
  for (const [index, part] of parts.entries()) {
    const [label, min, max] = CRON_FIELDS[index] ?? ['field', 0, 59];
    for (const piece of part.split(',')) {
      const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(piece);
      if (!match) return `“${piece}” isn’t a valid ${label}: use a number, a range like 1-5, a list like 1,3 or a step like */15.`;
      if (match[2] === '0') return `A step of 0 never runs: use */1 or a larger step in the ${label}.`;
      if (match[1] !== '*') for (const value of (match[1] ?? '').split('-').map(Number)) if (value < min || value > max) return `The ${label} must be ${min}–${max}; “${value}” is out of range.`;
    }
  }
  return null;
}
/** A valid schedule in words. */
export function cronText(text: string): string {
  const [minute = '', hour = '', dom = '', month = '', dow = ''] = text.trim().split(/\s+/);
  const step = /^\*\/(\d+)$/.exec(minute);
  if (step && hour === '*' && dom === '*' && month === '*' && dow === '*') return `Every ${step[1]} minutes`;
  if (/^\d+$/.test(minute) && /^\d+$/.test(hour) && dom === '*' && month === '*') {
    const at = `${hour.padStart(2, '0')}:${minute.padStart(2, '0')} UTC`;
    if (dow === '*') return `Daily at ${at}`;
    if (dow === '1-5') return `Weekdays at ${at}`;
    if (/^\d$/.test(dow)) return `${DAYS[Number(dow)]} at ${at}`;
  }
  return `Cron ${text.trim()} (UTC)`;
}

const EVENTS = ['Pull request opened', 'Pull request ready for review', 'Issue labelled “bug”', 'Push to the base branch', 'Check suite failed'] as const;

export function NewAutomationWizard({ project, onClose }: { project: string; onClose(): void }) {
  const viewer = useViewer();
  const { say } = useMock();
  useRoles();
  const settings = projectSettings.use()[project];
  const base = PROJECTS.find((entry) => entry.id === project)?.branch ?? 'main';
  const machines = machineChoices(project, viewer.id, false);
  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [kind, setKind] = useState('schedule');
  const [cron, setCron] = useState('0 2 * * *');
  const [event, setEvent] = useState<string>(EVENTS[0]);
  const [repository, setRepository] = useState(settings?.repositories[0] ?? '');
  const [action, setAction] = useState('start');
  const [prompt, setPrompt] = useState('');
  const [template, setTemplate] = useState('base');
  const [phase, setPhase] = useState('code');
  const [machine, setMachine] = useState(machines.find((choice) => !choice.disabled)?.id ?? '');
  const [profile, setProfile] = useState(settings?.profile ?? 'default');
  const [notify, setNotify] = useState<ReadonlySet<string>>(new Set());
  const [slack, setSlack] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<'enabled' | 'proposed' | null>(null);
  const projectLabel = projectName(project);
  const refused = why(viewer.id, project, 'automations.propose');
  if (refused) return <RefusedDialog id="new-automation" title="New automation" reason={refused} who={whoCan(project, 'automations.propose')} onClose={onClose} />;
  if (!settings) return null;
  const canEnable = why(viewer.id, project, 'automations.enable') === null;
  const leads = leadsOf(project);
  const fixed = new Set([...leads, viewer.id]);
  const people = USERS.filter((user) => projectRoleOf(user.id, project) !== null);
  const slug = (name.trim() || 'automation').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const hook = `https://crumbco.gitspace.sh/hooks/${project}/${slug}`;
  const appRepos = settings.repositories.filter((entry) => appCovers(entry));
  const otherRepos = settings.repositories.filter((entry) => !appCovers(entry));
  const scheduleError = kind === 'schedule' ? cronError(cron) : null;
  const trigger = kind === 'schedule' ? cronText(cron) : kind === 'event' ? `${event} · ${repository.replace('github.com/', '')}` : 'Webhook';
  const host = machineOf(machine);
  const profileName = PROFILES.find((entry) => entry.id === profile)?.name ?? profile;
  const notified = [...new Set([...fixed, ...notify])].map((id) => findPrincipal(id)?.first ?? id);
  const advance = (): void => {
    setError(null);
    if (step === 0) {
      if (!name.trim()) { setError('Name it: it shows on the project card, in runs and in Needs you.'); return; }
      if (automations.get()[project]?.some((entry) => entry.name.toLowerCase() === name.trim().toLowerCase())) { setError(`${projectLabel} already has an automation named “${name.trim()}”.`); return; }
      if (scheduleError) { setError(scheduleError); return; }
      setStep(1); return;
    }
    if (step === 1) { if (prompt.trim().length < 12) { setError('Say what the agent should do (at least a sentence): it becomes the workspace’s first message.'); return; } setStep(2); return; }
    if (step === 2) { if (!host) { setError('Pick where it runs.'); return; } setStep(3); return; }
    if (step === 3) { setStep(4); return; }
    const state = canEnable ? 'on' : 'proposed';
    automations.set({ ...automations.get(), [project]: [...(automations.get()[project] ?? []), { name: name.trim(), trigger: `${trigger} · on ${host?.label}`, state, by: viewer.id, enabledBy: canEnable ? viewer.id : undefined, detail: prompt.trim() }] });
    recordAudit({ actor: viewer.id, kind: 'setting', project, text: canEnable ? `Enabled the automation “${name.trim()}” in ${projectLabel} (${trigger})` : `Proposed the automation “${name.trim()}” in ${projectLabel} (${trigger})` });
    say(canEnable ? `${name.trim()} is on · Enabled by ${viewer.first}` : `${name.trim()} proposed · ${projectLabel}’s Leads see it in Needs you`);
    setDone(canEnable ? 'enabled' : 'proposed');
  };
  return <FlowDialog id="new-automation" title="New automation" description={`Scheduled and triggered runs in ${projectLabel}. Each run starts work on team resources; a failed run goes to Needs you for the Leads and whoever enabled it.`}
    steps={['Trigger', 'What it runs', 'Where', 'Notify', 'Review']} step={step} done={done !== null} onClose={onClose}
    footer={done ? <Button variant="primary" onClick={onClose}>Done</Button> : <StepButtons step={step} onBack={() => { setError(null); setStep(step - 1); }} onCancel={onClose} next={advance} nextLabel={step === 4 ? canEnable ? 'Enable' : 'Propose' : 'Next'} />}>
    {done === 'enabled' ? <>
      <FlowSuccess title={`${name.trim()} is on · Enabled by ${viewer.first}`}>{trigger}. Running ones show on {projectLabel}’s card and overview; a failed run goes to {listNames(notified)} in Needs you.</FlowSuccess>
      {kind === 'webhook' ? <><InputCopy label="Webhook URL" value={hook} /><ShownOnce label="Signing secret" value={`whsec_${slug.replace(/-/g, '').slice(0, 8)}7Qm2xV9kLp4RtZ8c`} /></> : null}
    </> : done === 'proposed' ? <FlowSuccess title={`${name.trim()} is proposed`}>Your project role can propose automations but not enable them. {projectLabel}’s Leads ({listNames(leads.map((id) => findPrincipal(id)?.first ?? id))}) see it in Needs you; whoever enables it is named on it.</FlowSuccess>
      : step === 0 ? <>
        <InputGroup className="w-full"><InputField index={0} label="Name" placeholder="Nightly flaky-test sweep" value={name} onChange={(value) => { setName(value); setError(null); }} /></InputGroup>
        <ChoiceCards label="Trigger" value={kind} onChange={(value) => { setKind(value); setError(null); }} choices={[
          { id: 'schedule', title: 'Schedule', detail: 'A cron schedule in UTC', icon: Clock },
          { id: 'event', title: 'Event', detail: 'Something on GitHub, through the GitHub App: a pull request opened, an issue labelled', icon: Zap },
          { id: 'webhook', title: 'Webhook', detail: 'Any service that can POST a signed request', icon: Dataflow03 },
        ]} />
        {kind === 'schedule' ? <>
          <InputGroup className="w-full"><InputField index={1} label="Schedule (cron, UTC)" value={cron} error={scheduleError ?? undefined} onChange={(value) => { setCron(value); setError(null); }} /></InputGroup>
          <div className="flex flex-wrap gap-1.5">{[['0 2 * * *', 'Daily 02:00'], ['0 9 * * 1-5', 'Weekdays 09:00'], ['0 6 * * 1', 'Mondays 06:00'], ['*/30 * * * *', 'Every 30 minutes']].map(([value, label]) => <Button key={value} size="compact" variant={cron === value ? 'primary' : 'secondary'} onClick={() => { setCron(value ?? ''); setError(null); }}>{label}</Button>)}</div>
          {scheduleError ? null : <Hint>{cronText(cron)}.</Hint>}
        </> : kind === 'event' ? <>
          <Picker label="Event" value={event} onChange={setEvent} options={EVENTS.map((entry) => ({ id: entry, label: entry }))} />
          <Picker label="Repository" value={repository} onChange={setRepository} options={appRepos.map((entry) => ({ id: entry, label: entry }))} />
          {otherRepos.length ? <Hint>{otherRepos.join(', ')} {otherRepos.length === 1 ? 'isn’t' : 'aren’t'} covered by the GitHub App, so {otherRepos.length === 1 ? 'its' : 'their'} events can’t arrive; use a webhook from that host instead.</Hint> : null}
          <Hint>An event runs only if its author has write access to the repository; anyone else’s is skipped and shows in recent runs.</Hint>
        </> : <>
          <InputCopy label="Webhook URL" value={hook} />
          <Hint>Requests must be signed (HMAC-SHA256, header X-GitSpace-Signature). The signing secret is made when it’s enabled and shown once. Unsigned or wrongly signed requests are refused and logged.</Hint>
        </>}
      </> : step === 1 ? <>
        <Picker label="Action" value={action} onChange={setAction} options={[{ id: 'start', label: 'Start a workspace' }, { id: 'message', label: 'Message the project agent' }]} />
        <TextArea label="Instruction" value={prompt} onChange={(value) => { setPrompt(value); setError(null); }} rows={4} placeholder="Run the test suite 20 times, list the tests that fail sometimes, and open a pull request that quarantines them with a note per test." />
        {action === 'start' ? <div className="grid gap-3 sm:grid-cols-2">
          <Picker label="Workspace template" value={template} onChange={setTemplate} options={[{ id: 'base', label: `Blank, from ${base}` }, ...(kind === 'event' && event.startsWith('Pull request') ? [{ id: 'pr', label: 'From the pull request’s branch' }] : []), { id: 'env', label: `${projectLabel}’s current environment revision` }]} />
          <Picker label="Starts in" value={phase} onChange={setPhase} options={(['plan', 'code', 'review'] as const).map((entry) => ({ id: entry, label: PHASE_LABEL[entry] }))} />
        </div> : <Hint>The project agent gets the {kind === 'schedule' ? 'tick' : kind === 'event' ? 'event' : 'request'} and decides: start a workspace, message one, or skip. One agent turn each time.</Hint>}
        {action === 'start' ? <Hint>Ship isn’t offered: moving into Ship is a person’s call.</Hint> : null}
      </> : step === 2 ? <>
        <ChoiceCards label="Machine" value={machine} onChange={setMachine} choices={machines} />
        <Picker label="Model profile" value={profile} onChange={setProfile} options={PROFILES.map((entry) => ({ id: entry.id, label: `${entry.name}${entry.id === settings.profile ? ` · ${projectLabel}’s` : ''}` }))} />
        <Hint>Runs use team resources only: team machines and the profile’s team providers. Nobody holds the handle during a run, so nobody’s own providers, plugins or machines join.</Hint>
      </> : step === 3 ? <>
        <Labelled label="Who hears about a failed run"><ChipPicker label="Notify on failure" picked={new Set([...fixed, ...notify])} onChange={(value) => setNotify(new Set([...value].filter((id) => !fixed.has(id))))}
          options={people.map((user) => ({ id: user.id, label: `${user.first}${leads.includes(user.id) ? ' · Lead' : user.id === viewer.id ? ' · you' : ''}`, disabled: fixed.has(user.id) ? leads.includes(user.id) ? 'Leads always hear about failed runs' : 'Whoever enables it always hears' : null }))} /></Labelled>
        <Hint>{canEnable ? `The Leads and you (enabling it) always get failed runs in Needs you.` : `The Leads always get failed runs; whoever enables it is added.`} Others are optional.</Hint>
        {settings.teamPlugins.includes('slack-app') ? <Switch label="Also post failures to Slack (#kitchen-dev)" checked={slack} onToggle={() => setSlack(!slack)} /> : null}
      </> : <Summary rows={[['Name', name.trim()], ['Trigger', trigger], ['Runs', action === 'start' ? `Starts a workspace in ${PHASE_LABEL[phase === 'plan' ? 'plan' : phase === 'review' ? 'review' : 'code']} (${template === 'pr' ? 'the pull request’s branch' : template === 'env' ? 'current environment revision' : `from ${base}`})` : 'Messages the project agent'],
        ['Instruction', prompt.trim()], ['Where', `${host?.label ?? '—'} · ${profileName}`], ['On failure', `${listNames(notified)}${slack && settings.teamPlugins.includes('slack-app') ? ' · Slack #kitchen-dev' : ''}`], [canEnable ? 'Enabled by' : 'Proposed by', `${viewer.first} (you)`]]} />}
    {error && step !== 0 ? <FlowError>{error}</FlowError> : error && !scheduleError ? <FlowError>{error}</FlowError> : null}
  </FlowDialog>;
}

export function AutomationStateDialog({ project, name, onClose }: { project: string; name: string; onClose(): void }) {
  const viewer = useViewer();
  const { say } = useMock();
  const [entry] = useState(() => automations.get()[project]?.find((candidate) => candidate.name === name));
  const [done, setDone] = useState(false);
  if (!entry) return null;
  const pausing = entry.state === 'on';
  const label = projectName(project);
  const leads = leadsOf(project).map((id) => findPrincipal(id)?.first ?? id);
  const confirm = (): void => {
    automations.set({ ...automations.get(), [project]: (automations.get()[project] ?? []).map((candidate) => candidate.name === name ? { ...candidate, state: pausing ? 'paused' : 'on', enabledBy: pausing ? candidate.enabledBy : viewer.id } : candidate) });
    recordAudit({ actor: viewer.id, kind: 'setting', project, text: `${pausing ? 'Paused' : 'Enabled'} the automation “${name}” in ${label}` });
    say(`${name} ${pausing ? 'paused' : `is on · Enabled by ${viewer.first}`}`);
    setDone(true);
  };
  return <FlowDialog id="automation-state" title={`${pausing ? 'Pause' : 'Enable'} “${name}”?`} wide={false} done={done} onClose={onClose}
    footer={done ? <Button variant="primary" onClick={onClose}>Done</Button> : <><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={confirm}>{pausing ? 'Pause' : 'Enable'}</Button></>}>
    {done ? <FlowSuccess title={pausing ? `${name} is paused` : `${name} is on · Enabled by ${viewer.first}`}>{pausing ? 'No new runs start; a run going now finishes. Enable it again any time.' : `Failed runs go to Needs you for ${listNames([...new Set([...leads, viewer.first])])}.`}</FlowSuccess> : <>
      <Summary rows={[['Trigger', entry.trigger], [entry.state === 'proposed' ? 'Proposed by' : 'By', actorLabel(entry.by)], ...(entry.detail ? [['Instruction', entry.detail] as const] : []), [pausing ? 'Pausing' : 'Enabled by', pausing ? 'No new runs until it’s enabled again; one running now finishes' : `${viewer.first} (you): you hear about failed runs, with ${listNames(leads)}`]]} />
    </>}
  </FlowDialog>;
}

// ── Secrets ──

type ProjectSecretKind = 'secret' | 'value' | 'token' | 'login';

/** Add a project secret, value, API token or login: kind → name and value (checked) → its rule, starting from the
 * default for its sensitivity. */
export function AddSecretDialog({ project, onClose }: { project: string; onClose(): void }) {
  const viewer = useViewer();
  const { say } = useMock();
  const live = secrets.use();
  const [step, setStep] = useState(0);
  const [kind, setKind] = useState<ProjectSecretKind>('secret');
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [site, setSite] = useState('');
  const [username, setUsername] = useState('');
  const [otp, setOtp] = useState('');
  const [sensitive, setSensitive] = useState(true);
  const [tried, setTried] = useState(false);
  const [added, setAdded] = useState<string | null>(null);
  const label = projectName(project);
  const rule = useRuleStep({ name: name.trim(), scope: project, kind, sensitive: kind !== 'value' && sensitive }, viewer.id);
  const refused = why(viewer.id, project, 'secrets.edit');
  if (refused) return <RefusedDialog id="add-secret" title={`Add to ${label}`} reason={refused} who={whoCan(project, 'secrets.edit')} onClose={onClose} />;
  const typed = name.trim();
  const host = site.trim().replace(/^https?:\/\//, '').split('/')[0] ?? '';
  const team = live.find((secret) => secret.scope === 'team' && secret.name === typed);
  const errors = {
    name: !typed ? `Name it, like ${kind === 'token' ? 'STRIPE_SECRET_KEY' : kind === 'login' ? 'STAGING_ADMIN' : 'DATABASE_URL'}.` : !ENV_NAME.test(typed) ? 'Use capitals, digits and underscores, starting with a letter: agents and scripts ask for it by this name.' : live.some((secret) => secret.scope === project && secret.name === typed) ? `${label} already has ${typed}; rotate it from its row instead.` : null,
    site: kind !== 'token' && kind !== 'login' ? null : !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) ? `Enter the host it’s for, like ${kind === 'token' ? 'api.stripe.com' : 'staging.crumb.example'}.` : null,
    username: kind === 'login' && !username.trim() ? 'Enter the username.' : null,
    value: !value ? (kind === 'value' ? 'Enter the value.' : kind === 'token' ? 'Paste the token.' : kind === 'login' ? 'Enter the password.' : 'Enter the secret value.')
      : kind === 'token' && host.includes('stripe.com') && /^(sk|rk)_live_/.test(value) ? `That’s a live Stripe key (${STRIPE_SECRET_LIVE}…). Projects keep test keys only: use one that starts with sk_test_ or rk_test_.`
      : kind === 'token' && host.includes('stripe.com') && !/^(sk|rk)_test_/.test(value) ? 'Stripe test keys start with sk_test_ or rk_test_.' : null,
    otp: kind === 'login' && otp.trim() && !/^[A-Z2-7]+=*$/.test(otp.replace(/\s/g, '').toUpperCase()) ? 'One-time code secrets are base32 (A–Z and 2–7): the text under the site’s “can’t scan?” link.' : null,
  };
  const next = (): void => {
    if (step === 0) { setStep(1); return; }
    if (step === 1) { setTried(true); if (Object.values(errors).some(Boolean)) return; setTried(false); setStep(2); return; }
    const chosen = rule.validate();
    if (!chosen) return;
    secrets.set([...live, {
      id: `added-${project}-${typed}`, name: typed, scope: project, kind, sensitive: kind !== 'value' && sensitive, expires: null, updated: `just now by ${viewer.first}`, lastUsed: 'never',
      detail: kind === 'value' ? value : kind === 'login' ? `${host} login${otp.trim() ? ' · password and one-time code' : ''}` : kind === 'token' ? `${host} token` : 'Project secret',
      site: host || undefined, username: kind === 'login' ? username.trim() : undefined,
    }]);
    secretRules.set({ ...secretRules.get(), [`${project}:${typed}`]: chosen });
    recordAudit({ actor: viewer.id, kind: 'setting', project, text: `Added the ${SECRET_KIND_LABEL[kind].toLowerCase()} ${typed} to ${label} · ${ruleLine(chosen, { value: kind === 'value' })}` });
    say(`Saved ${typed} to ${label}`);
    setAdded(ruleLine(chosen, { value: kind === 'value' }));
  };
  const shown = (key: keyof typeof errors): string | undefined => tried ? errors[key] ?? undefined : undefined;
  return <FlowDialog id="add-secret" title={added ? `${typed} is saved to ${label}` : `Add to ${label}`} steps={['Kind', 'Value', 'Rule']} step={step} done={added !== null} onClose={onClose}
    description={added ? undefined : `Write target: ${label}. ${kind === 'value' ? 'A value is visible: use a secret for anything sensitive.' : 'It can’t be viewed after saving.'}`}
    footer={added ? <Button variant="primary" onClick={onClose}>Done</Button> : <StepButtons step={step} onBack={() => { setTried(false); rule.reset(); setStep(step - 1); }} onCancel={onClose} next={next} nextLabel={step === 2 ? `Save to ${label}` : 'Next'} />}>
    {added ? <FlowSuccess title={added}>{label}’s workspaces get it under this rule from their next turn{team ? `, instead of the team’s ${team.name}` : ''}. Edit the rule from its row. Recorded in the audit log.</FlowSuccess>
      : step === 0 ? <ChoiceCards label="Kind" columns={2} value={kind} onChange={(id) => { if (id === 'secret' || id === 'value' || id === 'token' || id === 'login') { setKind(id); setSensitive(id === 'secret' || id === 'token'); } }} choices={[
        { id: 'secret', title: 'Secret', detail: 'Write-only: a password, key or URL with credentials', icon: Lock01 },
        { id: 'value', title: 'Value', detail: 'Visible: a region, a flag, a hostname', icon: Key01 },
        { id: 'token', title: 'API token', detail: 'A token for a service, like a Stripe test key', icon: Key01 },
        { id: 'login', title: 'Login', detail: 'A username and password (and one-time code) for a site', icon: Lock01 },
      ]} />
      : step === 1 ? <>
        <InputGroup className="w-full">
          <InputField index={0} label="Name" placeholder={kind === 'token' ? 'STRIPE_SECRET_KEY' : kind === 'login' ? 'STAGING_ADMIN' : 'DATABASE_URL'} value={name} error={shown('name')} onChange={setName} />
          {kind === 'token' || kind === 'login' ? <InputField index={1} label={kind === 'token' ? 'Service host' : 'Site'} placeholder={kind === 'token' ? 'api.stripe.com' : 'staging.crumb.example'} value={site} error={shown('site')} onChange={setSite} /> : null}
          {kind === 'login' ? <InputField index={2} label="Username" value={username} error={shown('username')} onChange={setUsername} /> : null}
          <InputField index={3} label={kind === 'value' ? 'Value' : kind === 'token' ? 'Token' : kind === 'login' ? 'Password' : 'Secret value'} type={kind === 'value' ? 'text' : 'password'} value={value} error={shown('value')} onChange={setValue} />
          {kind === 'login' ? <InputField index={4} label="One-time code secret (optional)" value={otp} error={shown('otp')} onChange={setOtp} /> : null}
        </InputGroup>
        {kind === 'value' ? null : <Switch label="Sensitive: production, money or admin (starts as only to approved scripts)" checked={sensitive} onToggle={() => setSensitive(!sensitive)} />}
        {team ? <Hint>Overrides the team’s {team.name} in {label}.</Hint> : <Hint>Secure input: it goes straight to GitSpace’s vault. Agents never see the value; this page never shows it again.</Hint>}
      </> : rule.body}
  </FlowDialog>;
}
