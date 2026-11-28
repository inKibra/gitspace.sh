// Crumb & Co › Bots: sponsored principals that act only over MCP, the ones the viewer sponsors first. Each opens its own
// settings: the Settings nav's "Settings for" picker switched to that bot, the same pages as You, starting at its
// Profile. Owners and Admins create, reassign and take over; a bot's sponsor, Owners and Admins manage it; Members read
// the list.
import { glyph } from '../../glyph.js';
import { Button, InputCopy, InputField, InputGroup, Select, SelectContent, SelectItem, SelectTrigger } from '@gitspace/ui';
import { Clock, Key01, Link03, Plus } from '@untitledui/icons';
import { useState } from 'react';
import { actorLabel, bots, memberships, notify, setMembership, USERS, userOf, visibleProjects, type Bot, type User } from '../data.js';
import { BotRolePicker, BotRolesDialog, manageReason } from '../flows/bots.js';
import { handleError, handleFor, sponsorRequests } from '../flows/bots-data.js';
import { MOCK_CLIENT_SECRET } from '../flows/token-shapes.js';
import { secrets } from '../flows/team-data.js';
import { ChoiceCards, FlowDialog, FlowError, FlowSuccess, Hint, PasskeyStep, ShownOnce, StepButtons, Summary, TextArea } from '../flows/kit.js';
import { useMock, useViewer } from '../viewer.js';
import { accountRoleChanges, BOT_ACTIVITY, botSignIns, projectName, recordAudit, removedUsers } from './data.js';
import { Act, Avatar, Note, Pill, Section, SettingRow, SettingRows, UserName } from './parts.js';
import { passkeyLabel, usePasskey } from './passkey.js';
import { roleName, useRoles, whyAccount } from './roles.js';

/** Admins and Owners now: who may sponsor a bot. */
function sponsorsNow(roles: Readonly<Record<string, string>>): readonly User[] {
  return USERS.filter((user) => !removedUsers.get().has(user.id) && (roles[user.id] ?? user.accountRole) !== 'member');
}

