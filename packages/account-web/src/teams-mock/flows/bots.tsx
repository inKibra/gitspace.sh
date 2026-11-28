// The bot-only sections of a bot's settings pages (Bot · name, the same pages as You), each with every dialog and wizard
// behind its buttons. Profile page: Profile (Edit), Roles and projects (within the editor's own project roles),
// Activity and Audit. Sign-ins page: connected clients and client secrets (Connect a client, Create client secret, Edit
// slice, Revoke). Git identity page: author; GitHub App or its own machine user. Its secrets are its own, on its secrets
// page (settings/secrets.tsx OwnSecretsSection). Over every page: the blocked notice with Take it over when it has no
// sponsor. Its sponsor, Owners and Admins manage it; a bot's account role is Member, fixed.
import { glyph } from '../../glyph.js';
import { Button, InputCopy, InputField, InputGroup, Select, SelectContent, SelectItem, SelectTrigger } from '@gitspace/ui';
import { Activity, Check, Edit01, GitBranch01, GitCommit, GitPullRequest, Key01, Link03, MessageChatSquare, ShieldTick, Trash01, User01, XClose } from '@untitledui/icons';
import { useState } from 'react';
import { actorLabel, bots, memberships, setMembership, userOf, visibleProjects, type Bot, type User } from '../data.js';
import { ACTIVE_PROJECTS, audit, BOT_ACTIVITY, botSignIns, CAPABILITIES, projectName, recordAudit, type BotActivity, type BotSignIn, type Capability } from '../settings/data.js';
import { Act, Avatar, Note, Pill, Section, SettingRow, SettingRows, UserName } from '../settings/parts.js';
import { passkeyLabel, usePasskey } from '../settings/passkey.js';
import { projectRoleOf, roleName, useRoles, whyAccount, whyMembers, type ProjectRole } from '../settings/roles.js';
import { useMock, useViewer } from '../viewer.js';
import { botGit, BOT_COLORS, checkToken, defaultEmail, emailError, gitOf, NEEDED_SCOPES, type TokenCheck } from './bots-data.js';
import { ChipPicker, ChoiceCards, FlowDialog, FlowError, FlowSuccess, Hint, PasskeyStep, ShownOnce, StepButtons, Summary, TextArea } from './kit.js';
import { GITHUB_CLASSIC_TOKEN, MOCK_CLIENT_SECRET } from './token-shapes.js';

/** Null when `viewer` may manage `bot` (its sponsor, an Owner or an Admin), else why not. */
export function manageReason(viewer: User, bot: Bot): string | null {
  if (bot.sponsor === viewer.id || whyAccount(viewer.id, 'account.bots') === null) return null;
  return `Only ${bot.sponsor ? `${userOf(bot.sponsor).first} (its sponsor)` : 'its sponsor'}, Owners and Admins manage ${bot.name}`;
}

function projectsOf(botId: string): readonly string[] {
  return memberships.get().filter((entry) => entry.userId === botId).map((entry) => entry.projectId);
}

function DoneButton({ onClose }: { onClose(): void }) {
  return <Button variant="primary" onClick={onClose}>Done</Button>;
}

/** Over every page of a bot with no sponsor: its sign-ins are blocked (kept, refused) until an Admin or Owner takes it
 * over, which restores them. */
export function BotBlockedNotice({ bot }: { bot: Bot }) {
  const viewer = useViewer();
  const { say } = useMock();
  const signIns = botSignIns.use();
  if (bot.sponsor !== null) return null;
  const count = signIns.filter((entry) => entry.bot === bot.id).length;
  return <div role="alert" data-bot-blocked={bot.id} className="flex flex-wrap items-start gap-3 rounded-xl bg-[color-mix(in_oklab,#dc6803_9%,transparent)] px-3 py-2.5 shadow-[inset_0_0_0_1px_color-mix(in_oklab,#dc6803_35%,transparent)]">
    <span className="flex min-w-0 flex-1 basis-72 flex-col gap-0.5">
      <span className="text-body font-medium text-foreground">Sign-ins blocked: its sponsor {bot.formerSponsor} {bot.lapse ?? 'is gone'}</span>
      <span className="text-caption text-muted-foreground">A bot’s sponsor must be an Admin or Owner. Its {count} sign-ins are kept and refused; they expire {bot.expires ?? 'in 30 days'}, 30 days after it was blocked, unless an Admin or Owner takes it over, which restores them. Owners and Admins were told in Needs you and are told again a week before.</span>
    </span>
    <Act reason={whyAccount(viewer.id, 'account.bots') === null ? null : 'Only an Admin or Owner takes a bot over'} variant="primary" onClick={() => {
      bots.set(bots.get().map((entry) => entry.id === bot.id ? { ...entry, sponsor: viewer.id, formerSponsor: null, lapse: null, expires: null } : entry));
      recordAudit({ actor: viewer.id, kind: 'bot', text: `Took over ${bot.name} as sponsor · its ${count} sign-ins work again` });
      say(`You sponsor ${bot.name} now · its sign-ins work again`);
    }}>Take it over</Act>
  </div>;
}

// ── Profile ──

export function BotProfileSection({ bot, sponsorView }: { bot: Bot; sponsorView: boolean }) {
  const viewer = useViewer();
  const [editing, setEditing] = useState(false);
  const manage = manageReason(viewer, bot);
  return <Section title="Profile" description={`Who ${bot.name} is: its name and handle, its avatar, its sponsor (an Admin or Owner, whose name goes on its actions) and notes for whoever manages it.`}
    actions={<Act reason={manage} variant="secondary" leadingIcon={glyph(Edit01)} onClick={() => setEditing(true)}>Edit profile</Act>}>
    <SettingRows label="Profile">
      <SettingRow title={<span data-bot-profile={bot.id} className="flex flex-wrap items-center gap-2"><Avatar userId={bot.id} size={28} />{bot.name}<span className="font-mono text-caption text-muted-foreground">@{bot.id}</span><Pill tone="violet">Bot</Pill>{bot.sponsor ? <Pill tone="green">Active</Pill> : <Pill tone="amber">Sign-ins blocked</Pill>}</span>}
        description={bot.description} />
      <SettingRow media={glyph(User01)} title="Sponsor"
        description={bot.sponsor ? <span className="inline-flex flex-wrap items-center gap-1">Its actions read “{actorLabel(bot.id)}”. Created {bot.created}.</span> : `No sponsor: ${bot.formerSponsor} ${bot.lapse ?? 'is gone'}. Its sign-ins are blocked until an Admin or Owner takes it over.`}>
        {bot.sponsor ? <UserName userId={bot.sponsor} you={viewer.id} /> : <Pill tone="amber">None</Pill>}{sponsorView ? <Pill tone="violet">You sponsor it</Pill> : null}
      </SettingRow>
      <SettingRow media={glyph(MessageChatSquare)} title="Notes" description={bot.notes || 'No notes yet.'} />
    </SettingRows>
    {editing ? <EditBotDialog bot={bot} onClose={() => setEditing(false)} /> : null}
  </Section>;
}

