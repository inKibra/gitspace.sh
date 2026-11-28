// The You pages, parameterised by principal (`info.target`): profile, Git identity (author, your own SSH key and GitHub
// account for your own machines), voice, defaults, My secrets (your own, and the values projects ask you for), passkeys
// and devices, and MCP clients. A bot's settings (Bot · name) render the same pages: Profile with its roles, activity
// and audit; Git identity with its author and GitHub route; Defaults without notifications; its secrets; Sign-ins (its
// connected clients and client secrets) in place of Passkeys and devices and MCP clients; no Voice. Every action opens
// its dialog from ../flows/you.tsx or, for a bot, ../flows/bots.tsx; the pages read the stores those dialogs write.
import { glyph } from '../../glyph.js';
import { Button, Select, SelectContent, SelectItem, SelectTrigger, Switch, Tooltip } from '@gitspace/ui';
import { CpuChip02, Fingerprint01, GitBranch01, Key01, Lock01, LogOut01, Microphone01, Monitor01, Plus, Sliders01, Terminal } from '@untitledui/icons';
import { useState } from 'react';
import { TEAM, USERS, visibleProjects } from '../data.js';
import {
  AuthorFlow, copyText, DeviceRemoveFlow, DeviceRenameFlow, GitHubConnectFlow, GitHubDisconnectFlow, LeaveTeamFlow, McpConnectFlow, McpEditFlow, PasskeyAddFlow, ProfileAvatar, ProfileEditFlow,
  RevokeFlow, SigningFlow, SshKeyFlow, useDevices, ValueFlow, ValueRemoveFlow,
} from '../flows/you.js';
import {
  authors, DEFAULT_DEFAULTS, DEFAULT_VOICE, defaultPrefs, DICTATION_LANGUAGES, githubLinks, mcpGrants, MODEL_ROLES, ownKeys, profiles, publicKeyOf, signing, SPOKEN_REPLIES, sshKeys, valueStates, voicePrefs,
  WORKSPACE_MODES, type Device,
} from '../flows/you-data.js';
import { BotActivitySection, BotAuditSection, BotGitSection, BotProfileSection, BotRolesSection, BotSignInsSection } from '../flows/bots.js';
import { revokeIn, revokeOnly, type ScopeInfo } from '../scope.js';
import { useMock, useViewer } from '../viewer.js';
import { ACCOUNT_NAME, ACTIVE_PROJECTS, CAPABILITIES, DEVICES, MACHINES, PERSONAL_VALUES, projectName, revoked, type McpGrant } from './data.js';
import { Act, Note, Pill, Section, SettingRow, SettingRows } from './parts.js';
import { accountRoleOf, projectRoleOf } from './roles.js';
import { EditRuleDialog, RuleSummary, whyRuleEdit, type RuleTarget } from '../flows/secret-rules.js';
import { OwnSecretsSection } from './secrets.js';

const ENDPOINT = `https://${TEAM.host}/mcp`;

/** Someone else's profile and preferences are theirs to edit: refused for an Owner or Admin viewing them. */
function editReason(info: ScopeInfo): string | null {
  return info.access === 'revoke' ? `Owners and Admins never edit ${info.target?.first}’s settings; they can only revoke` : null;
}