export function BotsPage({ navigate }: { navigate(page: string): void }) {
  const viewer = useViewer();
  const { say, navigate: go } = useMock();
  useRoles();
  const list = bots.use();
  const live = memberships.use();
  const signIns = botSignIns.use();
  const roles = accountRoleChanges.use();
  const seen = visibleProjects(viewer.id);
  const create = whyAccount(viewer.id, 'account.bots');
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Bot | null>(null);
  const [reassigning, setReassigning] = useState<Bot | null>(null);
  const sponsoring = list.some((bot) => bot.sponsor === viewer.id);
  return <>
    {sponsoring ? <SponsoredBotsSection /> : null}
    <Section title="Bots" scope="Team" readOnly={create ? `${create}: Owners and Admins create bots` : null}
      description={<>Principals that aren’t people: each acts only over MCP, signed in as itself, with account role Member (never more) and project roles like anyone’s; it is the commit author of turns it starts. Its sponsor is an Admin or Owner, and its actions read “Release bot (sponsored by Theo) via Claude Code”. If the sponsor leaves or loses Admin, its sign-ins are blocked (kept, not deleted) until an Admin takes it over. Creating one needs your passkey.</>}
      actions={<Act reason={create} variant="primary" leadingIcon={glyph(Plus)} onClick={() => setCreating(true)}>New bot</Act>}>
      <SettingRows label="Bots">{list.map((bot) => {
        const own = live.filter((entry) => entry.userId === bot.id && seen.has(entry.projectId));
        const mine = signIns.filter((entry) => entry.bot === bot.id);
        const manage = manageReason(viewer, bot);
        const activity = (BOT_ACTIVITY[bot.id] ?? []).slice(0, 2);
        return <SettingRow key={bot.id} title={<span data-bot={bot.id} className="flex flex-wrap items-center gap-2"><Avatar userId={bot.id} size={24} />{bot.name}<span className="font-mono text-caption text-muted-foreground">@{bot.id}</span><Pill tone="violet">Bot</Pill>
          {bot.sponsor ? <Pill tone="green">Active</Pill> : <Pill tone="amber">Sign-ins blocked</Pill>}<Pill>Member</Pill></span>}
          description={bot.description}
          extra={<div className="mt-1 flex flex-col gap-1 text-caption">
            {bot.sponsor ? <span className="inline-flex flex-wrap items-center gap-1 text-muted-foreground">Sponsored by <UserName userId={bot.sponsor} you={viewer.id} /> · created {bot.created} · acts as “{actorLabel(bot.id)}”</span>
              : <span className="text-foreground">Sign-ins blocked: its sponsor {bot.formerSponsor} {bot.lapse ?? 'is gone'}. Its sign-ins are kept and refused; they expire {bot.expires ?? 'in 30 days'} unless an Admin or Owner takes it over.</span>}
            <span className="text-foreground">{own.length ? own.map((entry) => `${roleName(entry.roleId)} in ${projectName(entry.projectId)}`).join(' · ') : 'In no project you can see'}</span>
            <span className="text-muted-foreground">{mine.length ? `Signs in as: ${mine.map((entry) => `${entry.label} (${entry.kind === 'connected' ? 'Connected client' : 'Client secret'})`).join(' · ')}` : 'Not signed in anywhere yet: connect a client or create a client secret'}</span>
            {activity.length ? <ul data-bot-activity="" className="flex flex-col gap-0.5 border-l-2 border-border pl-2 text-muted-foreground">{activity.map((entry) => <li key={entry.time + entry.text}><span className="tabular-nums">{entry.time}</span> · {entry.workspace ? `${entry.workspace}: ` : ''}{entry.text}{entry.sha ? ` · ${entry.sha}` : ''}</li>)}</ul> : null}
          </div>}>
          <Act reason={manage} variant="ghost" aria-label={`Roles of ${bot.name}`} onClick={() => setEditing(bot)}>Roles</Act>
          <Act reason={manage} variant="ghost" aria-label={`Open ${bot.name}`} onClick={() => go('settings', { page: 'bots', person: bot.id })}>Open</Act>
          {create === null ? (bot.sponsor ? <Button variant="ghost" onClick={() => setReassigning(bot)}>Reassign</Button> : <Button variant="primary" onClick={() => setReassigning(bot)}>Take over</Button>) : null}
        </SettingRow>;
      })}</SettingRows>
      <div className="flex flex-wrap items-center gap-2"><Note>Their actions, with sponsors, are in the audit log, filterable by bot and by sponsor.</Note>{whyAccount(viewer.id, 'account.audit') === null ? <Button variant="ghost" size="compact" onClick={() => navigate('audit')}>Open the audit log</Button> : null}</div>
    </Section>
    {creating ? <CreateBotWizard onClose={() => setCreating(false)} /> : null}
    {editing ? <BotRolesDialog bot={editing} onClose={() => setEditing(null)} /> : null}
    {reassigning ? <ReassignDialog bot={reassigning} people={sponsorsNow(roles)} viewerId={viewer.id} onClose={() => setReassigning(null)} onReassign={(userId) => {
      bots.set(bots.get().map((entry) => entry.id === reassigning.id ? { ...entry, sponsor: userId, formerSponsor: null, lapse: null, expires: null } : entry));
      recordAudit({ actor: viewer.id, kind: 'bot', text: `${userId === viewer.id ? 'Took over' : 'Reassigned'} ${reassigning.name}${userId === viewer.id ? ' as sponsor' : ` to ${userOf(userId).name} as sponsor`}${reassigning.sponsor ? '' : ' · its sign-ins work again'}` });
      if (userId !== viewer.id) notify({ to: userId, from: viewer.id, text: `${viewer.first} made you ${reassigning.name}’s sponsor`, detail: 'Its actions carry your name from now on' });
      say(`${reassigning.name} is sponsored by ${userOf(userId).first}${reassigning.sponsor ? '' : ' · its sign-ins work again'}`);
    }} /> : null}
  </>;
}