function EditBotDialog({ bot, onClose }: { bot: Bot; onClose(): void }) {
  const viewer = useViewer();
  const { say } = useMock();
  const [name, setName] = useState(bot.name);
  const [description, setDescription] = useState(bot.description);
  const [notes, setNotes] = useState(bot.notes);
  const [color, setColor] = useState(bot.color);
  const [tried, setTried] = useState(false);
  const [done, setDone] = useState(false);
  const nameError = !name.trim() ? 'Give it a name' : bots.get().some((entry) => entry.id !== bot.id && entry.name.toLowerCase() === name.trim().toLowerCase()) ? `Another bot is called ${name.trim()}` : null;
  const descriptionError = description.trim() ? null : 'Say what it does: people see this next to its actions';
  const save = (): void => {
    setTried(true);
    if (nameError || descriptionError) return;
    const words = name.trim().split(/\s+/);
    bots.set(bots.get().map((entry) => entry.id === bot.id ? { ...entry, name: name.trim(), first: name.trim(), initials: words.map((word) => word.charAt(0).toUpperCase()).join('').slice(0, 2), description: description.trim(), notes: notes.trim(), color } : entry));
    recordAudit({ actor: viewer.id, kind: 'bot', text: `Edited ${bot.name}’s profile${name.trim() !== bot.name ? ` · renamed to ${name.trim()}` : ''}` });
    say(`Saved ${name.trim()}’s profile`);
    setDone(true);
  };
  return <FlowDialog id="bot-edit" title={done ? `${name.trim()} is saved` : `Edit ${bot.name}`} description={done ? undefined : 'Its handle is fixed: commits, audit entries and sign-ins use it.'} done={done} onClose={onClose}
    footer={done ? <DoneButton onClose={onClose} /> : <><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save}>Save</Button></>}>
    {done ? <FlowSuccess title="Profile saved">Its actions now read “{actorLabel(bot.id)}”. Earlier entries keep the name they had.</FlowSuccess> : <>
      <InputGroup className="w-full">
        <InputField index={0} label="Name" value={name} onChange={setName} error={tried && nameError ? nameError : undefined} />
        <InputField index={1} label="Handle" value={bot.id} onChange={() => undefined} readOnly disabled />
      </InputGroup>
      <TextArea label="What it does" rows={2} value={description} onChange={setDescription} error={tried && descriptionError ? descriptionError : undefined} />
      <TextArea label="Notes" rows={3} value={notes} onChange={setNotes} placeholder="Who to ask, what not to give it" />
      <div className="flex flex-col gap-1.5"><span className="text-caption font-medium text-foreground">Avatar</span>
        <div role="radiogroup" aria-label="Avatar colour" className="flex flex-wrap items-center gap-2">
          {BOT_COLORS.map((entry) => <button key={entry} type="button" role="radio" aria-checked={entry === color} aria-label={`Colour ${entry}`} onClick={() => setColor(entry)}
            className={`flex size-8 items-center justify-center rounded-[28%] text-[12px] font-semibold text-white ${entry === color ? 'ring-2 ring-[#6B97FF] ring-offset-2 ring-offset-background' : ''}`} style={{ background: entry }}>{bot.initials}</button>)}
        </div></div>
    </>}
  </FlowDialog>;
}

// ── Roles and projects ──

/** The project roles `editorId` may give in `projectId`: none when they can't manage its members (with why), and only
 * roles that are no more than their own there. */
export function roleChoices(editorId: string, projectId: string, roles: readonly ProjectRole[]): { refused: string | null; allowed: ReadonlyArray<{ role: ProjectRole; above: boolean }> } {
  const refused = whyMembers(editorId, projectId);
  const mine = projectRoleOf(editorId, projectId);
  return { refused, allowed: roles.map((role) => ({ role, above: !mine || [...role.allowed].some((action) => !mine.allowed.has(action)) })) };
}

/** One row per project the editor can see: the bot's project role there, editable within the editor's own. */
export function BotRolePicker({ botName, value, onChange }: { botName: string; value: Readonly<Record<string, string>>; onChange(next: Readonly<Record<string, string>>): void }) {
  const viewer = useViewer();
  const roles = useRoles();
  const projects = ACTIVE_PROJECTS.filter((project) => visibleProjects(viewer.id).has(project.id));
  return <div className="flex flex-col gap-2" data-bot-roles="">
    {projects.map((project) => {
      const { refused, allowed } = roleChoices(viewer.id, project.id, roles);
      const mine = projectRoleOf(viewer.id, project.id);
      const current = value[project.id];
      const above = allowed.filter((entry) => entry.above).map((entry) => entry.role.name);
      return <div key={project.id} className="flex flex-col gap-1 rounded-xl px-3 py-2 shadow-[inset_0_0_0_1px_var(--border)]" data-role-project={project.id}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="text-body font-medium text-foreground">{project.name}</span>
          {refused ? <Pill tone="amber">{current ? roleName(current) : 'Not a member'} · can’t change</Pill>
            : <Select value={current ?? 'none'} onValueChange={(next) => { const map = { ...value }; if (next === 'none') delete map[project.id]; else map[project.id] = next; onChange(map); }}>
              <SelectTrigger aria-label={`${botName}’s project role in ${project.name}`} />
              <SelectContent>
                <SelectItem value="none" index={0}>Not a member</SelectItem>
                {allowed.map((entry, position) => <SelectItem key={entry.role.id} value={entry.role.id} index={position + 1} disabled={entry.above}>{entry.above ? `${entry.role.name} · above your role` : entry.role.name}</SelectItem>)}
              </SelectContent>
            </Select>}
        </div>
        {refused ? <span role="alert" className="text-caption text-destructive">{refused}. Ask one of {project.name}’s Leads.</span>
          : above.length ? <Hint>{above.join(', ')} {above.length === 1 ? 'is' : 'are'} more than your own role here ({mine?.name}), so you can’t give {above.length === 1 ? 'it' : 'them'}.</Hint> : null}
      </div>;
    })}
  </div>;
}