export function ProfilePage({ info }: { info: ScopeInfo }) {
  const edit = editReason(info);
  const names = profiles.use();
  const [flow, setFlow] = useState<'edit' | 'leave' | null>(null);
  const person = info.target;
  if (!person) return null;
  if (person.kind === 'bot') return <>
    <BotProfileSection bot={person} sponsorView={info.access === 'sponsor'} />
    <BotRolesSection bot={person} />
    <BotActivitySection bot={person} />
    <BotAuditSection bot={person} />
  </>;
  const owners = USERS.filter((user) => user.accountRole === 'owner');
  return <>
    <Section title="Profile" scope="You" description={`${info.access === 'own' ? 'Your' : `${person.first}’s`} user in ${ACCOUNT_NAME}. A person in another team too has a separate user there, with its own passkeys.`}>
      <SettingRows label="Profile">
        <SettingRow title={<span data-profile-name={person.id} className="flex items-center gap-2"><ProfileAvatar userId={person.id} size={28} />{names[person.id]?.name ?? person.name}</span>} description={`${person.email} · account role ${accountRoleOf(person.id)?.name}`}>
          <Act reason={edit} variant="ghost" onClick={() => setFlow('edit')}>Edit</Act>
        </SettingRow>
        {ACTIVE_PROJECTS.filter((project) => visibleProjects(person.id).has(project.id)).map((project) => <SettingRow key={project.id} title={project.name} description={projectRoleOf(person.id, project.id)?.description}><Pill tone="blue">{projectRoleOf(person.id, project.id)?.name}</Pill></SettingRow>)}
      </SettingRows>
    </Section>
    {info.access === 'own' ? <Section title={`Leave ${ACCOUNT_NAME}`} scope="You" description="Your passkeys, devices, grants and personal resources here are deleted and your handles released; processes you started keep running, detached. Bots you sponsor can’t sign in until an Admin takes them over. History keeps your name.">
      <div><Act reason={person.accountRole === 'owner' && owners.length === 1 ? 'You’re the only Owner: make someone else Owner first' : null} variant="secondary" leadingIcon={glyph(LogOut01)} onClick={() => setFlow('leave')}>Leave team</Act></div>
    </Section> : null}
    {flow === 'edit' ? <ProfileEditFlow userId={person.id} onClose={() => setFlow(null)} /> : null}
    {flow === 'leave' ? <LeaveTeamFlow userId={person.id} onClose={() => setFlow(null)} /> : null}
  </>;
}

