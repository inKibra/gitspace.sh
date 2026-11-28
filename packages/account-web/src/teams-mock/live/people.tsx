// People: everyone and every bot in the account, live. Each person shows their presence (online in which workspace and
// what they're doing, away, or offline since), their account role and project roles, and the bots they sponsor; each
// bot its sponsor, presence and whether its sign-ins are blocked. A person opens their page: a summary of everything
// they've connected (devices, MCP clients, providers, plugins, machines, browsers, own secrets and cleared shells, personal values, skills)
// with Revoke for Owners and Admins, and the admin actions (account role, projects, remove) also in Settings › People
// & roles, which links here.
import { Button } from '@gitspace/ui';
import { Fingerprint01, Globe02, Key01, Link03, Lock01, Monitor01, Server01, Stars01, Terminal } from '@untitledui/icons';
import type { ReactNode } from 'react';
import { actorLabel, bots, memberships, stepUps, TEAM, USERS, userOf, visibleProjects } from '../data.js';
import { revokeIn, ScopeBanner, type ScopeInfo } from '../scope.js';
import { secretRules } from '../flows/env-model.js';
import { ruleLine, ruleOf } from '../flows/secret-rules.js';
import { secrets } from '../flows/team-data.js';
import { valueStates } from '../flows/you-data.js';
import { accountRoleChanges, BROWSERS, DEVICES, LIMITED_PRESENCE, MACHINES, MCP_GRANTS, MODEL_CREDENTIALS, PERSONAL_VALUES, PLUGINS, presenceLine, presenceSeenBy, projectName, removedUsers, revoked, SECRET_KIND_LABEL, SKILLS, type SeenPresence } from '../settings/data.js';
import { Act, Avatar, Note, Pill, Section, SettingRow, SettingRows, useHeld } from '../settings/parts.js';
import { accountRoleById, roleName, useRoles } from '../settings/roles.js';
import { AccountRoleSelect, InviteButton, PersonAdminActions, projectRoles } from '../settings/team.js';
import { useMock, useViewer } from '../viewer.js';
import { LivePage, PanelGrid, PresenceAvatar, seesTeam, Stat, StatStrip } from './parts.js';

const PRESENCE_TONE = { online: 'good', away: 'warn', offline: 'muted' } as const;
const PRESENCE_LABEL = { online: 'Online', away: 'Away', offline: 'Offline' } as const;

/** A card's presence line; a limited one says why it shows only online or offline. */
function PresenceText({ presence }: { presence: SeenPresence }) {
  return <span className="text-caption text-foreground" title={presence.doing || undefined}>{presenceLine(presence)}{presence.limited ? <span className="text-muted-foreground"> · {LIMITED_PRESENCE}</span> : null}</span>;
}

