// Plugins settings, by placement, with the real app's tabs: Composio, Custom MCP, Browsers. Crumb & Co › Plugins: Jira
// with a service token, the internal MCP server, the Slack app, the team Composio account (off), the cloud browser and
// team Chromes, each on in the projects whose settings turn it on. You › Plugins: your Slack and Linear sign-ins, your
// Composio links, your paired Chrome, each saying where it applies. Bot › Plugins: sign-ins made as the bot (its own
// Slack or Linear token), managed by its sponsor, Owners and Admins; a bot pairs no Chrome. Someone else's (People ›
// person): the same as theirs, revoke only (disconnect, unpair). Your own secrets (the old step-ups) are under You › My
// secrets. Custom MCP also lists the servers hosted on machines (team machines on the team's page, your own on yours)
// with Add MCP server.
// Every action opens its dialog from `flows/resources.tsx`; the machine-hosted ones from `flows/machine-mcp.tsx`.
import { glyph } from '../../glyph.js';
import { Switch, TabsSubtle, TabsSubtleItem } from '@gitspace/ui';
import { Cloud01, Globe02, Link03, Plus, PuzzlePiece01 } from '@untitledui/icons';
import { useState } from 'react';
import type { Principal } from '../data.js';
import { MachineMcpSection } from '../flows/machine-mcp.js';
import { BrowserProjectsFlow, ComposioSwitchFlow, ConfigurePluginFlow, ConfirmFlow, DisconnectTeamPluginFlow, PairChromeFlow, PersonalPluginFlow, SlackAppFlow, TeamPluginFlow, UnpairTeamBrowserFlow } from '../flows/resources.js';
import { browsers, plugins, slackChannels, teamComposio } from '../flows/resources-data.js';
import { projectName, projectSettings, revoked, type Browser, type Plugin, type PluginTab } from '../settings/data.js';
import { Act, Note, Pill, Section, SettingRow, SettingRows } from '../settings/parts.js';
import { revokeIn, revokeOnly, whose, type ScopeInfo } from '../scope.js';
import { useMock, useViewer } from '../viewer.js';
import { listNames, pluginReach } from './common.js';

const TABS: readonly PluginTab[] = ['composio', 'mcp', 'browsers'];
const TAB_LABEL: Readonly<Record<PluginTab, string>> = { composio: 'Composio', mcp: 'Custom MCP', browsers: 'Browsers' };
const STATUS: Readonly<Record<Plugin['status'], { tone: 'green' | 'amber' | 'gray'; label: string }>> = { connected: { tone: 'green', label: 'Connected' }, 'sign-in-required': { tone: 'amber', label: 'Sign-in required' }, off: { tone: 'gray', label: 'Off' } };

export function PluginsSettings({ info }: { info: ScopeInfo }) {
  const [tab, setTab] = useState<PluginTab>(() => TABS.find((entry) => entry === new URLSearchParams(window.location.search).get('tab')) ?? 'mcp');
  return <>
    <TabsSubtle selectedIndex={TABS.indexOf(tab)} idPrefix="plugins-tab" onSelect={(index) => setTab(TABS[index] ?? 'mcp')}>
      {TABS.map((entry, index) => <TabsSubtleItem key={entry} index={index} label={TAB_LABEL[entry]} />)}
    </TabsSubtle>
    {tab === 'browsers' ? <Browsers info={info} /> : <PluginList info={info} tab={tab} />}
    {tab === 'mcp' ? <MachineMcpSection info={info} /> : null}
  </>;
}

function Reach({ person, own }: { person: Principal; own: boolean }) {
  const reach = pluginReach(person.id);
  return <span className="flex flex-col gap-0.5 text-caption">
    <span className="text-foreground">{reach.on.length ? `Used while ${own ? 'you hold' : `${person.first} holds`} the handle in ${listNames(reach.on)}` : 'Not used in any project now'}</span>
    {reach.off.length ? <span className="text-muted-foreground">Not in {listNames(reach.off)}: {reach.off.length === 1 ? 'its' : 'their'} settings don’t allow holders’ own plugins</span> : null}
  </span>;
}