export function GitIdentityPage({ info }: { info: ScopeInfo }) {
  const { say } = useMock();
  const edit = editReason(info);
  const author = authors.use();
  const links = githubLinks.use();
  const keys = sshKeys.use();
  const own = ownKeys.use();
  const signs = signing.use();
  const [flow, setFlow] = useState<'author' | 'github' | 'github-off' | 'ssh' | 'signing' | null>(null);
  const person = info.target;
  if (!person) return null;
  if (person.kind === 'bot') return <BotGitSection bot={person} />;
  const key = keys[person.id] ?? null;
  const link = links[person.id] ?? null;
  const usesOwn = own[person.id] ?? false;
  const physical = MACHINES.filter((machine) => machine.owner.scope === 'user' && machine.owner.userId === person.id && machine.kind === 'computer');
  const close = (): void => setFlow(null);
  return <>
    <Section title="Commit author" scope="You" description={`Commits from turns ${info.access === 'own' ? 'you start' : `${person.first} starts`} carry this author, on every machine. GitSpace is the committer; co-holders who prompted the turn are Co-authored-by.`}>
      <SettingRows label="Author">
        <SettingRow media={glyph(GitBranch01)} title="Name" description={<span className="font-mono">{author[person.id]?.name ?? person.name}</span>}><Act reason={edit} variant="ghost" onClick={() => setFlow('author')}>Edit</Act></SettingRow>
        <SettingRow title="Email" description={<span className="font-mono">{author[person.id]?.email ?? ''}</span>}><Act reason={edit} variant="ghost" onClick={() => setFlow('author')}>Edit</Act></SettingRow>
      </SettingRows>
    </Section>
    <Section title="GitHub" scope="You" readOnly={edit} description={`${info.access === 'own' ? 'Your' : `${person.first}’s`} own GitHub account, for the GitHub setup on ${info.access === 'own' ? 'your' : 'their'} own machines (gh, credential helper). Each member sets this up themselves; team machines use the team’s GitHub App and SSH key, never this.`}>
      <SettingRows label="GitHub">
        <SettingRow media={glyph(GitBranch01)} title={<span data-github-account={person.id} className="inline-flex flex-wrap items-center gap-2">{link ? `@${link.login}` : 'Not connected'}{link ? <Pill tone="green">Connected</Pill> : <Pill tone="amber">Set up</Pill>}</span>}
          description={link ? `Signed in with GitHub · used by gh and git on ${info.access === 'own' ? 'your' : 'their'} own machines · commit email ${link.email}${link.keyAdded ? ' · the SSH key below is on it' : ''}` : 'Connect your GitHub account so your own machines can push to origins the App doesn’t cover'}>
          {link ? <Act reason={edit} variant="ghost" onClick={() => setFlow('github-off')}>Disconnect</Act> : null}
          <Act reason={edit} variant={link ? 'ghost' : 'primary'} onClick={() => setFlow('github')}>{link ? 'Reconnect' : 'Connect GitHub'}</Act>
        </SettingRow>
      </SettingRows>
    </Section>
    <Section title="SSH key" scope="You" readOnly={edit} description={`For origins the team’s GitHub App doesn’t cover, on ${info.access === 'own' ? 'your' : `${person.first}’s`} own machines only. Team machines use the team SSH key; a personal machine never gets the team key, and a team machine never gets yours.`}>
      <SettingRows label="SSH key">
        {key ? <SettingRow media={glyph(Key01)} title={<span data-personal-ssh-key={person.id} className="inline-flex flex-wrap items-center gap-2">{key.name}<Pill>{key.algorithm}</Pill><Pill tone="gray">{key.source === 'generated' ? 'Generated' : 'Pasted public key'}</Pill></span>}
          description={<><span className="font-mono">{key.fingerprint}</span> · created {key.created} · add it to the hosts you use (GitLab, Bitbucket, a server)</>}>
          <Act reason={edit} variant="ghost" onClick={() => copyText(publicKeyOf(person.id, key), 'Public key', say)}>Copy public key</Act>
          <Act reason={edit} variant="ghost" onClick={() => setFlow('ssh')}>Replace key</Act>
        </SettingRow> : <SettingRow media={glyph(Key01)} title="No SSH key" description="Your machines can’t reach origins the GitHub App doesn’t cover until you add one">
          <Act reason={edit} variant="primary" onClick={() => setFlow('ssh')}>Add SSH key</Act>
        </SettingRow>}
        {physical.length ? <SettingRow title="On my physical computers, use the computer’s own keys" description={`${physical.map((machine) => machine.label).join(', ')}: ${usesOwn ? 'its own ~/.ssh keys and agent' : 'the key above'}`}>
          <Switch label="Use this computer’s own keys" checked={usesOwn} disabled={edit !== null} onToggle={() => { ownKeys.set({ ...ownKeys.get(), [person.id]: !usesOwn }); say(usesOwn ? 'Your physical computers use the key above' : 'Your physical computers use their own ~/.ssh keys'); }} />
        </SettingRow> : null}
        <SettingRow title="Signing" description={(signs[person.id] ?? 'ssh') === 'off' ? 'Commits aren’t signed' : `Commits are signed with ${key ? key.name : 'your SSH key'}${link ? ' and show Verified on GitHub' : ''}`}><Act reason={edit} variant="ghost" onClick={() => setFlow('signing')}>Change</Act></SettingRow>
      </SettingRows>
    </Section>
    {flow === 'author' ? <AuthorFlow userId={person.id} onClose={close} /> : null}
    {flow === 'github' ? <GitHubConnectFlow userId={person.id} onClose={close} /> : null}
    {flow === 'github-off' ? <GitHubDisconnectFlow userId={person.id} onClose={close} /> : null}
    {flow === 'ssh' ? <SshKeyFlow userId={person.id} onClose={close} /> : null}
    {flow === 'signing' ? <SigningFlow userId={person.id} onClose={close} /> : null}
  </>;
}