export function BotRolesSection({ bot }: { bot: Bot }) {
  const viewer = useViewer();
  const live = memberships.use();
  useRoles();
  const [editing, setEditing] = useState(false);
  const manage = manageReason(viewer, bot);
  const seen = visibleProjects(viewer.id);
  const own = live.filter((entry) => entry.userId === bot.id && seen.has(entry.projectId));
  const hidden = live.filter((entry) => entry.userId === bot.id && !seen.has(entry.projectId)).length;
  return <Section title="Roles and projects" readOnly={manage}
    description={`Like a person’s: ${bot.name} sees only these projects and may do what each project role allows. You give project roles within your own: only in projects whose members you manage, and none above your own role there.`}
    actions={<Act reason={manage} variant="secondary" leadingIcon={glyph(Edit01)} onClick={() => setEditing(true)}>Edit roles</Act>}>
    <SettingRows label="Roles and projects">
      <SettingRow media={glyph(ShieldTick)} title={<span className="inline-flex items-center gap-2">Account role<Pill>Member</Pill></span>} description="Bots are Member at most: never Admin or Owner, so no account page is theirs to edit.">
        <Act reason="A bot’s account role is Member, fixed" variant="ghost">Change</Act>
      </SettingRow>
      {own.map((entry) => <SettingRow key={entry.projectId} title={<span data-bot-role={entry.projectId} className="inline-flex items-center gap-2">{projectName(entry.projectId)}<Pill tone="teal">{roleName(entry.roleId)}</Pill></span>}
        description={projectRoleOf(bot.id, entry.projectId)?.description} />)}
    </SettingRows>
    {own.length ? null : <Note>In no project you can see.</Note>}
    {hidden ? <Note>{hidden} more {hidden === 1 ? 'project' : 'projects'} you aren’t in.</Note> : null}
    {editing ? <BotRolesDialog bot={bot} onClose={() => setEditing(false)} /> : null}
  </Section>;
}

export function BotRolesDialog({ bot, onClose }: { bot: Bot; onClose(): void }) {
  const viewer = useViewer();
  const { say } = useMock();
  const seen = visibleProjects(viewer.id);
  const [draft, setDraft] = useState<Readonly<Record<string, string>>>(() => Object.fromEntries(memberships.get().filter((entry) => entry.userId === bot.id && seen.has(entry.projectId)).map((entry) => [entry.projectId, entry.roleId])));
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const save = (): void => {
    const hidden = memberships.get().some((entry) => entry.userId === bot.id && !seen.has(entry.projectId));
    if (!Object.keys(draft).length && !hidden) { setError(`${bot.name} needs at least one project to do anything. To stop it instead, revoke its sign-ins.`); return; }
    const changes: string[] = [];
    for (const projectId of seen) {
      if (whyMembers(viewer.id, projectId) !== null) continue;
      const before = memberships.get().find((entry) => entry.userId === bot.id && entry.projectId === projectId)?.roleId ?? null;
      const after = draft[projectId] ?? null;
      if (before === after) continue;
      setMembership(bot.id, projectId, after);
      changes.push(after ? `${roleName(after)} in ${projectName(projectId)}${before ? ` (was ${roleName(before)})` : ''}` : `removed from ${projectName(projectId)}`);
    }
    if (!changes.length) { setError('Nothing changed yet: pick a different role, or Cancel.'); return; }
    recordAudit({ actor: viewer.id, kind: 'team', text: `Set ${actorLabel(bot.id)}’s projects: ${changes.join(', ')}` });
    say(`Saved ${bot.name}’s roles`);
    setDone(changes.join(' · '));
  };
  return <FlowDialog id="bot-roles" title={done ? `${bot.name}’s roles are saved` : `${bot.name}’s roles`} description={done ? undefined : 'Its account role stays Member. Removing it from a project releases its handles there and narrows every sign-in’s slice.'} done={Boolean(done)} onClose={onClose}
    footer={done ? <DoneButton onClose={onClose} /> : <><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save}>Save roles</Button></>}>
    {done ? <FlowSuccess title="Roles saved">{done}. In the audit log.</FlowSuccess> : <>
      <BotRolePicker botName={bot.name} value={draft} onChange={(next) => { setDraft(next); setError(null); }} />
      {error ? <FlowError>{error}</FlowError> : null}
    </>}
  </FlowDialog>;
}

// ── Sign-ins ──

/** A sign-in's slice: the bot's projects and capabilities it may use (granted dark, withheld struck through). */
function SliceView({ projects, capabilities, all }: { projects: readonly string[]; capabilities: readonly Capability[]; all: readonly string[] }) {
  return <div className="mt-1 flex flex-col gap-1 text-caption">
    <span className="flex flex-wrap items-center gap-1"><span className="w-20 shrink-0 text-muted-foreground">Projects</span>{all.map((id) => <span key={id} className={`rounded-full px-2 py-px ${projects.includes(id) ? 'bg-active text-foreground' : 'text-muted-foreground line-through shadow-[inset_0_0_0_1px_var(--border)]'}`}>{projectName(id)}</span>)}</span>
    <span className="flex flex-wrap items-center gap-1"><span className="w-20 shrink-0 text-muted-foreground">Capabilities</span>{CAPABILITIES.map((capability) => <span key={capability} className={`rounded-full px-2 py-px ${capabilities.includes(capability) ? 'bg-active text-foreground' : 'text-muted-foreground line-through shadow-[inset_0_0_0_1px_var(--border)]'}`}>{capability}</span>)}</span>
  </div>;
}

/** The bot's projects and capabilities a sign-in gets; its memberships and project roles are the ceiling. */
function SlicePicker({ all, projects, capabilities, onProjects, onCapabilities }: { all: readonly string[]; projects: readonly string[]; capabilities: readonly Capability[]; onProjects(next: readonly string[]): void; onCapabilities(next: readonly Capability[]): void }) {
  return <div className="flex flex-col gap-2" data-slice-picker="">
    <span className="text-caption font-medium text-foreground">Projects (its memberships are the ceiling)</span>
    <ChipPicker label="Projects" options={all.map((id) => ({ id, label: projectName(id) }))} picked={new Set(projects)} onChange={(next) => onProjects(all.filter((id) => next.has(id)))} />
    <span className="text-caption font-medium text-foreground">Capabilities (its project roles are the ceiling)</span>
    <ChipPicker label="Capabilities" options={CAPABILITIES.map((capability) => ({ id: capability, label: capability }))} picked={new Set(capabilities)} onChange={(next) => onCapabilities(CAPABILITIES.filter((capability) => next.has(capability)))} />
  </div>;
}

function sliceError(projects: readonly string[], capabilities: readonly Capability[]): string | null {
  if (!projects.length) return 'Pick at least one project: a sign-in with none can’t do anything.';
  if (!capabilities.length) return 'Pick at least one capability; “read” is the least.';
  return null;
}