/** The bots the viewer sponsors, with their state, projects, sign-ins and last activity; each opens its settings. */
function SponsoredBotsSection() {
  const viewer = useViewer();
  const { navigate } = useMock();
  const list = bots.use();
  const signIns = botSignIns.use();
  const owned = secrets.use();
  const requests = sponsorRequests.use();
  const live = memberships.use();
  const mine = list.filter((bot) => bot.sponsor === viewer.id);
  return <Section title="Bots you sponsor" scope="You"
    description="Your name goes on their actions; a sponsor is an Admin or Owner. Each opens its own settings, the same pages as yours (or pick it under “Settings for” at the top of this nav), and you manage it in full: its profile and roles within your own, sign-ins and their slices, its own providers, plugins and secrets (uses that need your approval come to your Needs you), its Git identity. If you leave or lose Admin, their sign-ins are blocked until another Admin takes them over.">
    <SettingRows label="Bots you sponsor">{mine.map((bot) => {
      const projects = live.filter((entry) => entry.userId === bot.id).map((entry) => `${roleName(entry.roleId)} in ${projectName(entry.projectId)}`);
      const count = signIns.filter((entry) => entry.bot === bot.id).length;
      const waiting = Object.keys(requests).filter((key) => key.startsWith(`${bot.id}:`)).length;
      const secretCount = owned.filter((entry) => entry.scope === bot.id).length;
      const last = BOT_ACTIVITY[bot.id]?.[0];
      return <SettingRow key={bot.id} title={<span data-sponsored-bot={bot.id} className="flex flex-wrap items-center gap-2"><Avatar userId={bot.id} size={24} />{bot.name}<span className="font-mono text-caption text-muted-foreground">@{bot.id}</span>
        {bot.sponsor ? <Pill tone="green">Active</Pill> : <Pill tone="amber">Sign-ins blocked</Pill>}{waiting ? <Pill tone="blue">{waiting} waiting for you</Pill> : null}</span>}
        description={bot.description}
        extra={<div className="mt-1 flex flex-col gap-0.5 text-caption">
          <span className="text-foreground">{projects.length ? projects.join(' · ') : 'In no project yet'}</span>
          <span className="inline-flex items-center gap-1 text-muted-foreground"><Link03 width={12} height={12} />{count} {count === 1 ? 'sign-in' : 'sign-ins'} · <Key01 width={12} height={12} />{secretCount} {secretCount === 1 ? 'secret' : 'secrets'}</span>
          {last ? <span className="inline-flex items-center gap-1 text-muted-foreground"><Clock width={12} height={12} />Last: {last.time} · {last.workspace ? `${last.workspace}: ` : ''}{last.text}</span> : null}
        </div>}>
        <Button variant="secondary" aria-label={`Open ${bot.name}`} onClick={() => navigate('settings', { page: 'profile', person: bot.id })}>Open</Button>
      </SettingRow>;
    })}</SettingRows>
  </Section>;
}

/** The Create bot wizard: name and handle, sponsor, roles (Member, plus project roles within your own), its first
 * sign-in, then your passkey. */