export function VoicePage({ info }: { info: ScopeInfo }) {
  const { say } = useMock();
  const edit = editReason(info);
  const all = voicePrefs.use();
  const person = info.target;
  if (!person || person.kind === 'bot') return null;
  const prefs = all[person.id] ?? DEFAULT_VOICE;
  const save = (next: Partial<typeof prefs>, message: string): void => { voicePrefs.set({ ...voicePrefs.get(), [person.id]: { ...prefs, ...next } }); say(message); };
  const language = DICTATION_LANGUAGES.find(([id]) => id === prefs.dictation)?.[1] ?? prefs.dictation;
  return <Section title="Voice" scope="You" description={`Talking to agents: ${info.access === 'own' ? 'your' : `${person.first}’s`} dictation and spoken replies.`}>
    <SettingRows label="Voice">
      <SettingRow media={glyph(Microphone01)} title="Dictation language" description={`${language}${prefs.dictation === DEFAULT_VOICE.dictation ? ' (the default)' : ''} · falls back to the system language`}>
        <Select value={prefs.dictation} disabled={edit !== null} onValueChange={(value) => save({ dictation: value }, `Dictation: ${DICTATION_LANGUAGES.find(([id]) => id === value)?.[1] ?? value}`)}>
          <SelectTrigger aria-label="Dictation language" /><SelectContent>{DICTATION_LANGUAGES.map(([id, label], index) => <SelectItem key={id} value={id} index={index}>{label}</SelectItem>)}</SelectContent>
        </Select>
      </SettingRow>
      <SettingRow title="Push to talk" description="Hold Space in the composer"><Switch label="Push to talk" checked={prefs.push} disabled={edit !== null} onToggle={() => save({ push: !prefs.push }, prefs.push ? 'Push to talk off: click the microphone to dictate' : 'Push to talk on: hold Space')} /></SettingRow>
      <SettingRow title="Spoken replies" description="Agents read their replies aloud in the workspace you have open">
        <Select value={prefs.spoken} disabled={edit !== null} onValueChange={(value) => save({ spoken: value }, `Spoken replies: ${SPOKEN_REPLIES.find(([id]) => id === value)?.[1] ?? value}`)}>
          <SelectTrigger aria-label="Spoken replies" /><SelectContent>{SPOKEN_REPLIES.map(([id, label], index) => <SelectItem key={id} value={id} index={index}>{label}</SelectItem>)}</SelectContent>
        </Select>
      </SettingRow>
    </SettingRows>
  </Section>;
}

export function DefaultsPage({ info }: { info: ScopeInfo }) {
  const { say } = useMock();
  const edit = editReason(info);
  const all = defaultPrefs.use();
  const person = info.target;
  if (!person) return null;
  const bot = person.kind === 'bot';
  const prefs = all[person.id] ?? DEFAULT_DEFAULTS;
  const save = (next: Partial<typeof prefs>, message: string): void => { defaultPrefs.set({ ...defaultPrefs.get(), [person.id]: { ...prefs, ...next } }); say(message); };
  const role = MODEL_ROLES.find(([id]) => id === prefs.role);
  const mode = WORKSPACE_MODES.find(([id]) => id === prefs.mode);
  return <Section title="Defaults" scope="You" description={bot ? `What a new run ${person.first} starts begins with. Whoever starts it for ${person.first} can change both.` : `What a new run starts with for ${info.access === 'own' ? 'you' : person.first}. You can change both when you start one.`}>
    <SettingRows label="Defaults">
      <SettingRow media={glyph(Sliders01)} title="Model role for new runs" description={`${role?.[2] ?? ''} · the project’s profile decides the model behind each role`}>
        <Select value={prefs.role} disabled={edit !== null} onValueChange={(value) => save({ role: value }, `New runs start with the ${MODEL_ROLES.find(([id]) => id === value)?.[1] ?? value} role`)}>
          <SelectTrigger aria-label="Model role" /><SelectContent>{MODEL_ROLES.map(([id, label], index) => <SelectItem key={id} value={id} index={index}>{label}</SelectItem>)}</SelectContent>
        </Select>
      </SettingRow>
      <SettingRow title="Workspace mode" description={`Where a new workspace starts: ${mode?.[2] ?? ''}`}>
        <Select value={prefs.mode} disabled={edit !== null} onValueChange={(value) => save({ mode: value }, `New workspaces start in ${WORKSPACE_MODES.find(([id]) => id === value)?.[1] ?? value}`)}>
          <SelectTrigger aria-label="Workspace mode" /><SelectContent>{WORKSPACE_MODES.map(([id, label], index) => <SelectItem key={id} value={id} index={index}>{label}</SelectItem>)}</SelectContent>
        </Select>
      </SettingRow>
      {bot ? null : <SettingRow title="Notify me when an agent waits on me" description="Browser notification and the Inbox count"><Switch label="Notify me" checked={prefs.notify} disabled={edit !== null} onToggle={() => save({ notify: !prefs.notify }, prefs.notify ? 'Only the Inbox count tells you now' : 'You’ll get a browser notification too')} /></SettingRow>}
    </SettingRows>
  </Section>;
}