export function BotSignInsSection({ bot }: { bot: Bot }) {
  const viewer = useViewer();
  const signIns = botSignIns.use();
  memberships.use();
  const [flow, setFlow] = useState<'connect' | 'secret' | null>(null);
  const [slicing, setSlicing] = useState<BotSignIn | null>(null);
  const [revoking, setRevoking] = useState<BotSignIn | null>(null);
  const staff = whyAccount(viewer.id, 'account.bots') === null;
  const blocked = bot.sponsor === null ? `${bot.name}’s sign-ins are blocked until an Admin takes it over` : null;
  const manage = manageReason(viewer, bot);
  const connect = manage ?? blocked;
  const secret = staff ? blocked : 'Only Owners and Admins create client secrets';
  const mine = signIns.filter((entry) => entry.bot === bot.id);
  const all = projectsOf(bot.id);
  return <Section title="Sign-ins" readOnly={manage}
    description={`${bot.name} acts only over MCP, as itself: its actions read “${actorLabel(bot.id, 'Claude Code')}”. Connect a client: its MCP client starts the normal sign-in and you approve “Connect as ${bot.name}” with your passkey; no secret is copied. Client secret (Owners and Admins only): made with a passkey, shown once, exchanged for short-lived tokens, for scripts, CI and cron. Each is a slice of the bot’s projects and capabilities.`}
    actions={<><Act reason={connect} variant="primary" leadingIcon={glyph(Link03)} onClick={() => setFlow('connect')}>Connect a client</Act><Act reason={secret} variant="secondary" leadingIcon={glyph(Key01)} onClick={() => setFlow('secret')}>Create client secret</Act></>}>
    {mine.length ? <SettingRows label="Sign-ins">
      {mine.map((entry) => <SettingRow key={entry.id} media={glyph(entry.kind === 'connected' ? Link03 : Key01)}
        title={<span data-sign-in={entry.id} className="inline-flex flex-wrap items-center gap-2">{entry.label}<Pill tone={entry.kind === 'connected' ? 'blue' : 'teal'}>{entry.kind === 'connected' ? 'Connected client' : 'Client secret'}</Pill>{blocked ? <Pill tone="amber">Blocked</Pill> : null}</span>}
        description={<>{entry.detail} · created {entry.created} by {entry.by} · last used {entry.lastUsed}</>}
        extra={<SliceView projects={entry.projects} capabilities={entry.capabilities} all={all} />}>
        <Act reason={manage ?? blocked} variant="ghost" aria-label={`Edit the slice of ${entry.label}`} onClick={() => setSlicing(entry)}>Edit slice</Act>
        <Act reason={manage} variant="ghost" aria-label={`Revoke ${entry.label}`} onClick={() => setRevoking(entry)}>Revoke</Act>
      </SettingRow>)}
    </SettingRows> : <Note>Not signed in anywhere yet: connect a client or create a client secret.</Note>}
    {flow === 'connect' ? <ConnectClientWizard bot={bot} onClose={() => setFlow(null)} /> : null}
    {flow === 'secret' ? <ClientSecretWizard bot={bot} onClose={() => setFlow(null)} /> : null}
    {slicing ? <SliceDialog bot={bot} entry={slicing} onClose={() => setSlicing(null)} /> : null}
    {revoking ? <RevokeDialog bot={bot} entry={revoking} onClose={() => setRevoking(null)} /> : null}
  </Section>;
}

/** The code the mock's waiting MCP client shows. */
const CLIENT_CODE = 'KTRW-4821';
const CLIENT = 'Claude Code on build-02';

/** Its MCP client ran the normal MCP sign-in and shows a code; the sponsor or an Admin enters it here, picks “Connect as
 * the bot”, its slice, and approves with their passkey. The client gets the bot's tokens; no secret is copied. */
export function ConnectClientWizard({ bot, onClose }: { bot: Bot; onClose(): void }) {
  const viewer = useViewer();
  const { say } = useMock();
  const passkey = usePasskey();
  const all = projectsOf(bot.id);
  const [step, setStep] = useState(0);
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<string | null>(null);
  const [as, setAs] = useState('bot');
  const [projects, setProjects] = useState<readonly string[]>(all);
  const [capabilities, setCapabilities] = useState<readonly Capability[]>(['read', 'comment', 'prompt']);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const steps = ['Code', 'Connect as', 'Slice', 'Passkey'];
  const next = (): void => {
    if (step === 0) {
      const typed = code.trim().toUpperCase();
      if (!/^[A-Z]{4}-\d{4}$/.test(typed)) { setCodeError('Codes look like KTRW-4821: four letters, a dash, four digits'); return; }
      if (typed !== CLIENT_CODE) { setCodeError('No sign-in is waiting with that code. Codes expire after 10 minutes: run /mcp in the client again for a new one.'); return; }
      setCodeError(null); setStep(1); return;
    }
    if (step === 1) { setStep(as === 'me' ? 3 : 2); return; }
    if (step === 2) { const reason = sliceError(projects, capabilities); setError(reason); if (!reason) setStep(3); return; }
    passkey.confirm(() => {
      if (as === 'me') { say(`${CLIENT} now acts as you (${viewer.first} via Claude Code)`); setDone(true); return; }
      botSignIns.set([...botSignIns.get(), { id: `bs-${Date.now()}`, bot: bot.id, kind: 'connected', label: CLIENT, detail: `MCP client · approved in ${viewer.first}’s browser`, by: viewer.first, created: 'just now', lastUsed: 'just now', projects, capabilities }]);
      recordAudit({ actor: viewer.id, kind: 'bot', text: `Connected ${CLIENT} as ${bot.name} · ${projects.map(projectName).join(', ')} · ${capabilities.join(', ')} · approved with ${passkeyLabel(viewer.id)}` });
      say(`${CLIENT} is connected as ${bot.name}`);
      setDone(true);
    });
  };
  return <FlowDialog id="bot-connect" title={done ? `${CLIENT} is connected` : `Connect a client as ${bot.name}`} description={done ? undefined : 'crumbco.gitspace.sh/mcp · consent'} steps={steps} step={step} done={done} onClose={() => { if (!passkey.waiting) onClose(); }}
    footer={done ? <DoneButton onClose={onClose} /> : <StepButtons step={step} onBack={() => { setError(null); setStep(step === 3 && as === 'me' ? 1 : step - 1); }} onCancel={onClose} next={next} busy={passkey.waiting} nextLabel={step === 3 ? 'Approve with passkey' : 'Next'} />}>
    {done ? <FlowSuccess title={as === 'me' ? `${CLIENT} acts as you` : `${CLIENT} acts as ${bot.name}`}>{as === 'me' ? 'It’s on your MCP clients page, a slice of your permissions.' : `Its actions read “${actorLabel(bot.id, 'Claude Code')}”. Revoke it from ${bot.name}’s sign-ins any time; it’s in the audit log.`}</FlowSuccess>
      : step === 0 ? <>
        <pre data-client-terminal="" className="overflow-x-auto rounded-[10px] bg-surface-2 px-3 py-2 font-mono text-[11.5px] leading-relaxed text-foreground/90">{`build-02 $ claude\n> /mcp  → crumbco · Authenticate\n  Open https://crumbco.gitspace.sh/connect\n  and enter ${CLIENT_CODE}   (expires in 10 min)`}</pre>
        <InputGroup className="w-full"><InputField index={0} label="Code the client shows" placeholder="ABCD-1234" value={code} onChange={(value) => { setCode(value); setCodeError(null); }} error={codeError ?? undefined} /></InputGroup>
        <Hint>The client started the sign-in itself; entering its code ties that request to this page. Nothing is pasted into the client.</Hint>
      </> : step === 1 ? <ChoiceCards label="Connect as" value={as} onChange={setAs} choices={[
        { id: 'bot', title: `Connect as ${bot.name}`, detail: `Its project roles, team resources only; ${bot.sponsor ? userOf(bot.sponsor).first : 'its sponsor'} stays its sponsor.`, icon: Link03 },
        { id: 'me', title: `Connect as ${viewer.first} (you)`, detail: 'Your own MCP client: a slice of your permissions, listed on your MCP clients page.', icon: User01 },
      ]} />
      : step === 2 ? <>
        <SlicePicker all={all} projects={projects} capabilities={capabilities} onProjects={(next) => { setProjects(next); setError(null); }} onCapabilities={(next) => { setCapabilities(next); setError(null); }} />
        {error ? <FlowError>{error}</FlowError> : null}
      </> : <>
        <Summary rows={[['Client', CLIENT], ['Acts as', as === 'me' ? `${viewer.first} via Claude Code` : actorLabel(bot.id, 'Claude Code')], ...(as === 'me' ? [] : [['Projects', projects.map(projectName).join(', ')] as const, ['Capabilities', capabilities.join(', ')] as const])]} />
        <PasskeyStep userId={viewer.id} what={`connecting ${CLIENT}`} waiting={passkey.waiting} />
      </>}
  </FlowDialog>;
}