export function PeoplePage() {
  const viewer = useViewer();
  const { navigate } = useMock();
  useRoles();
  const live = memberships.use();
  const botList = bots.use();
  const left = removedUsers.use();
  const roles = accountRoleChanges.use();
  const held = useHeld();
  const seen = visibleProjects(viewer.id);
  const people = USERS.filter((user) => !left.has(user.id));
  const presenceOf = (id: string): SeenPresence => presenceSeenBy(viewer.id, id);
  const card = (id: string, body: ReactNode, onOpen: () => void, dim: boolean) => <button key={id} type="button" data-people-card={id} onClick={onOpen}
    className={`flex min-w-0 flex-col gap-2 rounded-2xl p-3.5 text-left shadow-[inset_0_0_0_1px_var(--border)] hover:bg-hover ${dim ? 'opacity-65' : ''}`}>{body}</button>;
  return <LivePage title="People" viewer={viewer} description="Everyone and every bot in the account, and what each is doing now. Open one for everything they’ve connected."
    configure={{ label: 'People & roles', onClick: () => navigate('settings', { page: 'people' }) }} actions={<InviteButton />}>
    <StatStrip>
      <Stat label="Online" value={String(people.filter((person) => presenceOf(person.id).state === 'online').length)} tone="good" detail={people.filter((person) => presenceOf(person.id).state === 'online').map((person) => person.first).join(', ')} />
      <Stat label="Away" value={String(people.filter((person) => presenceOf(person.id).state === 'away').length)} tone="warn" />
      <Stat label="Offline" value={String(people.filter((person) => presenceOf(person.id).state === 'offline').length)} tone="muted" />
      <Stat label="Bots working" value={String(botList.filter((bot) => bot.sponsor && presenceOf(bot.id).state === 'online').length)} />
      <Stat label="Bots blocked" value={String(botList.filter((bot) => !bot.sponsor).length)} detail={botList.filter((bot) => !bot.sponsor).map((bot) => bot.name).join(', ') || 'None'} tone={botList.some((bot) => !bot.sponsor) ? 'warn' : undefined} />
    </StatStrip>
    <Section title="People" description={`${people.length} people at ${TEAM.domains.join(', ')}.`}>
      <PanelGrid min="17rem">{people.map((person) => {
        const presence = presenceOf(person.id);
        const role = roles[person.id] ?? person.accountRole;
        const sponsored = botList.filter((bot) => bot.sponsor === person.id);
        const holding = held(person.id);
        return card(person.id, <>
          <span className="flex min-w-0 items-center gap-2.5">
            <PresenceAvatar userId={person.id} size={32} tone={PRESENCE_TONE[presence.state]} />
            <span className="flex min-w-0 flex-col"><span className="truncate text-body font-semibold text-foreground">{person.name}{person.id === viewer.id ? ' (you)' : ''}</span><span className="truncate text-caption text-muted-foreground">{person.email}</span></span>
            <span className="ml-auto shrink-0"><Pill>{accountRoleById(role)?.name}</Pill></span>
          </span>
          <PresenceText presence={presence} />
          {projectRoles(role, live.filter((entry) => entry.userId === person.id && seen.has(entry.projectId)))}
          <span className="text-caption text-muted-foreground">{holding.length ? `Holds ${holding.join(', ')}` : 'Holds no handle'}{sponsored.length ? ` · sponsors ${sponsored.map((bot) => bot.name).join(', ')}` : ''}</span>
        </>, () => navigate('person', { person: person.id }), presence.state === 'offline');
      })}</PanelGrid>
    </Section>
    <Section title="Bots" description="Each signs in as itself over MCP, sponsored by an Admin or Owner. Its page is in Settings › Bots.">
      <PanelGrid min="17rem">{botList.map((bot) => {
        const presence = presenceOf(bot.id);
        return card(bot.id, <>
          <span className="flex min-w-0 items-center gap-2.5"><Avatar userId={bot.id} size={32} /><span className="flex min-w-0 flex-col"><span className="truncate text-body font-semibold text-foreground">{bot.name}</span>
            <span className="truncate text-caption text-muted-foreground">{bot.sponsor ? `Sponsored by ${userOf(bot.sponsor).name}` : `No sponsor: ${bot.formerSponsor} ${bot.lapse ?? ''}`}</span></span>
            <span className="ml-auto shrink-0">{bot.sponsor ? <Pill tone="violet">Bot</Pill> : <Pill tone="amber">Sign-ins blocked</Pill>}</span></span>
          <PresenceText presence={presence} />
          <span className="text-caption text-muted-foreground">{live.filter((entry) => entry.userId === bot.id && seen.has(entry.projectId)).map((entry) => `${roleName(entry.roleId)} in ${projectName(entry.projectId)}`).join(' · ') || 'In no project you can see'}</span>
        </>, () => navigate('settings', { page: 'bots', person: bot.id }), !bot.sponsor)}
      )}</PanelGrid>
    </Section>
  </LivePage>;
}