type DeviceFlow = { kind: 'add' } | { kind: 'rename' | 'remove' | 'revoke'; device: Device };

export function PasskeysPage({ info }: { info: ScopeInfo }) {
  const viewer = useViewer();
  const { say } = useMock();
  const targetId = info.target?.kind === 'person' ? info.target.id : '';
  const devices = useDevices(targetId, DEVICES[targetId] ?? []);
  const [flow, setFlow] = useState<DeviceFlow | null>(null);
  const close = (): void => setFlow(null);
  const person = info.target;
  if (!person) return null;
  if (person.kind === 'bot') return <BotSignInsSection bot={person} />;
  return <Section title="Passkeys and devices" scope="You" description={`${info.access === 'own' ? 'Yours' : `${person.first}’s`} alone; nobody else can add or use them. ${info.access === 'revoke' ? `As ${accountRoleOf(viewer.id)?.name} you can revoke one (${person.first} is told; it’s in the audit log).` : ''}`}
    actions={<Act reason={revokeOnly(info, viewer)} variant="secondary" leadingIcon={glyph(Plus)} onClick={() => setFlow({ kind: 'add' })}>Add passkey</Act>}>
    <SettingRows label="Passkeys">{devices.map((device) => <SettingRow key={device.id} media={glyph(device.current ? Monitor01 : Fingerprint01)}
      title={<span data-device={device.id} className="inline-flex flex-wrap items-center gap-2">{device.label}{device.current && info.access === 'own' ? <Pill tone="green">This browser</Pill> : null}</span>} description={`${device.kind} · added ${device.added} · last used ${device.lastUsed}`}>
      {info.access === 'own' ? <>
        <Button variant="ghost" onClick={() => setFlow({ kind: 'rename', device })}>Rename</Button>
        <Button variant="ghost" onClick={() => setFlow({ kind: 'remove', device })}>Remove</Button>
      </> : <Act reason={null} variant="ghost" onClick={() => setFlow({ kind: 'revoke', device })}>Revoke</Act>}
    </SettingRow>)}</SettingRows>
    {flow?.kind === 'add' ? <PasskeyAddFlow userId={person.id} devices={devices} onClose={close} /> : null}
    {flow?.kind === 'rename' ? <DeviceRenameFlow userId={person.id} device={flow.device} devices={devices} onClose={close} /> : null}
    {flow?.kind === 'remove' ? <DeviceRemoveFlow userId={person.id} device={flow.device} devices={devices} onClose={close} onAdd={() => setFlow({ kind: 'add' })} /> : null}
    {flow?.kind === 'revoke' ? <RevokeFlow id="device-revoke" title={`Revoke ${person.first}’s passkey on ${flow.device.label}`} confirmLabel="Revoke passkey" onClose={close}
      body={`It stops signing in to ${ACCOUNT_NAME} at once; if ${person.first} is signed in with it, that browser is signed out. ${person.first} is told, and it’s in the audit log.`}
      onConfirm={() => revokeIn(info, viewer, flow.device.id, `passkey on ${flow.device.label}`, 'revoked', say)} success={`Revoked ${person.first}’s passkey on ${flow.device.label}`} /> : null}
  </Section>;
}

/** One cell of a grant's slice: in the grant (solid) or the person's but left out (struck through). */
function Slice({ on, children, reason }: { on: boolean; children: string; reason: string }) {
  return <Tooltip content={reason}><span className={`inline-flex h-6 items-center rounded-full px-2 text-[11.5px] ${on ? 'bg-active font-medium text-foreground shadow-[inset_0_0_0_1px_var(--border)]' : 'text-muted-foreground line-through decoration-muted-foreground/60 shadow-[inset_0_0_0_1px_var(--border)] [border-style:dashed]'}`}>{children}</span></Tooltip>;
}

type GrantFlow = { kind: 'connect' } | { kind: 'edit' | 'revoke'; grant: McpGrant };