/** A client ID and secret for scripts, CI and cron: label, slice, passkey, then the secret shown once. The bot exchanges
 * it for short-lived access tokens (OAuth client_credentials). */
export function ClientSecretWizard({ bot, onClose }: { bot: Bot; onClose(): void }) {
  const viewer = useViewer();
  const { say } = useMock();
  const passkey = usePasskey();
  const all = projectsOf(bot.id);
  const [step, setStep] = useState(0);
  const [label, setLabel] = useState('');
  const [labelError, setLabelError] = useState<string | null>(null);
  const [projects, setProjects] = useState<readonly string[]>(all.slice(0, 1));
  const [capabilities, setCapabilities] = useState<readonly Capability[]>(['read', 'comment']);
  const [error, setError] = useState<string | null>(null);
  const [secret, setSecret] = useState<{ id: string; value: string } | null>(null);
  const [done, setDone] = useState(false);
  const steps = ['Label', 'Slice', 'Passkey', 'Copy secret'];
  const next = (): void => {
    if (step === 0) {
      const typed = label.trim();
      const reason = !typed ? 'Give it a label: where it runs, like nightly-ci'
        : !/^[a-z0-9][a-z0-9-]*$/.test(typed) ? 'Lowercase letters, digits and hyphens, like nightly-ci'
        : botSignIns.get().some((entry) => entry.bot === bot.id && entry.label === typed) ? `${bot.name} already has ${typed}: pick another label, or revoke that one first` : null;
      setLabelError(reason); if (!reason) setStep(1); return;
    }
    if (step === 1) { const reason = sliceError(projects, capabilities); setError(reason); if (!reason) setStep(2); return; }
    if (step === 2) {
      passkey.confirm(() => {
        const id = `gsc_${bot.id.slice(0, 3)}_9Fk2Lw7Q`;
        botSignIns.set([...botSignIns.get(), { id: `bs-${Date.now()}`, bot: bot.id, kind: 'secret', label: label.trim(), detail: `Client ID ${id.slice(0, 12)}…`, by: viewer.first, created: 'just now', lastUsed: 'never', projects, capabilities }]);
        recordAudit({ actor: viewer.id, kind: 'bot', text: `Created client secret ${label.trim()} for ${actorLabel(bot.id)} · shown once · confirmed with ${passkeyLabel(viewer.id)}` });
        setSecret({ id, value: MOCK_CLIENT_SECRET });
        setStep(3);
      });
      return;
    }
    say(`${label.trim()} is ready · ${bot.name} can sign in with it`);
    setDone(true);
  };
  return <FlowDialog id="bot-secret" title={done ? `${label.trim()} is ready` : step === 3 ? `Copy ${label.trim()}’s secret` : `Client secret for ${bot.name}`} description={done ? undefined : 'For scripts, CI and cron. Making it needs your passkey; the secret is shown once.'} steps={steps} step={step} done={done} onClose={() => { if (!passkey.waiting) onClose(); }}
    footer={done ? <DoneButton onClose={onClose} /> : step === 3 ? <Button variant="primary" onClick={next}>I’ve copied it</Button>
      : <StepButtons step={step} onBack={() => { setError(null); setStep(step - 1); }} onCancel={onClose} next={next} busy={passkey.waiting} nextLabel={step === 2 ? 'Create with passkey' : 'Next'} />}>
    {done ? <FlowSuccess title={`${bot.name} signs in with ${label.trim()}`}>Store the secret in your CI’s secrets as GITSPACE_CLIENT_SECRET. Its slice: {projects.map(projectName).join(', ')} · {capabilities.join(', ')}. In the audit log.</FlowSuccess>
      : step === 0 ? <>
        <InputGroup className="w-full"><InputField index={0} label="Label" placeholder="nightly-ci" value={label} onChange={(value) => { setLabel(value); setLabelError(null); }} error={labelError ?? undefined} /></InputGroup>
        <Hint>Where it will run, so whoever revokes it later knows what stops.</Hint>
      </> : step === 1 ? <>
        <SlicePicker all={all} projects={projects} capabilities={capabilities} onProjects={(next) => { setProjects(next); setError(null); }} onCapabilities={(next) => { setCapabilities(next); setError(null); }} />
        {error ? <FlowError>{error}</FlowError> : null}
      </> : step === 2 ? <>
        <Summary rows={[['Label', label.trim()], ['Signs in as', actorLabel(bot.id)], ['Projects', projects.map(projectName).join(', ')], ['Capabilities', capabilities.join(', ')], ['Tokens', 'Access tokens last an hour']]} />
        <PasskeyStep userId={viewer.id} what={`the client secret for ${bot.name}`} waiting={passkey.waiting} />
      </> : secret ? <>
        <InputCopy label="Client ID" value={secret.id} />
        <ShownOnce label="Client secret" value={secret.value} />
        <pre className="overflow-x-auto rounded-[10px] bg-surface-2 px-2.5 py-2 font-mono text-[11px] text-foreground/90">{`POST https://crumbco.gitspace.sh/oauth/token\ngrant_type=client_credentials\nclient_id=${secret.id}\nclient_secret=$GITSPACE_CLIENT_SECRET\n→ { "access_token": "…", "expires_in": 3600 }`}</pre>
      </> : null}
  </FlowDialog>;
}