/** One person's page: presence, roles, and everything they've connected, with Revoke for Owners and Admins. */
export function PersonPage({ personId }: { personId: string }) {
  const viewer = useViewer();
  const { navigate, say } = useMock();
  useRoles();
  const gone = revoked.use();
  const left = removedUsers.use();
  const roles = accountRoleChanges.use();
  const live = memberships.use();
  const ups = stepUps.use();
  const ownSecrets = secrets.use();
  const rules = secretRules.use();
  const values = valueStates.use();
  const botList = bots.use();
  const held = useHeld();
  const person = USERS.find((user) => user.id === personId);
  if (!person || left.has(person.id)) return <LivePage title="Not in the team" viewer={viewer} description="This person was removed. History keeps their name."><Button variant="secondary" onClick={() => navigate('people')}>All people</Button></LivePage>;
  const own = person.id === viewer.id;
  const staff = seesTeam(viewer);
  const info: ScopeInfo = { scope: own ? 'mine' : person.id, access: own ? 'own' : staff ? 'revoke' : 'team-read', target: person, teamReason: own || staff ? null : 'Only Owners and Admins see what someone has connected' };
  const presence = presenceSeenBy(viewer.id, person.id);
  const role = roles[person.id] ?? person.accountRole;
  const mine = (owner: { scope: string; userId?: string }) => owner.scope === 'user' && owner.userId === person.id;
  const can = own || staff;
  const groups: ReadonlyArray<{ key: string; title: string; icon: typeof Monitor01; rows: ReadonlyArray<{ id: string; title: string; detail: string; revoke?: { what: string; verb: string; action: string } }> }> = can ? [
    { key: 'devices', title: 'Devices and passkeys', icon: Monitor01, rows: (DEVICES[person.id] ?? []).filter((device) => !gone.has(device.id)).map((device) => ({ id: device.id, title: device.label, detail: `${device.kind} · last used ${device.lastUsed}`, revoke: { what: `device ${device.label}`, verb: 'signed out', action: 'Sign out' } })) },
    { key: 'mcp', title: 'MCP clients', icon: Terminal, rows: MCP_GRANTS.filter((grant) => grant.userId === person.id && !gone.has(grant.id)).map((grant) => ({ id: grant.id, title: grant.client, detail: `${grant.capabilities.join(', ')} · ${grant.projects.map(projectName).join(', ')} · expires ${grant.expires}`, revoke: { what: `MCP client ${grant.client}`, verb: 'revoked', action: 'Revoke' } })) },
    { key: 'providers', title: 'Providers', icon: Stars01, rows: MODEL_CREDENTIALS.filter((entry) => mine(entry.owner) && !gone.has(entry.id)).map((entry) => ({ id: entry.id, title: entry.label, detail: `${entry.via} · ${entry.state}${entry.stateDetail ? ` · ${entry.stateDetail}` : ''} · last used ${entry.lastUsed}`, revoke: { what: `provider ${entry.label}`, verb: 'signed out', action: 'Sign out' } })) },
    { key: 'plugins', title: 'Plugin sign-ins', icon: Link03, rows: PLUGINS.filter((plugin) => mine(plugin.owner) && !gone.has(plugin.id)).map((plugin) => ({ id: plugin.id, title: plugin.name, detail: `${plugin.auth} · ${plugin.status === 'connected' ? 'connected' : 'sign-in required'} · last used ${plugin.lastUsed}`, revoke: { what: plugin.name, verb: 'disconnected', action: 'Disconnect' } })) },
    { key: 'own-secrets', title: 'Own secrets', icon: Lock01, rows: ownSecrets.filter((secret) => secret.scope === person.id).map((secret) => ({ id: secret.id, title: secret.name, detail: `${SECRET_KIND_LABEL[secret.kind]} · ${ruleLine(ruleOf({ kind: 'secret', secret }, rules), { ownerId: person.id })} · values never show` })) },
    { key: 'step-ups', title: 'Cleared shells open', icon: Fingerprint01, rows: ups.filter((entry) => entry.userId === person.id).map((entry) => ({ id: entry.id, title: entry.credential, detail: `${entry.workspaceId} · ${entry.minutesLeft} min left · their turns only`, revoke: { what: `cleared shell ${entry.credential} in ${entry.workspaceId}`, verb: 'dropped', action: 'Drop' } })) },
    { key: 'machines', title: 'Machines', icon: Server01, rows: MACHINES.filter((machine) => mine(machine.owner) && !gone.has(machine.id)).map((machine) => ({ id: machine.id, title: machine.label, detail: `${machine.state} · their own SSH key and GitHub setup`, revoke: { what: machine.label, verb: 'unpaired', action: 'Unpair' } })) },
    { key: 'browsers', title: 'Browsers', icon: Globe02, rows: BROWSERS.filter((browser) => mine(browser.owner) && !gone.has(browser.id)).map((browser) => ({ id: browser.id, title: browser.label, detail: `${browser.online ? 'connected' : 'offline'} · last used ${browser.lastUsed}`, revoke: { what: browser.label, verb: 'unpaired', action: 'Unpair' } })) },
    { key: 'values', title: 'Values projects asked for', icon: Lock01, rows: (PERSONAL_VALUES[person.id] ?? []).map((value) => ({ id: `${value.projectId}:${value.name}`, title: value.name, detail: `${projectName(value.projectId)} · ${values[`${person.id}:${value.projectId}:${value.name}`]?.set ?? value.set ? 'set' : 'missing'} · ${ruleLine(ruleOf({ kind: 'holder', projectId: value.projectId, name: value.name, userId: person.id }, rules))}${rules[`${person.id}:${value.name}`] ? ' (narrowed by them)' : ''} · values never show` })) },
    { key: 'skills', title: 'Skills', icon: Key01, rows: SKILLS.filter((skill) => mine(skill.owner)).map((skill) => ({ id: skill.id, title: skill.name, detail: `${skill.description} · view only` })) },
  ] : [];
  const sponsored = botList.filter((bot) => bot.sponsor === person.id);
  return <LivePage title={person.name} viewer={viewer} description={`${person.email} · account role ${accountRoleById(role)?.name}`}
    configure={staff ? { label: 'People & roles', onClick: () => navigate('settings', { page: 'people' }) } : undefined}
    actions={<Button variant="ghost" onClick={() => navigate('people')}>All people</Button>}>
    <div data-person-page={person.id} className="flex flex-wrap items-center gap-3 rounded-2xl p-3.5 shadow-[inset_0_0_0_1px_var(--border)]">
      <PresenceAvatar userId={person.id} size={40} tone={PRESENCE_TONE[presence.state]} pulse={presence.state === 'online'} />
      <span className="flex min-w-0 flex-1 basis-64 flex-col gap-0.5">
        <span className="text-body font-medium text-foreground">{presenceLine(presence)}</span>
        <span className="text-caption text-muted-foreground">{presence.limited ? LIMITED_PRESENCE : presence.state === 'offline' ? `offline since ${presence.since}` : `since ${presence.since} on ${presence.device}`} · {held(person.id).length ? `holds ${held(person.id).join(', ')}` : 'holds no handle in your projects'}</span>
        {projectRoles(role, live.filter((entry) => entry.userId === person.id && visibleProjects(viewer.id).has(entry.projectId)))}
        {sponsored.length ? <span className="text-caption text-muted-foreground">Sponsors {sponsored.map((bot) => actorLabel(bot.id)).join(', ')}</span> : null}
      </span>
      {staff ? <span className="flex flex-wrap items-center justify-end gap-2"><AccountRoleSelect user={person} /><PersonAdminActions user={person} /></span> : null}
    </div>
    {!own && staff ? <ScopeBanner info={info} noun="connections" /> : null}
    {can ? <>
      <StatStrip>{groups.filter((group) => group.key !== 'skills' && group.key !== 'values').map((group) => <Stat key={group.key} label={group.title} value={String(group.rows.length)} />)}</StatStrip>
      <PanelGrid min="22rem">{groups.filter((group) => group.rows.length).map((group) => <Section key={group.key} title={<span className="inline-flex items-center gap-2"><group.icon width={16} height={16} strokeWidth={1.5} />{group.title}</span>}>
        <SettingRows label={group.title}>{group.rows.map((row) => <SettingRow key={row.id} title={row.title} description={row.detail}>
          {row.revoke ? <Act reason={null} variant="ghost" aria-label={`${row.revoke.action} ${person.first}’s ${row.title}`} onClick={() => {
            if (row.revoke?.verb === 'dropped') stepUps.set(ups.filter((entry) => entry.id !== row.id));
            if (row.revoke) revokeIn(info, viewer, row.id, row.revoke.what, row.revoke.verb, say);
          }}>{row.revoke.action}</Act> : null}
        </SettingRow>)}</SettingRows>
      </Section>)}</PanelGrid>
    </> : <Note>What {person.first} has connected is theirs: only Owners and Admins see it, to revoke, and no Member ever sees the names of their personal values. Their projects and presence are above.</Note>}
  </LivePage>;
}

