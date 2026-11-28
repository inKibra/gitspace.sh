// Sessions, as an activity view: who is signed in right now (presence), active MCP clients with their last call and
// calls an hour, active sessions on MCP servers hosted on machines, cleared shells (secrets stepped up with a passkey)
// counting down, plugin sign-ins expiring soon, signed-in devices, bots' sign-ins,
// and a timeline of recent sign-ins and revokes. It opens on your own; Owners and Admins switch "Person: Everyone ▾"
// to see everyone's (a revoke from someone else's is audited and tells them).
import { glyph } from '../../glyph.js';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@gitspace/ui';
import { Fingerprint01, Key01, Link03, Monitor01, Terminal } from '@untitledui/icons';
import { useEffect, useState } from 'react';
import { actorLabel, bots, stepUps, USERS, userOf } from '../data.js';
import { audit, botSignIns, DEVICES, LIMITED_PRESENCE, MCP_GRANTS, PLUGINS, presenceLine, presenceSeenBy, recordAudit, removedUsers, revoked } from '../settings/data.js';
import { Act, Avatar, Note, Pill, Section, SettingRow, SettingRows, UserName } from '../settings/parts.js';
import { revokeIn, type ScopeInfo } from '../scope.js';
import { MachineMcpSessions, MachineMcpStat } from '../flows/machine-mcp.js';
import { useMock, useViewer } from '../viewer.js';
import { MCP_ACTIVITY, SESSION_TIMELINE, SIGN_IN_EXPIRY } from './data.js';
import { Events, LivePage, Panel, PanelGrid, PresenceAvatar, seesTeam, Sparkline, Stat, StatStrip } from './parts.js';