function SliceDialog({ bot, entry, onClose }: { bot: Bot; entry: BotSignIn; onClose(): void }) {
  const viewer = useViewer();
  const { say } = useMock();
  const all = projectsOf(bot.id);
  const [projects, setProjects] = useState<readonly string[]>(entry.projects);
  const [capabilities, setCapabilities] = useState<readonly Capability[]>(entry.capabilities);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const save = (): void => {
    const reason = sliceError(projects, capabilities);
    setError(reason);
    if (reason) return;
    botSignIns.set(botSignIns.get().map((candidate) => candidate.id === entry.id ? { ...candidate, projects, capabilities } : candidate));
    recordAudit({ actor: viewer.id, kind: 'bot', text: `Changed the slice of ${actorLabel(bot.id)}’s ${entry.label} to ${projects.map(projectName).join(', ')} · ${capabilities.join(', ')}` });
    say(`${entry.label} now has ${capabilities.length} capabilities in ${projects.length} ${projects.length === 1 ? 'project' : 'projects'}`);
    setDone(true);
  };
  return <FlowDialog id="bot-slice" title={done ? `${entry.label}’s slice is saved` : `Slice of ${entry.label}`} description={done ? undefined : `What ${bot.name} may do when it signs in with this ${entry.kind === 'connected' ? 'connected client' : 'client secret'}. Its next token carries the new slice; one it holds now lasts at most an hour.`} done={done} onClose={onClose}
    footer={done ? <DoneButton onClose={onClose} /> : <><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save}>Save slice</Button></>}>
    {done ? <FlowSuccess title="Slice saved">{projects.map(projectName).join(', ')} · {capabilities.join(', ')}. In the audit log.</FlowSuccess> : <>
      <SlicePicker all={all} projects={projects} capabilities={capabilities} onProjects={(next) => { setProjects(next); setError(null); }} onCapabilities={(next) => { setCapabilities(next); setError(null); }} />
      {error ? <FlowError>{error}</FlowError> : null}
    </>}
  </FlowDialog>;
}

function RevokeDialog({ bot, entry, onClose }: { bot: Bot; entry: BotSignIn; onClose(): void }) {
  const viewer = useViewer();
  const { say } = useMock();
  const [done, setDone] = useState(false);
  const what = entry.kind === 'connected' ? 'connected client' : 'client secret';
  const revoke = (): void => {
    botSignIns.set(botSignIns.get().filter((candidate) => candidate.id !== entry.id));
    recordAudit({ actor: viewer.id, kind: 'bot', text: `Revoked ${actorLabel(bot.id)}’s ${what} ${entry.label}` });
    say(`Revoked ${entry.label} · ${bot.name} can’t sign in with it any more`);
    setDone(true);
  };
  return <FlowDialog id="bot-revoke" wide={false} title={done ? `${entry.label} is revoked` : `Revoke ${entry.label}?`} done={done} onClose={onClose}
    description={done ? undefined : `${bot.name} can’t sign in with this ${what} any more; the token it holds stops working within a minute.${entry.kind === 'secret' ? ' Whatever runs with it (CI, cron) starts failing to sign in.' : ' The client has to sign in again to come back.'}`}
    footer={done ? <DoneButton onClose={onClose} /> : <><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="primary" leadingIcon={glyph(Trash01)} onClick={revoke}>Revoke</Button></>}>
    {done ? <FlowSuccess title={`${bot.name} can’t sign in with ${entry.label}`}>In the audit log.</FlowSuccess> : <Summary rows={[['Sign-in', `${entry.label} · ${entry.kind === 'connected' ? 'Connected client' : 'Client secret'}`], ['Created', `${entry.created} by ${entry.by}`], ['Last used', entry.lastUsed]]} />}
  </FlowDialog>;
}

// ── Git identity ──

export function BotGitSection({ bot }: { bot: Bot }) {
  const viewer = useViewer();
  const all = botGit.use();
  const [flow, setFlow] = useState<'author' | 'machine' | 'app' | null>(null);
  const manage = manageReason(viewer, bot);
  const git = gitOf(bot, all);
  return <Section title="Git identity" readOnly={manage}
    description={`${bot.name} is the commit author of turns it starts; GitSpace is the committer. Its pull requests reach GitHub through the team’s GitHub App, or through its own GitHub account (a machine user) connected with a fine-grained token.`}>
    <SettingRows label="Git identity">
      <SettingRow media={glyph(GitCommit)} title="Commit author" description={<span data-bot-author="" className="font-mono">{git.author} &lt;{git.email}&gt;</span>}>
        {git.email === defaultEmail(bot.id) ? <Pill>Default</Pill> : null}
        <Act reason={manage} variant="ghost" aria-label="Edit the commit author" onClick={() => setFlow('author')}>Edit</Act>
      </SettingRow>
      <SettingRow media={glyph(GitPullRequest)} title={<span data-bot-route={git.route} className="inline-flex flex-wrap items-center gap-2">How it reaches GitHub<Pill tone={git.route === 'app' ? 'gray' : 'blue'}>{git.route === 'app' ? 'Team’s GitHub App' : `Its own account · ${git.machine?.login}`}</Pill></span>}
        description={git.route === 'app' ? 'Pull requests show as the App’s bot (crumbco-gitspace[bot]); commits are authored as this bot.' : `Pull requests show as ${git.machine?.login}; commits are authored as this bot. Token: ${git.machine?.scopes.join(', ')} · expires ${git.machine?.expires}.`}>
        {git.route === 'app' ? <Act reason={manage} variant="secondary" leadingIcon={glyph(GitBranch01)} onClick={() => setFlow('machine')}>Use its own GitHub account</Act>
          : <><Act reason={manage} variant="ghost" onClick={() => setFlow('machine')}>Replace token</Act><Act reason={manage} variant="ghost" onClick={() => setFlow('app')}>Use the GitHub App</Act></>}
      </SettingRow>
    </SettingRows>
    {flow === 'author' ? <AuthorDialog bot={bot} onClose={() => setFlow(null)} /> : null}
    {flow === 'machine' ? <MachineUserWizard bot={bot} onClose={() => setFlow(null)} /> : null}
    {flow === 'app' ? <UseAppDialog bot={bot} onClose={() => setFlow(null)} /> : null}
  </Section>;
}