export function McpClientsPage({ info, navigate }: { info: ScopeInfo; navigate(page: string): void }) {
  const viewer = useViewer();
  const { say } = useMock();
  const gone = revoked.use();
  const all = mcpGrants.use();
  const [flow, setFlow] = useState<GrantFlow | null>(null);
  const close = (): void => setFlow(null);
  const person = info.target;
  if (!person || person.kind === 'bot') return null;
  const own = info.access === 'own';
  const grants = all.filter((grant) => grant.userId === person.id && !gone.has(grant.id));
  const theirs = ACTIVE_PROJECTS.filter((project) => visibleProjects(person.id).has(project.id));
  return <>
    <Section title="MCP clients" scope="You" description={`Apps ${own ? 'you' : person.first} allowed with OAuth. Each acts as ${own ? 'you' : person.first}, within a slice: some projects (with ${own ? 'your' : 'their'} project role there), some capabilities, until it expires. It prompts only in workspaces whose handle ${own ? 'you hold' : `${person.first} holds`}, has no handle of its own, and its actions read “${person.first} via the app”.`}
      actions={<Act reason={revokeOnly(info, viewer)} variant="secondary" leadingIcon={glyph(Plus)} onClick={() => setFlow({ kind: 'connect' })}>Connect a client</Act>}>
      <SettingRows label="MCP clients">
        {own ? <SettingRow title="Endpoint" description={<span className="font-mono">{ENDPOINT}</span>}><Button variant="ghost" onClick={() => copyText(ENDPOINT, 'Endpoint', say)}>Copy</Button></SettingRow> : null}
        {grants.map((grant) => <SettingRow key={grant.id} media={glyph(Terminal)} title={<span data-grant={grant.id} className="inline-flex flex-wrap items-center gap-2">{grant.client}<Pill tone="blue">{grant.via}</Pill><Pill tone={grant.expires.startsWith('in 2') || grant.expires === 'in 1 day' ? 'amber' : 'gray'}>Expires {grant.expires}</Pill></span>}
          description={<>via {grant.host} · last used {grant.lastUsed} · reads as “{person.first} via {grant.client}”</>}
          extra={<div className="mt-1.5 flex flex-col gap-1.5 text-caption text-muted-foreground">
            <span className="flex flex-wrap items-center gap-1.5"><span className="w-24 shrink-0">Projects</span>{theirs.map((project) => {
              const on = grant.projects.includes(project.id);
              const role = projectRoleOf(person.id, project.id)?.name ?? '—';
              return <Slice key={project.id} on={on} reason={on ? `${project.name}: with the project role there (${role})` : `${role} in ${project.name}; this grant leaves it out`}>{`${project.name} · ${role}`}</Slice>;
            })}</span>
            <span className="flex flex-wrap items-center gap-1.5"><span className="w-24 shrink-0">Capabilities</span>{CAPABILITIES.map((capability) => <Slice key={capability} on={grant.capabilities.includes(capability)} reason={grant.capabilities.includes(capability) ? 'Allowed where the project role allows it' : 'Not in this grant'}>{capability}</Slice>)}</span>
          </div>}>
          <Act reason={own ? null : editReason(info)} variant="ghost" onClick={() => setFlow({ kind: 'edit', grant })}>Edit slice</Act>
          <Act reason={null} variant="ghost" onClick={() => setFlow({ kind: 'revoke', grant })}>Revoke</Act>
        </SettingRow>)}
      </SettingRows>
      {grants.length ? null : <Note>No MCP clients.</Note>}
    </Section>
    {own ? <Section title="Acting as something other than a person" scope="Team" description="CI and automation use a bot: its own principal with a sponsor, Member at most. It signs in over MCP by a connected client or a client secret. Its actions read “Release bot (sponsored by Theo) via Claude Code”.">
      <div><Button variant="secondary" leadingIcon={glyph(CpuChip02)} onClick={() => navigate('bots')}>Open Crumb &amp; Co › Bots</Button></div>
    </Section> : null}
    {flow?.kind === 'connect' ? <McpConnectFlow userId={person.id} onClose={close} /> : null}
    {flow?.kind === 'edit' ? <McpEditFlow grant={flow.grant} onClose={close} /> : null}
    {flow?.kind === 'revoke' ? <RevokeFlow id="mcp-revoke" title={`Revoke ${flow.grant.client}`} confirmLabel="Revoke" onClose={close}
      body={`${person.first} via ${flow.grant.client} stops at once: its tokens are invalidated and its next call fails. Prompts it already sent stay in their workspaces.${own ? '' : ` ${person.first} is told, and it’s in the audit log.`}`}
      onConfirm={() => revokeIn(info, viewer, flow.grant.id, `MCP client ${flow.grant.client}`, 'revoked', say)} success={`${flow.grant.client} revoked`} /> : null}
  </>;
}