function CreateBotWizard({ onClose }: { onClose(): void }) {
  const viewer = useViewer();
  const { say, navigate } = useMock();
  const passkey = usePasskey();
  const roles = accountRoleChanges.use();
  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [handle, setHandle] = useState('');
  const [handleTouched, setHandleTouched] = useState(false);
  const [description, setDescription] = useState('');
  const [sponsor, setSponsor] = useState(viewer.id);
  const [picked, setPicked] = useState<Readonly<Record<string, string>>>({});
  const [first, setFirst] = useState('connect');
  const [label, setLabel] = useState('nightly-ci');
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const [created, setCreated] = useState<{ id: string; secret: string | null } | null>(null);
  const steps = ['Name', 'Sponsor', 'Roles', 'First sign-in', 'Passkey'];
  const shownHandle = handleTouched ? handle : handleFor(name);
  const sponsors = sponsorsNow(roles);
  const next = (): void => {
    const found: Record<string, string> = {};
    if (step === 0) {
      if (!name.trim()) found.name = 'Name it: people see this on its actions';
      else if (bots.get().some((bot) => bot.name.toLowerCase() === name.trim().toLowerCase())) found.name = `There’s already a ${name.trim()}`;
      const reason = handleError(shownHandle, [...bots.get().map((bot) => bot.id), ...USERS.map((user) => user.id)]);
      if (reason) found.handle = reason;
      if (!description.trim()) found.description = 'Say what it does and when: its sponsor and Admins read this';
    }
    if (step === 2 && !Object.keys(picked).length) found.roles = 'Give it a role in at least one project: a bot in none can’t do anything';
    if (step === 3 && first === 'secret' && !/^[a-z0-9][a-z0-9-]*$/.test(label.trim())) found.label = 'Lowercase letters, digits and hyphens, like nightly-ci';
    setErrors(found);
    if (Object.keys(found).length) return;
    if (step < 4) { setStep(step + 1); return; }
    passkey.confirm(() => {
      const id = shownHandle;
      const words = name.trim().split(/\s+/);
      bots.set([...bots.get(), { kind: 'bot', id, name: name.trim(), first: name.trim(), initials: words.map((word) => word.charAt(0).toUpperCase()).join('').slice(0, 2), accountRole: 'member', color: '#364fc7', description: description.trim(), sponsor, formerSponsor: null, lapse: null, expires: null, created: 'today', notes: '' }]);
      for (const [projectId, roleId] of Object.entries(picked)) setMembership(id, projectId, roleId);
      let secret: string | null = null;
      if (first === 'secret') {
        botSignIns.set([...botSignIns.get(), { id: `bs-${Date.now()}`, bot: id, kind: 'secret', label: label.trim(), detail: `Client ID gsc_${id.slice(0, 3)}_2Rv8…`, by: viewer.first, created: 'just now', lastUsed: 'never', projects: Object.keys(picked), capabilities: ['read', 'comment'] }]);
        secret = MOCK_CLIENT_SECRET;
      }
      recordAudit({ actor: viewer.id, kind: 'bot', text: `Created ${name.trim()} (@${id}, sponsored by ${userOf(sponsor).first}) · ${Object.entries(picked).map(([projectId, roleId]) => `${roleName(roleId)} in ${projectName(projectId)}`).join(', ')}${secret ? ` · client secret ${label.trim()}` : ''} · confirmed with ${passkeyLabel(viewer.id)}` });
      if (sponsor !== viewer.id) notify({ to: sponsor, from: viewer.id, text: `${viewer.first} created ${name.trim()} with you as its sponsor`, detail: 'Its actions carry your name' });
      say(`Created ${name.trim()} · sponsored by ${sponsor === viewer.id ? 'you' : userOf(sponsor).first}`);
      setCreated({ id, secret });
    });
  };
  const roleSummary = Object.entries(picked).map(([projectId, roleId]) => `${roleName(roleId)} in ${projectName(projectId)}`).join(', ');
  return <FlowDialog id="bot-create" title={created ? `${name.trim()} is created` : 'New bot'} description={created ? undefined : 'A principal that acts only over MCP, as itself. Its sponsor’s name goes on its actions. Creating it needs your passkey.'}
    steps={steps} step={step} done={Boolean(created)} onClose={() => { if (!passkey.waiting) onClose(); }}
    footer={created ? <><Button variant="secondary" onClick={onClose}>Done</Button><Button variant="primary" onClick={() => { onClose(); navigate('settings', { page: 'bots', person: created.id }); }}>Open its page</Button></>
      : <StepButtons step={step} onBack={() => { setErrors({}); setStep(step - 1); }} onCancel={onClose} next={next} busy={passkey.waiting} nextLabel={step === 4 ? 'Create with passkey' : 'Next'} />}>
    {created ? <>
      <FlowSuccess title={`${name.trim()} (sponsored by ${userOf(sponsor).first})`}>@{created.id} · Member · {roleSummary}. In the audit log.</FlowSuccess>
      {created.secret ? <><InputCopy label="Client ID" value={`gsc_${created.id.slice(0, 3)}_2Rv8Kq4M`} /><ShownOnce label={`Client secret ${label.trim()}`} value={created.secret} /></>
        : first === 'connect' ? <><InputCopy label="MCP server" value="https://crumbco.gitspace.sh/mcp" /><Hint>Add this server to its MCP client and run /mcp there. The client shows a code; enter it on {name.trim()}’s page under Sign-ins › Connect a client and approve with your passkey.</Hint></>
        : <Hint>It can’t act until it signs in: connect a client or create a client secret from its page.</Hint>}
    </> : step === 0 ? <>
      <InputGroup className="w-full">
        <InputField index={0} label="Name" placeholder="Release bot" value={name} onChange={(value) => { setName(value); setErrors({}); }} error={errors.name} />
        <InputField index={1} label="Handle" placeholder="release-bot" value={shownHandle} onChange={(value) => { setHandle(value); setHandleTouched(true); setErrors({}); }} error={errors.handle} />
      </InputGroup>
      <Hint>The handle is fixed once created: lowercase, ending in “-bot”. Its commits are authored as {shownHandle || 'handle'}@bots.crumbco.gitspace.sh.</Hint>
      <TextArea label="What it does" rows={2} placeholder="Cuts the release branch on Fridays…" value={description} onChange={(value) => { setDescription(value); setErrors({}); }} error={errors.description} />
    </> : step === 1 ? <>
      <ChoiceCards label="Sponsor" value={sponsor} onChange={setSponsor} choices={sponsors.map((user) => ({ id: user.id, title: user.id === viewer.id ? `${user.name} (you)` : user.name, detail: `${(roles[user.id] ?? user.accountRole) === 'owner' ? 'Owner' : 'Admin'} · its actions read “${name.trim() || 'Bot'} (sponsored by ${user.first})”`, badge: user.id === viewer.id ? <Pill tone="violet">Default</Pill> : undefined }))} />
      <Hint>A sponsor is an Admin or Owner. Someone else you pick is told in their Needs you; if they leave or lose Admin, its sign-ins are blocked until another Admin takes it over.</Hint>
    </> : step === 2 ? <>
      <div className="flex items-center justify-between gap-3 rounded-xl px-3 py-2 shadow-[inset_0_0_0_1px_var(--border)]"><span className="text-body font-medium text-foreground">Account role</span><Pill>Member · fixed for bots</Pill></div>
      <span className="text-caption font-medium text-foreground">Project roles, within your own</span>
      <BotRolePicker botName={name.trim() || 'The bot'} value={picked} onChange={(value) => { setPicked(value); setErrors({}); }} />
      {errors.roles ? <FlowError>{errors.roles}</FlowError> : null}
    </> : step === 3 ? <>
      <ChoiceCards label="First sign-in" value={first} onChange={(value) => { setFirst(value); setErrors({}); }} choices={[
        { id: 'connect', title: 'Connect a client now', detail: 'Its MCP client (Claude Code on a build server, say) signs in; you approve with your passkey. No secret is copied.', icon: Link03 },
        { id: 'secret', title: 'Create a client secret now', detail: 'For scripts, CI and cron: shown once when it’s created, with read and comment in its projects.', icon: Key01 },
        { id: 'later', title: 'Later', detail: 'Sign it in from its page; until then it can’t act.', icon: Clock },
      ]} />
      {first === 'secret' ? <InputGroup className="w-full"><InputField index={0} label="Client secret label" value={label} onChange={(value) => { setLabel(value); setErrors({}); }} error={errors.label} /></InputGroup> : null}
    </> : <>
      <Summary rows={[['Name', `${name.trim()} · @${shownHandle}`], ['Sponsor', userOf(sponsor).name], ['Account role', 'Member'], ['Project roles', roleSummary], ['First sign-in', first === 'connect' ? 'Connect a client' : first === 'secret' ? `Client secret ${label.trim()}` : 'Later']]} />
      <PasskeyStep userId={viewer.id} what={`creating ${name.trim()}`} waiting={passkey.waiting} />
    </>}
  </FlowDialog>;
}