function AuthorDialog({ bot, onClose }: { bot: Bot; onClose(): void }) {
  const viewer = useViewer();
  const { say } = useMock();
  const git = gitOf(bot, botGit.get());
  const [author, setAuthor] = useState(git.author);
  const [email, setEmail] = useState(git.email);
  const [tried, setTried] = useState(false);
  const [done, setDone] = useState(false);
  const authorError = author.trim() ? null : 'Give it an author name';
  const mailError = emailError(email);
  const save = (): void => {
    setTried(true);
    if (authorError || mailError) return;
    botGit.set({ ...botGit.get(), [bot.id]: { ...git, author: author.trim(), email: email.trim() } });
    recordAudit({ actor: viewer.id, kind: 'bot', text: `Set ${actorLabel(bot.id)}’s commit author to ${author.trim()} <${email.trim()}>` });
    say(`${bot.name} commits as ${author.trim()} <${email.trim()}>`);
    setDone(true);
  };
  return <FlowDialog id="bot-author" title={done ? 'Commit author saved' : `${bot.name}’s commit author`} description={done ? undefined : 'Used on commits from turns it starts. GitHub links a commit to an account by this email; the default isn’t anyone’s.'} done={done} onClose={onClose}
    footer={done ? <DoneButton onClose={onClose} /> : <><Button variant="ghost" onClick={() => { setAuthor(bot.name); setEmail(defaultEmail(bot.id)); }}>Use the default</Button><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save}>Save</Button></>}>
    {done ? <FlowSuccess title={`${author.trim()} <${email.trim()}>`}>On its next commit; earlier ones keep their author.</FlowSuccess> : <>
      <InputGroup className="w-full">
        <InputField index={0} label="Author name" value={author} onChange={setAuthor} error={tried && authorError ? authorError : undefined} />
        <InputField index={1} label="Author email" value={email} onChange={setEmail} error={tried && mailError ? mailError : undefined} />
      </InputGroup>
      <Hint>Default: {bot.name} &lt;{defaultEmail(bot.id)}&gt;. With its own GitHub account, use that account’s noreply email so its commits link to it.</Hint>
    </>}
  </FlowDialog>;
}

function MachineUserWizard({ bot, onClose }: { bot: Bot; onClose(): void }) {
  const viewer = useViewer();
  const { say } = useMock();
  const git = gitOf(bot, botGit.get());
  const [step, setStep] = useState(0);
  const [login, setLogin] = useState(git.machine?.login ?? '');
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<TokenCheck | null>(null);
  const [done, setDone] = useState(false);
  const steps = ['Account', 'Token', 'Check permissions'];
  const next = (): void => {
    if (step === 0) {
      const typed = login.trim();
      const reason = !typed ? 'Name its GitHub account, like crumbco-release' : !/^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i.test(typed) ? 'GitHub usernames are letters, digits and single hyphens, at most 39 characters' : null;
      setError(reason); if (!reason) setStep(1); return;
    }
    if (step === 1) {
      const typed = token.trim();
      const reason = !typed ? 'Paste the token' : typed.startsWith(GITHUB_CLASSIC_TOKEN) ? 'That’s a classic token, which reaches every repository the account can. Create a fine-grained one (github_pat_…) limited to the team’s repositories.' : !/^github_pat_\w+$/.test(typed) ? 'Fine-grained tokens start with github_pat_' : null;
      setError(reason);
      if (reason) return;
      setStep(2); setChecking(true); setResult(null);
      window.setTimeout(() => { setChecking(false); setResult(checkToken(typed)); }, 900);
      return;
    }
    if (result?.kind !== 'ok') return;
    botGit.set({ ...botGit.get(), [bot.id]: { ...git, route: 'machine', machine: { login: login.trim(), scopes: result.scopes, expires: result.expires } } });
    recordAudit({ actor: viewer.id, kind: 'bot', text: `Connected GitHub account ${login.trim()} to ${actorLabel(bot.id)} with a fine-grained token (${result.scopes.join(', ')})` });
    say(`${bot.name}’s pull requests now show as ${login.trim()}`);
    setDone(true);
  };
  const fix = result?.kind === 'missing' ? `The token is missing ${result.missing.join(' and ')}. On GitHub › Settings › Developer settings › Fine-grained tokens, open the token, set ${result.missing.map((scope) => scope.startsWith('pull') ? 'Pull requests' : 'Contents').join(' and ')} to “Read and write”, regenerate it and paste the new one.`
    : result?.kind === 'expired' ? `This token expired on ${result.on}. Regenerate it on GitHub (Fine-grained tokens › the token › Regenerate) and paste the new one.` : null;
  return <FlowDialog id="bot-machine-user" title={done ? `${bot.name} uses ${login.trim()}` : `${bot.name}’s own GitHub account`} description={done ? undefined : `A machine user: a GitHub account for the bot alone, invited to the team’s repositories. Its pull requests show as that account instead of the App’s bot.`} steps={steps} step={step} done={done} onClose={() => { if (!checking) onClose(); }}
    footer={done ? <DoneButton onClose={onClose} /> : step === 2 ? <><Button variant="ghost" disabled={checking} onClick={() => { setStep(1); setResult(null); }}>{fix ? 'Paste another token' : 'Back'}</Button><Button variant="primary" disabled={checking || result?.kind !== 'ok'} loading={checking} onClick={next}>Connect</Button></>
      : <StepButtons step={step} onBack={() => { setError(null); setStep(step - 1); }} onCancel={onClose} next={next} nextLabel={step === 1 ? 'Check permissions' : 'Next'} />}>
    {done ? <FlowSuccess title={`Pull requests show as ${login.trim()}`}>Commits are still authored as {gitOf(bot, botGit.get()).author}. The token expires {result?.kind === 'ok' ? result.expires : ''}; {bot.sponsor ? userOf(bot.sponsor).first : 'its sponsor'} is told a week before. In the audit log.</FlowSuccess>
      : step === 0 ? <>
        <InputGroup className="w-full"><InputField index={0} label="GitHub account" placeholder="crumbco-release" value={login} onChange={(value) => { setLogin(value); setError(null); }} error={error ?? undefined} /></InputGroup>
        <Hint>Invite it to the team’s repositories first, with Write access. GitHub’s terms allow one machine user per person or team that runs it.</Hint>
      </> : step === 1 ? <>
        <InputGroup className="w-full"><InputField index={0} label="Fine-grained token" placeholder="github_pat_…" value={token} onChange={(value) => { setToken(value); setError(null); }} error={error ?? undefined} /></InputGroup>
        <Hint>Signed in as {login.trim()} on GitHub: Settings › Developer settings › Fine-grained tokens › Generate. Resource owner: the team’s organisation; repositories: the ones it works in; permissions: Contents and Pull requests “Read and write”.</Hint>
      </> : <>
        <div role="list" aria-label="Permissions" data-token-check={checking ? 'checking' : result?.kind ?? ''} className="flex flex-col gap-1.5 rounded-xl px-3 py-2.5 shadow-[inset_0_0_0_1px_var(--border)]">
          {checking ? <span className="text-caption text-muted-foreground">Checking the token with GitHub…</span>
            : result?.kind === 'expired' ? <span className="inline-flex items-center gap-2 text-body text-foreground"><XClose width={16} height={16} className="text-destructive" />Token expired on {result.on}</span>
            : NEEDED_SCOPES.map((scope) => {
              const has = result?.scopes.includes(scope) ?? false;
              return <span key={scope} role="listitem" className="inline-flex items-center gap-2 font-mono text-[12.5px] text-foreground">{has ? <Check width={16} height={16} className="text-[#079455]" /> : <XClose width={16} height={16} className="text-destructive" />}{scope}<span className="font-sans text-caption text-muted-foreground">{scope.startsWith('pull') ? 'open and update pull requests' : 'push branches'}</span></span>;
            })}
        </div>
        {fix ? <FlowError>{fix}</FlowError> : null}
        {result?.kind === 'ok' ? <Summary rows={[['Account', login.trim()], ['Permissions', result.scopes.join(', ')], ['Expires', result.expires]]} /> : null}
      </>}
  </FlowDialog>;
}