/** The dialog a plugin action opened. */
type PluginFlow = { kind: 'add' } | { kind: 'reconnect'; plugin: Plugin } | { kind: 'composio' } | { kind: 'configure'; plugin: Plugin } | { kind: 'disconnect'; plugin: Plugin };

function PluginList({ info, tab }: { info: ScopeInfo; tab: 'composio' | 'mcp' }) {
  const viewer = useViewer();
  const { say } = useMock();
  const gone = revoked.use();
  const composioOn = teamComposio.use();
  const settings = projectSettings.use();
  const channels = slackChannels.use();
  const [flow, setFlow] = useState<PluginFlow | null>(null);
  const team = info.access === 'team-edit' || info.access === 'team-read';
  const edit = info.access === 'team-read' ? info.teamReason : null;
  const person = info.target;
  const bot = person?.kind === 'bot' ? person : null;
  const own = info.access === 'own';
  const list = plugins.use().filter((plugin) => plugin.tab === tab && !gone.has(plugin.id) && (team ? plugin.owner.scope === 'account' : plugin.owner.scope === 'user' && plugin.owner.userId === person?.id));
  const onIn = (pluginId: string) => Object.entries(settings).filter(([, entry]) => entry.teamPlugins.includes(pluginId)).map(([id]) => id);
  const onlyRevoke = revokeOnly(info, viewer);
  const addLabel = tab === 'composio' ? (team ? 'Connect a toolkit as the team' : 'Link a Composio toolkit') : (team ? 'Add an MCP server' : 'Sign in to an MCP server');
  const status = (plugin: Plugin): Plugin['status'] => plugin.id === 'team-composio' ? (composioOn ? 'connected' : 'off') : plugin.status;
  const close = () => setFlow(null);
  return <Section title={`${TAB_LABEL[tab]} · ${team ? 'Team' : own ? 'You' : person?.first}`} scope={team ? 'Team' : 'You'} readOnly={edit}
    description={team ? (tab === 'composio' ? `Toolkits connected through the team’s Composio account. ${composioOn ? 'It’s on: Owners and Admins connect toolkits as the team.' : 'It’s off, so nothing connects through it until an Owner or Admin turns it on.'}` : 'Servers set up once for the team with a service token, and the Slack app GitSpace runs for the team. Each project’s settings switch them on.')
      : bot ? `Sign-ins made as ${bot.name}, with its own accounts and tokens. They join a workspace only while ${bot.name} holds its handle, and its tools act as “${bot.name}”. The team’s plugins apply to it as to anyone.` : `${whose(info) === 'your' ? 'Your' : whose(info)} own sign-ins. They join a workspace only while ${own ? 'you hold' : `${person?.first} holds`} its handle, and leave when ${own ? 'you let' : 'they let'} go.`}
    actions={<Act reason={team ? edit : onlyRevoke} variant="secondary" leadingIcon={glyph(Plus)} onClick={() => setFlow({ kind: 'add' })}>{addLabel}</Act>}>
    {list.length ? <SettingRows label={TAB_LABEL[tab]}>{list.map((plugin) => <SettingRow key={plugin.id} media={glyph(plugin.tab === 'composio' ? PuzzlePiece01 : Link03)}
      title={<span data-plugin={plugin.id} className="inline-flex flex-wrap items-center gap-2">{plugin.name}<Pill>{plugin.auth}</Pill><Pill tone={STATUS[status(plugin)].tone}>{STATUS[status(plugin)].label}</Pill></span>}
      description={<>{plugin.detail} · last used {plugin.lastUsed} · {plugin.calls} tool calls today</>}
      extra={<div className="mt-1">{team ? <span className="text-caption text-foreground">{plugin.id === 'slack-app' ? `${channels.map((channel) => channel.name).join(', ')} · ` : ''}{onIn(plugin.id).length ? `On in ${listNames(onIn(plugin.id))} (project settings)` : 'On in no project'}</span> : person ? <Reach person={person} own={own} /> : null}</div>}>
      {team ? <>
        {plugin.id === 'team-composio' ? <Switch label="Team Composio account" checked={composioOn} disabled={edit !== null} onToggle={() => setFlow({ kind: 'composio' })} />
          : <><Act reason={edit} variant="ghost" aria-label={`Configure ${plugin.name}`} onClick={() => setFlow({ kind: 'configure', plugin })}>Configure</Act>
            <Act reason={edit} variant="ghost" aria-label={`Disconnect ${plugin.name}`} onClick={() => setFlow({ kind: 'disconnect', plugin })}>Disconnect</Act></>}
      </> : <>
        {plugin.status === 'sign-in-required' ? <Act reason={own || bot ? null : `Only ${person?.first} signs in to their own ${plugin.name}`} variant="secondary" aria-label={`Reconnect ${plugin.name}`} onClick={() => setFlow({ kind: 'reconnect', plugin })}>Reconnect</Act> : null}
        <Act reason={null} variant="ghost" aria-label={`Disconnect ${plugin.name}`} onClick={() => setFlow({ kind: 'disconnect', plugin })}>Disconnect</Act>
      </>}
    </SettingRow>)}</SettingRows> : <Note>{team ? 'Nothing here.' : `${own ? 'You haven’t' : `${person?.first} hasn’t`} connected any ${TAB_LABEL[tab]} plugins.`}</Note>}
    {flow?.kind === 'add' ? (team ? <TeamPluginFlow tab={tab} onClose={close} /> : <PersonalPluginFlow tab={tab} principal={bot ?? undefined} onClose={close} />) : null}
    {flow?.kind === 'reconnect' ? <PersonalPluginFlow tab={tab} reconnect={flow.plugin} principal={bot ?? undefined} onClose={close} /> : null}
    {flow?.kind === 'composio' ? <ComposioSwitchFlow on={composioOn} onClose={close} /> : null}
    {flow?.kind === 'configure' ? (flow.plugin.id === 'slack-app' ? <SlackAppFlow onClose={close} /> : <ConfigurePluginFlow plugin={flow.plugin} onClose={close} />) : null}
    {flow?.kind === 'disconnect' && team ? <DisconnectTeamPluginFlow plugin={flow.plugin} onClose={close} /> : null}
    {flow?.kind === 'disconnect' && !team ? <ConfirmFlow id="disconnect-plugin" title={`Disconnect ${flow.plugin.name}?`} confirmLabel="Disconnect" onClose={close}
      description={own ? `It leaves workspaces you hold at their next turn, and its sign-in is deleted. Connecting it again takes ${flow.plugin.name}’s sign-in page.` : bot ? `${bot.name}’s ${flow.plugin.name} leaves the workspaces it holds at their next turn, and its sign-in is deleted. It’s in the audit log.` : `${person?.first}’s ${flow.plugin.name} leaves their workspaces. ${person?.first} is told in their Inbox and it’s in the audit log. You never see or use the sign-in.`}
      success={{ title: `${flow.plugin.name} disconnected`, body: own ? 'Connect it again any time.' : bot ? 'In the audit log.' : `${person?.first} is told; in the audit log.` }}
      onConfirm={() => revokeIn(info, viewer, flow.plugin.id, flow.plugin.name, 'disconnected', say)} /> : null}
  </Section>;
}