export function SessionsPage() {
  const viewer = useViewer();
  const { navigate, say } = useMock();
  const team = seesTeam(viewer);
  const gone = revoked.use();
  const live = stepUps.use();
  const log = audit.use();
  const left = removedUsers.use();
  const botList = bots.use();
  const signIns = botSignIns.use();
  const [who, setWho] = useState<string>(() => new URLSearchParams(window.location.search).get('who') ?? 'me');
  // Step-ups count down while the page is open: one tick a second.
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => { const timer = window.setInterval(() => setElapsed((value) => value + 1), 1000); return () => window.clearInterval(timer); }, []);
  const scope = team ? who : 'me';
  const people = USERS.filter((user) => !left.has(user.id) && (scope === 'everyone' || (scope === 'me' ? user.id === viewer.id : user.id === scope)));
  const ids = new Set(people.map((person) => person.id));
  // Everyone's view includes bots' sessions on machine-hosted servers; a person's view only that person's.
  const machineIds = scope === 'everyone' ? null : ids;
  const infoFor = (personId: string): ScopeInfo => ({ scope: personId === viewer.id ? 'mine' : personId, access: personId === viewer.id ? 'own' : 'revoke', target: userOf(personId), teamReason: null });
  const grants = MCP_GRANTS.filter((grant) => ids.has(grant.userId) && !gone.has(grant.id));
  const active = grants.filter((grant) => (MCP_ACTIVITY[grant.id]?.perHour ?? 0) > 0);
  const ups = live.filter((entry) => ids.has(entry.userId));
  const expiring = PLUGINS.filter((plugin) => plugin.owner.scope === 'user' && ids.has(plugin.owner.userId) && SIGN_IN_EXPIRY[plugin.id] && !gone.has(plugin.id));
  const devices = people.flatMap((person) => (DEVICES[person.id] ?? []).filter((device) => !gone.has(device.id)).map((device) => ({ ...device, userId: person.id })));
  const online = people.filter((person) => presenceSeenBy(viewer.id, person.id).state !== 'offline');
  const sponsored = botList.filter((bot) => scope === 'everyone' ? team : bot.sponsor === viewer.id && scope === 'me');
  const recent = [
    ...log.filter((entry) => entry.time === 'Just now' && (entry.kind === 'resource' || entry.kind === 'bot')).map((entry) => ({ time: 'now', text: `${userOf(entry.actor).first}: ${entry.text}`, tone: 'warn' as const })),
    ...SESSION_TIMELINE.filter((entry) => ids.has(entry.who)).map((entry) => ({ time: entry.time, text: `${userOf(entry.who).first} · ${entry.text}`, tone: entry.kind === 'revoke' || entry.kind === 'expire' ? ('warn' as const) : entry.kind === 'step-up' ? ('good' as const) : undefined })),
  ];
  const countdown = (minutes: number): string => {
    const seconds = Math.max(0, minutes * 60 - elapsed);
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  };
  return <LivePage title="Sessions" viewer={viewer} description="Who is signed in now, what their MCP clients are doing, cleared shells counting down and sign-ins about to expire, with Revoke on each."
    configure={{ label: 'Passkeys and devices', onClick: () => navigate('settings', { page: 'passkeys' }) }}
    actions={team ? <Select value={who} onValueChange={setWho}>
      <SelectTrigger aria-label="Person" />
      <SelectContent>{[{ id: 'me', name: `Person: Me (${viewer.first})` }, { id: 'everyone', name: 'Person: Everyone' }, ...USERS.filter((user) => user.id !== viewer.id).map((user) => ({ id: user.id, name: `Person: ${user.name}` }))].map((entry, index) => <SelectItem key={entry.id} value={entry.id} index={index}>{entry.name}</SelectItem>)}</SelectContent>
    </Select> : undefined}>
    {team ? null : <Note>Your own sessions. Only Owners and Admins see other people’s; a project’s Leads don’t see their members’ sessions.</Note>}
    <StatStrip>
      <Stat label="Signed in now" value={`${online.length} of ${people.length}`} tone="good" detail={online.map((person) => person.first).join(', ')} />
      <Stat label="MCP clients active" value={String(active.length)} detail={`${active.reduce((sum, grant) => sum + (MCP_ACTIVITY[grant.id]?.perHour ?? 0), 0)} calls in the last hour`} />
      <MachineMcpStat ids={machineIds} />
      <Stat label="Cleared shells open" value={String(ups.length)} detail={ups.map((entry) => `${entry.credential} ${countdown(entry.minutesLeft)}`).join(' · ') || 'None'} tone={ups.some((entry) => entry.minutesLeft <= 15) ? 'warn' : undefined} />
      <Stat label="Sign-ins expiring" value={String(expiring.length)} detail={expiring.map((plugin) => plugin.name).join(', ') || 'None soon'} tone={expiring.length ? 'warn' : undefined} />
    </StatStrip>
    <Section title="Signed in now" description="Presence: where each is and what they’re doing.">
      <div data-presence="" className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 15rem), 1fr))' }}>{people.map((person) => {
        const presence = presenceSeenBy(viewer.id, person.id);
        return <button key={person.id} type="button" onClick={() => navigate('person', { person: person.id })} className={`flex min-w-0 items-start gap-2.5 rounded-xl p-2.5 text-left shadow-[inset_0_0_0_1px_var(--border)] hover:bg-hover ${presence.state === 'offline' ? 'opacity-60' : ''}`}>
          <PresenceAvatar userId={person.id} size={28} tone={presence.state === 'online' ? 'good' : presence.state === 'away' ? 'warn' : 'muted'} />
          <span className="flex min-w-0 flex-col"><span className="truncate text-body font-medium text-foreground">{person.name}{person.id === viewer.id ? ' (you)' : ''}</span>
            <span className="truncate text-caption text-muted-foreground" title={presence.doing || LIMITED_PRESENCE}>{presence.limited ? presenceLine(presence) : `${presence.where ? `${presence.where} · ` : ''}${presence.doing}`}</span>
            <span className="truncate text-[11px] text-muted-foreground">{presence.limited ? LIMITED_PRESENCE : presence.state === 'offline' ? `offline since ${presence.since}` : `since ${presence.since} on ${presence.device}`}</span></span>
        </button>;
      })}</div>
    </Section>
    <Section title="MCP clients" description="Each acts as its person within its slice. Last call and calls an hour.">
      {grants.length ? <PanelGrid min="18rem">{grants.map((grant) => {
        const activity = MCP_ACTIVITY[grant.id];
        return <Panel key={grant.id} id={grant.id} dim={!activity?.perHour} head={<><Terminal size={15} strokeWidth={1.5} /><span className="truncate text-body font-medium text-foreground">{grant.client}</span><Pill tone="blue">as {userOf(grant.userId).first}</Pill><span className="ml-auto text-caption text-muted-foreground">expires {grant.expires}</span></>}>
          <div className="flex items-end justify-between gap-3"><span className="flex min-w-0 flex-col text-caption"><span className="truncate text-foreground" title={activity?.last}>Last call {activity?.last}</span><span className="tabular-nums text-muted-foreground">{activity?.perHour ?? 0} calls in the last hour</span></span>
            <Sparkline values={activity?.series ?? []} width={110} label={`${grant.client} calls over the last hour`} /></div>
          <span className="truncate text-caption text-muted-foreground">{grant.capabilities.join(', ')}</span>
          <div className="flex justify-end"><Act reason={null} variant="ghost" size="compact" aria-label={`Revoke ${userOf(grant.userId).first}’s ${grant.client}`} onClick={() => revokeIn(infoFor(grant.userId), viewer, grant.id, `MCP client ${grant.client}`, 'revoked', say)}>Revoke</Act></div>
        </Panel>;
      })}</PanelGrid> : <Note>No MCP clients.</Note>}
    </Section>
    <MachineMcpSessions ids={machineIds} />
    <PanelGrid min="20rem">
      <Panel id="step-ups" head={<><Fingerprint01 size={15} strokeWidth={1.5} /><span className="text-body font-semibold text-foreground">Cleared shells counting down</span><span className="text-caption text-muted-foreground">secrets stepped up with a passkey</span></>}>
        {ups.length ? ups.map((entry) => <div key={entry.id} data-session-step-up={entry.id} className="flex min-w-0 flex-wrap items-center gap-2">
          <Avatar userId={entry.userId} size={18} /><span className="flex min-w-0 flex-1 flex-col"><span className="truncate font-mono text-caption text-foreground">{entry.credential} · {entry.workspaceId}</span><span className="truncate text-[11px] text-muted-foreground">{entry.scope}</span></span>
          <span className={`font-mono text-caption tabular-nums ${entry.minutesLeft <= 15 ? 'text-[#dc6803]' : 'text-foreground'}`}>{countdown(entry.minutesLeft)}</span>
          <Act reason={null} variant="ghost" size="compact" aria-label={`Drop ${entry.credential}`} onClick={() => { stepUps.set(live.filter((candidate) => candidate.id !== entry.id)); revokeIn(infoFor(entry.userId), viewer, entry.id, `cleared shell ${entry.credential} in ${entry.workspaceId}`, 'dropped', say); }}>Drop</Act>
        </div>) : <Note>None running.</Note>}
      </Panel>
      <Panel id="expiring" head={<><Link03 size={15} strokeWidth={1.5} /><span className="text-body font-semibold text-foreground">Sign-ins expiring</span></>}>
        {expiring.length ? expiring.map((plugin) => <div key={plugin.id} className="flex min-w-0 flex-wrap items-center gap-2">
          <Avatar userId={plugin.owner.scope === 'user' ? plugin.owner.userId : viewer.id} size={18} /><span className="min-w-0 flex-1 truncate text-caption text-foreground">{plugin.name}</span>
          <Pill tone={SIGN_IN_EXPIRY[plugin.id]?.startsWith('expired') ? 'red' : 'amber'}>{SIGN_IN_EXPIRY[plugin.id]}</Pill>
          {plugin.owner.scope === 'user' && plugin.owner.userId === viewer.id ? <Act reason={null} variant="secondary" size="compact" onClick={() => say(`Signs in to ${plugin.name} again`)}>Renew</Act>
            : <Act reason={null} variant="ghost" size="compact" aria-label={`Disconnect ${plugin.name}`} onClick={() => revokeIn(infoFor(plugin.owner.scope === 'user' ? plugin.owner.userId : viewer.id), viewer, plugin.id, plugin.name, 'disconnected', say)}>Disconnect</Act>}
        </div>) : <Note>Nothing expiring soon.</Note>}
      </Panel>
    </PanelGrid>
    <Section title="Timeline" description="Recent sign-ins, step-ups, expiries and revokes.">
      <Events items={recent.slice(0, 10)} />
    </Section>
    <Section title="Signed-in devices">
      <SettingRows label="Signed-in devices">{devices.map((device) => <SettingRow key={device.id} media={glyph(Monitor01)}
        title={<span className="inline-flex flex-wrap items-center gap-2">{device.label}{device.current && device.userId === viewer.id ? <Pill tone="blue">This device</Pill> : null}<span className="inline-flex items-center gap-1 text-caption text-muted-foreground"><Avatar userId={device.userId} size={16} />{userOf(device.userId).first}</span></span>}
        description={`${device.kind} · last used ${device.lastUsed}`}>
        <Act reason={device.current && device.userId === viewer.id ? 'Sign out of this device from its menu' : null} variant="ghost" aria-label={`Sign out ${userOf(device.userId).first}’s ${device.label}`} onClick={() => revokeIn(infoFor(device.userId), viewer, device.id, `device ${device.label}`, 'signed out', say)}>Sign out</Act>
      </SettingRow>)}</SettingRows>
    </Section>
    {sponsored.length ? <Section title="Bots" description="How each bot is signed in. Revoking is audited; a bot with no Admin sponsor has its sign-ins blocked.">
      <SettingRows label="Bot sign-ins">{signIns.filter((entry) => sponsored.some((bot) => bot.id === entry.bot)).map((entry) => {
        const blocked = botList.find((bot) => bot.id === entry.bot)?.sponsor === null;
        return <SettingRow key={entry.id} media={glyph(entry.kind === 'connected' ? Link03 : Key01)}
          title={<span className="inline-flex flex-wrap items-center gap-2"><UserName userId={entry.bot} /> · {entry.label}<Pill tone={entry.kind === 'connected' ? 'blue' : 'teal'}>{entry.kind === 'connected' ? 'Connected client' : 'Client secret'}</Pill>{blocked ? <Pill tone="amber">Blocked</Pill> : null}</span>}
          description={`${entry.capabilities.join(', ')} · last used ${entry.lastUsed}`}>
          <Act reason={null} variant="ghost" aria-label={`Revoke ${entry.label}`} onClick={() => {
            botSignIns.set(botSignIns.get().filter((candidate) => candidate.id !== entry.id));
            recordAudit({ actor: viewer.id, kind: 'bot', text: `Revoked ${actorLabel(entry.bot)}’s ${entry.kind === 'connected' ? 'connected client' : 'client secret'} ${entry.label}` });
            say(`Revoked ${entry.label}`);
          }}>Revoke</Act>
        </SettingRow>;
      })}</SettingRows>
    </Section> : null}
  </LivePage>;
}