function UseAppDialog({ bot, onClose }: { bot: Bot; onClose(): void }) {
  const viewer = useViewer();
  const { say } = useMock();
  const git = gitOf(bot, botGit.get());
  const [done, setDone] = useState(false);
  const save = (): void => {
    botGit.set({ ...botGit.get(), [bot.id]: { ...git, route: 'app', machine: null } });
    recordAudit({ actor: viewer.id, kind: 'bot', text: `Disconnected GitHub account ${git.machine?.login ?? ''} from ${actorLabel(bot.id)} · back to the team’s GitHub App` });
    say(`${bot.name} reaches GitHub through the team’s App`);
    setDone(true);
  };
  return <FlowDialog id="bot-use-app" wide={false} title={done ? 'Back on the GitHub App' : `Switch ${bot.name} to the GitHub App?`} done={done} onClose={onClose}
    description={done ? undefined : `Its token for ${git.machine?.login} is deleted here. Its pull requests show as the App’s bot from now on; the ones it opened stay ${git.machine?.login}’s.`}
    footer={done ? <DoneButton onClose={onClose} /> : <><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save}>Use the GitHub App</Button></>}>
    {done ? <FlowSuccess title="Pull requests show as crumbco-gitspace[bot]">Revoke the token on GitHub too. In the audit log.</FlowSuccess> : <Note>Commits stay authored as {git.author} &lt;{git.email}&gt;.</Note>}
  </FlowDialog>;
}

// ── Activity and audit ──

const ACTIVITY_ICON = { turn: Activity, commit: GitCommit, comment: MessageChatSquare, phase: GitBranch01, 'sign-in': Key01 };
const ACTIVITY_LABEL: Readonly<Record<BotActivity['kind'], string>> = { turn: 'Turn', commit: 'Commit', comment: 'Comment', phase: 'Phase', 'sign-in': 'Sign-in' };

export function BotActivitySection({ bot }: { bot: Bot }) {
  const entries = BOT_ACTIVITY[bot.id] ?? [];
  return <Section title="Activity" description={`Recent turns ${bot.name} started and the commits it authored, newest first.`}>
    {entries.length ? <SettingRows label="Activity">{entries.map((entry) => <SettingRow key={entry.time + entry.text} media={glyph(ACTIVITY_ICON[entry.kind])}
      title={<span data-bot-activity={entry.kind} className="inline-flex flex-wrap items-center gap-2"><Pill tone={entry.kind === 'commit' ? 'blue' : 'gray'}>{ACTIVITY_LABEL[entry.kind]}</Pill>{entry.text}</span>}
      description={<span className="inline-flex flex-wrap items-center gap-x-2">{entry.workspace ? <span className="font-mono">{entry.workspace}</span> : null}{entry.sha ? <span className="font-mono text-foreground">{entry.sha}</span> : null}</span>}>
      <span className="text-caption tabular-nums text-muted-foreground">{entry.time}</span>
    </SettingRow>)}</SettingRows> : <Note>Nothing yet.</Note>}
  </Section>;
}

export function BotAuditSection({ bot }: { bot: Bot }) {
  const viewer = useViewer();
  const { navigate } = useMock();
  const rows = audit.use().filter((entry) => entry.actor === bot.id || entry.text.includes(bot.name)).slice(0, 6);
  const reason = whyAccount(viewer.id, 'account.audit');
  return <Section title="Audit" description={`What ${bot.name} did and what was done to it, with its sponsor at the time.`}
    actions={<Act reason={reason} variant="secondary" onClick={() => {
      // The audit page reads its `actor` filter from the address when it opens.
      const params = new URLSearchParams(window.location.search);
      params.set('actor', bot.id);
      window.history.replaceState(null, '', `${window.location.pathname}?${params}`);
      navigate('settings', { page: 'audit' });
    }}>Open in the audit log</Act>}>
    {rows.length ? <SettingRows label="Audit">{rows.map((entry) => <SettingRow key={entry.time + entry.text}
      title={<span data-bot-audit="" className="inline-flex flex-wrap items-center gap-2"><UserName userId={entry.actor} you={viewer.id} client={entry.client} /></span>} description={entry.text}>
      <span className="text-caption tabular-nums text-muted-foreground">{entry.time}</span>
    </SettingRow>)}</SettingRows> : <Note>No entries yet.</Note>}
  </Section>;
}