/** Reassign a bot to another Admin or Owner, or take over a blocked one yourself. */
function ReassignDialog({ bot, people, viewerId, onClose, onReassign }: { bot: Bot; people: readonly User[]; viewerId: string; onClose(): void; onReassign(userId: string): void }) {
  const candidates = people.filter((user) => user.id !== bot.sponsor);
  const [who, setWho] = useState(bot.sponsor ? candidates[0]?.id ?? '' : viewerId);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const save = (): void => {
    if (!who) { setError('Pick an Admin or Owner'); return; }
    onReassign(who);
    setDone(true);
  };
  return <FlowDialog id="bot-reassign" wide={false} title={done ? `${bot.name} is sponsored by ${userOf(who).first}` : bot.sponsor ? `Reassign ${bot.name}` : `Take over ${bot.name}`} done={done} onClose={onClose}
    description={done ? undefined : `${bot.sponsor ? `${userOf(bot.sponsor).first} sponsors it now.` : `Its sponsor ${bot.formerSponsor} ${bot.lapse ?? 'is gone'}; its sign-ins are blocked until an Admin takes it over, which restores them.`} A sponsor must be an Admin or Owner. Their name goes on its actions from now on; earlier ones keep the sponsor they had.`}
    footer={done ? <Button variant="primary" onClick={onClose}>Done</Button> : <><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save}>{bot.sponsor ? 'Reassign' : who === viewerId ? 'Take it over' : 'Hand it over'}</Button></>}>
    {done ? <FlowSuccess title={`Its actions read “${actorLabel(bot.id)}”`}>{bot.sponsor ? '' : 'Its sign-ins work again. '}In the audit log.</FlowSuccess> : <>
      <div className="flex flex-wrap items-center justify-between gap-3"><span className="text-body">New sponsor</span>
        <Select value={who} onValueChange={(value) => { setWho(value); setError(null); }}><SelectTrigger aria-label="New sponsor" /><SelectContent>{candidates.map((user, index) => <SelectItem key={user.id} value={user.id} index={index}>{user.id === viewerId ? `${user.name} (you)` : user.name}</SelectItem>)}</SelectContent></Select>
      </div>
      {error ? <FlowError>{error}</FlowError> : null}
    </>}
  </FlowDialog>;
}