/** The dialog a browser action opened. */
type BrowserFlow = { kind: 'pair' } | { kind: 'projects'; browser: Browser } | { kind: 'unpair'; browser: Browser };

function Browsers({ info }: { info: ScopeInfo }) {
  const viewer = useViewer();
  const { say } = useMock();
  const gone = revoked.use();
  const [flow, setFlow] = useState<BrowserFlow | null>(null);
  const team = info.access === 'team-edit' || info.access === 'team-read';
  const edit = info.access === 'team-read' ? info.teamReason : null;
  const person = info.target;
  const bot = person?.kind === 'bot' ? person : null;
  const own = info.access === 'own';
  const list = browsers.use().filter((browser) => !gone.has(browser.id) && (team ? browser.owner.scope === 'account' : browser.owner.scope === 'user' && browser.owner.userId === person?.id));
  const close = () => setFlow(null);
  const row = (browser: Browser) => <SettingRow key={browser.id} media={glyph(browser.builtIn ? Cloud01 : Globe02)}
    title={<span data-browser={browser.id} className="inline-flex items-center gap-2">{browser.label}{browser.builtIn ? <Pill tone="blue">Built in</Pill> : <Pill tone={browser.online ? 'green' : 'gray'}>{browser.online ? 'Online' : 'Offline'}</Pill>}</span>}
    description={<>{browser.detail} · last used {browser.lastUsed}</>}
    extra={<div className="mt-1 flex flex-col gap-0.5 text-caption text-muted-foreground">
      {team ? <span className="text-foreground">Approved in {listNames(browser.projects) || 'no project'}</span> : person ? <Reach person={person} own={own} /> : null}
      {(browser.detached ?? []).map((item) => <span key={item.workspaceId}><Pill tone="amber">Detached</Pill> {item.workspaceId}: {item.process} · since {item.since}</span>)}
    </div>}>
    {team ? <><Act reason={edit} variant="ghost" aria-label={`Projects of ${browser.label}`} onClick={() => setFlow({ kind: 'projects', browser })}>Projects</Act>{browser.builtIn ? null : <Act reason={edit} variant="ghost" aria-label={`Unpair ${browser.label}`} onClick={() => setFlow({ kind: 'unpair', browser })}>Unpair</Act>}</>
      : <Act reason={null} variant="ghost" aria-label={`Unpair ${browser.label}`} onClick={() => setFlow({ kind: 'unpair', browser })}>Unpair</Act>}
  </SettingRow>;
  return <Section title={`Browsers · ${team ? 'Team' : own ? 'You' : person?.first}`} scope={team ? 'Team' : 'You'} readOnly={edit}
    description={team ? 'The cloud browser and Chromes paired to the team, signed in to the team’s sites. Approved per project.' : bot ? `${bot.name} pairs no Chrome: a paired Chrome is a person’s, signed in as them. Its agents use the team’s browsers where a project approves them; its own logins reach a page by browser autofill from ${bot.name}’s secrets.` : `Chromes ${own ? 'you paired' : `${person?.first} paired`}, signed in as ${own ? 'you' : 'them'}. Agents use one only in workspaces ${own ? 'you hold' : 'they hold'}, in a tab group of their own.`}
    actions={<Act reason={team ? edit : bot ? `A paired Chrome is a person’s; ${bot.name} uses the team’s browsers` : revokeOnly(info, viewer)} variant="secondary" leadingIcon={glyph(Plus)} onClick={() => setFlow({ kind: 'pair' })}>Pair a Chrome</Act>}>
    {list.length ? <SettingRows label="Browsers">{list.map(row)}</SettingRows> : <Note>{bot ? `${bot.name} has no browsers of its own.` : 'No browsers here.'}</Note>}
    {flow?.kind === 'pair' ? <PairChromeFlow team={team} onClose={close} /> : null}
    {flow?.kind === 'projects' ? <BrowserProjectsFlow browser={flow.browser} onClose={close} /> : null}
    {flow?.kind === 'unpair' && team ? <UnpairTeamBrowserFlow browser={flow.browser} onClose={close} /> : null}
    {flow?.kind === 'unpair' && !team ? <ConfirmFlow id="unpair-browser" title={`Unpair ${flow.browser.label}?`} confirmLabel="Unpair" onClose={close}
      description={own ? 'Agents stop using it in every project; tabs in their groups close. Using it again means pairing it again.' : `Agents stop using ${person?.first}’s Chrome. ${person?.first} is told in their Inbox and it’s in the audit log.`}
      success={{ title: `${flow.browser.label} unpaired`, body: own ? 'Pair it again any time.' : `${person?.first} is told; in the audit log.` }}
      onConfirm={() => revokeIn(info, viewer, flow.browser.id, flow.browser.label, 'unpaired', say)} /> : null}
  </Section>;
}