type ValueAction = { kind: 'set'; start: string | null } | { kind: 'remove'; projectId: string; name: string } | { kind: 'rule'; target: RuleTarget };

/** You › My secrets: your own secrets (the old step-ups: a cleared shell for some minutes after your passkey), then the
 * values projects' environments ask each holder for (their own staging login, a Figma token), each with the project's
 * rule, which you may narrow for your own value. A workspace gets them only while you hold its handle, for turns you
 * start. A bot's page (Bot › its secrets) is its own secrets alone. */
export function PersonalSecretsPage({ info }: { info: ScopeInfo }) {
  const viewer = useViewer();
  const states = valueStates.use();
  const [flow, setFlow] = useState<ValueAction | null>(null);
  const close = (): void => setFlow(null);
  const person = info.target;
  if (!person) return null;
  if (person.kind === 'bot') return <OwnSecretsSection principal={person} />;
  const values = (PERSONAL_VALUES[person.id] ?? []).map((value) => ({ ...value, ...states[`${person.id}:${value.projectId}:${value.name}`] }));
  const refusal = revokeOnly(info, viewer);
  return <>
    <OwnSecretsSection principal={person} />
    <Section title="Values projects ask you for" scope="You" description="Each project’s environment lists what it needs from each holder, with a rule its Leads set. You may narrow that rule for your own value, never widen it. Values are write-only; they reach a workspace only while you hold its handle, for turns you start."
      actions={values.length ? <Act reason={refusal} variant="secondary" leadingIcon={glyph(Plus)} onClick={() => setFlow({ kind: 'set', start: null })}>Add a value</Act> : null}>
      {values.length ? <SettingRows label="Values projects ask you for">{values.map((value) => {
        const target: RuleTarget = { kind: 'holder', projectId: value.projectId, name: value.name, userId: person.id };
        return <SettingRow key={`${value.projectId}:${value.name}`} media={glyph(Lock01)}
          title={<span data-personal-value={value.name} className="inline-flex flex-wrap items-center gap-2"><span className="font-mono">{value.name}</span><Pill tone="teal">{projectName(value.projectId)} asks</Pill>{value.set ? <Pill tone="green">Set</Pill> : <Pill tone="amber">Missing</Pill>}</span>}
          description={`${value.detail}${value.set ? ` · updated ${value.updated}` : ' · setup steps that need it fail in workspaces you hold until you set it'}`}
          extra={<RuleSummary target={target} />}>
          {value.set ? <Act reason={refusal} variant="ghost" onClick={() => setFlow({ kind: 'remove', projectId: value.projectId, name: value.name })}>Remove</Act> : null}
          <Act reason={whyRuleEdit(viewer.id, target)} variant="ghost" aria-label={`Edit rule for ${value.name}`} onClick={() => setFlow({ kind: 'rule', target })}>Edit rule</Act>
          <Act reason={refusal} variant={value.set ? 'ghost' : 'primary'} onClick={() => setFlow({ kind: 'set', start: `${value.projectId}:${value.name}` })}>{value.set ? 'Replace' : 'Set value'}</Act>
        </SettingRow>;
      })}</SettingRows> : <Note>No project asks you for anything.</Note>}
      {flow?.kind === 'set' ? <ValueFlow userId={person.id} start={flow.start} onClose={close} /> : null}
      {flow?.kind === 'remove' ? <ValueRemoveFlow userId={person.id} projectId={flow.projectId} name={flow.name} onClose={close} /> : null}
      {flow?.kind === 'rule' ? <EditRuleDialog target={flow.target} onClose={close} /> : null}
    </Section>
  </>;
}
