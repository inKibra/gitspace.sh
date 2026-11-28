// Settings is a full page: it replaces the app sidebar, with a "← Back to work" button at the top of its own nav. Then
// the personal pages, then the team's ("Crumb & Co"); where a page sits decides whose things it shows. You: Profile,
// Git identity, Voice, Defaults, Inference (your providers), Plugins (your sign-ins, paired Chrome), Skills, Machines,
// My secrets (your own, and values projects ask you for), My approved scripts, Passkeys and devices, MCP clients.
// Crumb & Co: People & roles (invites and allowed domains inside), Bots (the ones you sponsor first), Inference
// (profiles, team providers, budgets), Plugins (team connections, Slack app, team browsers), Skills, Machines (team
// machines, team SSH key), Machine profiles, Secrets, Approved scripts, Projects, Domains, Source & releases, GitHub
// App, Audit log. A person's page is on People in the app's top row (People & roles links to it).
//
// A bot has a principal profile like a person's. Someone who may manage bots (a bot's sponsor; Owners and Admins, every
// bot) gets a "Settings for" picker under Back to work: you, then each bot they manage. Picking a bot switches the
// personal pages to that bot's: the same components as You's, given the bot as `info.target` (Profile, Git identity,
// Defaults, Inference, Plugins, Skills, Machines, <Bot>'s secrets, <Bot>'s approved scripts, and Sign-ins, which
// merges Passkeys and devices and MCP clients), each under a "You're managing <Bot>'s settings" banner. The pick is the
// URL's `person=<bot>`, so a link to a bot's page opens with it set (page=bots opens its Profile). Anyone else asking
// for a bot's page is refused, with who may.
import { EmptyState, PageCanvas, PageHeader } from '../../GitSpaceShell.js';
import { glyph } from '../../glyph.js';
import { Badge, Button, Select, SelectContent, SelectItem, SelectTrigger, type IconComponent, type IconComponentProps } from '@gitspace/ui';
import {
  BookOpen01, Code02, CpuChip01, CpuChip02, FileSearch02, FolderClosed, GitBranch01, Globe04, Key01, LayersThree01, Lock01, Microphone01, PuzzlePiece01, Rocket01, Server01, Sliders01, Stars01, Terminal, User01, Users01,
} from '@untitledui/icons';
import { useEffect, type ComponentType, type ReactNode } from 'react';
import { actorLabel, bots, findPrincipal, userOf, type Bot, type User } from '../data.js';
import { BotBlockedNotice } from '../flows/bots.js';
import { resolveScope, ScopeBanner, type ScopeInfo } from '../scope.js';
import { InferenceSettings } from '../scoped/inference.js';
import { MachinesSettings } from '../scoped/machines.js';
import { PluginsSettings } from '../scoped/plugins.js';
import { SkillsSettings } from '../scoped/skills.js';
import { useMock, useViewer } from '../viewer.js';
import { DomainsPage, GitHubAppPage, SourcePage } from './account.js';
import { AuditPage } from './audit.js';
import { ACCOUNT_NAME } from './data.js';
import { FullPage, NavGroup, NavItem } from './frame.js';
import { Avatar } from './parts.js';
import { DefaultsPage, GitIdentityPage, McpClientsPage, PasskeysPage, PersonalSecretsPage, ProfilePage, VoicePage } from './personal.js';
import { ProjectsPage } from './projects.js';
import { accountRoleOf, useRoles, whyAccount, type AccountAction } from './roles.js';
import { SecretsPage } from './secrets.js';
import { MachineProfilesPage } from './machine-profiles.js';
import { PrincipalScriptsPage, TeamScriptsPage } from './scripts.js';
import { BotsPage } from './bot-pages.js';
import { TeamPage } from './team.js';

export interface SettingsPageInfo {
  id: string;
  group: 'you' | 'team';
  label: string;
  description: string;
  icon: IconComponent;
  /** The account action that edits a team page; without it the page reads only. */
  teamAction: AccountAction;
  visible(viewerId: string): boolean;
  /** On a You page that a bot has too: its label and description under Bot · name. Without it the bot has no such page. */
  bot?: (name: string) => { label: string; description: string };
  Page: ComponentType<{ navigate(page: string, person?: string): void; info: ScopeInfo }>;
}
const everyone = (): boolean => true;

/** My approved scripts, or a bot's: the scripts page of whoever `info.target` is. */
function ApprovedScriptsPage({ info }: { info: ScopeInfo }) {
  return info.target ? <PrincipalScriptsPage principalId={info.target.id} /> : null;
}

export const SETTINGS_PAGES: readonly SettingsPageInfo[] = [
  { id: 'profile', group: 'you', label: 'Profile', description: 'Name, avatar, account role and projects.', icon: glyph(User01), teamAction: 'account.team', visible: everyone, bot: (name) => ({ label: 'Profile', description: `Name, handle, avatar and sponsor; ${name}’s roles and projects, what it did, and its audit trail.` }), Page: ProfilePage },
  { id: 'git', group: 'you', label: 'Git identity', description: 'How commits from turns you start are authored, and your SSH key.', icon: glyph(GitBranch01), teamAction: 'account.team', visible: everyone, bot: (name) => ({ label: 'Git identity', description: `The commit author of turns ${name} starts, and how it reaches GitHub: the team’s App, or its own machine-user account with a fine-grained token.` }), Page: GitIdentityPage },
  { id: 'voice', group: 'you', label: 'Voice', description: 'Dictation and spoken replies.', icon: glyph(Microphone01), teamAction: 'account.team', visible: everyone, Page: VoicePage },
  { id: 'defaults', group: 'you', label: 'Defaults', description: 'What a new run starts with.', icon: glyph(Sliders01), teamAction: 'account.team', visible: everyone, bot: (name) => ({ label: 'Defaults', description: `What a new run ${name} starts begins with.` }), Page: DefaultsPage },
  { id: 'my-inference', group: 'you', label: 'Inference', description: 'Your own providers and the projects where each can pay.', icon: glyph(Stars01), teamAction: 'account.inference', visible: everyone, bot: (name) => ({ label: 'Inference', description: `${name}’s own providers (its own API key) and where each may pay. The team’s profiles apply as for anyone.` }), Page: InferenceSettings },
  { id: 'my-plugins', group: 'you', label: 'Plugins', description: 'Your sign-ins, Composio links and paired Chrome; they join workspaces while you hold the handle.', icon: glyph(PuzzlePiece01), teamAction: 'account.connections', visible: everyone, bot: (name) => ({ label: 'Plugins', description: `Sign-ins made as ${name}, like its own Slack or Linear token; they join workspaces while it holds the handle.` }), Page: PluginsSettings },
  { id: 'my-skills', group: 'you', label: 'Skills', description: 'Your skills; they travel with you into workspaces you hold.', icon: glyph(BookOpen01), teamAction: 'account.connections', visible: everyone, bot: (name) => ({ label: 'Skills', description: `${name}’s skills; its agents load them in workspaces it holds.` }), Page: SkillsSettings },
  { id: 'my-machines', group: 'you', label: 'Machines', description: 'Your machines; they join a workspace while you hold its handle.', icon: glyph(Server01), teamAction: 'account.resources', visible: everyone, bot: (name) => ({ label: 'Machines', description: `Machines ${name} owns, if any.` }), Page: MachinesSettings },
  { id: 'my-secrets', group: 'you', label: 'My secrets', description: 'Your own secrets (each opens in a cleared shell for some minutes after your passkey) and the values projects ask you for, each with its rule.', icon: glyph(Lock01), teamAction: 'account.credentials', visible: everyone, bot: (name) => ({ label: `${name}’s secrets`, description: `${name}’s own secrets, each with its rule. Delivered to approved scripts, by browser autofill, or with its sponsor approving each use with their passkey; never to a shell, since a bot has no passkey.` }), Page: PersonalSecretsPage },
  { id: 'my-scripts', group: 'you', label: 'My approved scripts', description: 'Scripts you approved for yourself, and the ones waiting on your approval.', icon: glyph(Code02), teamAction: 'account.credentials', visible: everyone, bot: (name) => ({ label: `${name}’s approved scripts`, description: `Scripts approved for ${name}’s agents, and the versions they submitted that wait on approval.` }), Page: ApprovedScriptsPage },
  { id: 'passkeys', group: 'you', label: 'Passkeys and devices', description: 'Yours alone.', icon: glyph(Key01), teamAction: 'account.team', visible: everyone, bot: (name) => ({ label: 'Sign-ins', description: `How ${name} signs in over MCP: connected clients and client secrets, each with its slice of its projects and capabilities.` }), Page: PasskeysPage },
  { id: 'mcp', group: 'you', label: 'MCP clients', description: 'Apps that act as you over MCP, each a slice of your permissions.', icon: glyph(Terminal), teamAction: 'account.team', visible: everyone, Page: McpClientsPage },
  { id: 'people', group: 'team', label: 'People & roles', description: 'People, invites and allowed email domains, and the roles that decide what each may do.', icon: glyph(Users01), teamAction: 'account.team', visible: everyone, Page: TeamPage },
  { id: 'bots', group: 'team', label: 'Bots', description: 'Principals that aren’t people: sponsored, Member at most, acting only over MCP.', icon: glyph(CpuChip02), teamAction: 'account.bots', visible: everyone, Page: BotsPage },
  { id: 'inference', group: 'team', label: 'Inference', description: 'Profiles projects apply, the team’s providers and budgets.', icon: glyph(Stars01), teamAction: 'account.inference', visible: everyone, Page: InferenceSettings },
  { id: 'plugins', group: 'team', label: 'Plugins', description: 'Team connections, the Slack app and team browsers, switched on per project.', icon: glyph(PuzzlePiece01), teamAction: 'account.connections', visible: everyone, Page: PluginsSettings },
  { id: 'skills', group: 'team', label: 'Skills', description: 'The team’s skills, on per project.', icon: glyph(BookOpen01), teamAction: 'account.connections', visible: everyone, Page: SkillsSettings },
  { id: 'machines', group: 'team', label: 'Machines', description: 'Team machines and the team SSH key.', icon: glyph(Server01), teamAction: 'account.resources', visible: everyone, Page: MachinesSettings },
  { id: 'machine-profiles', group: 'team', label: 'Machine profiles', description: 'What a machine must have for a kind of work: checks, setup and teardown scripts approved by hash, and which machines are ready.', icon: glyph(LayersThree01), teamAction: 'account.resources', visible: everyone, Page: MachineProfilesPage },
  { id: 'secrets', group: 'team', label: 'Secrets', description: 'The team’s secrets, tokens, logins and sessions, each with who may use it and how it’s delivered. A project’s own are in its settings.', icon: glyph(Lock01), teamAction: 'account.credentials', visible: everyone, Page: SecretsPage },
  { id: 'scripts', group: 'team', label: 'Approved scripts', description: 'Scripts agents run by name with secrets only they get: the team’s, plus the project and personal ones you can see.', icon: glyph(Code02), teamAction: 'account.credentials', visible: everyone, Page: TeamScriptsPage },
  { id: 'projects', group: 'team', label: 'Projects', description: 'The projects you’re in, each with its own settings; Admins join the ones they aren’t in.', icon: glyph(FolderClosed), teamAction: 'account.team', visible: everyone, Page: ProjectsPage },
  { id: 'domains', group: 'team', label: 'Domains', description: 'The account’s address, custom domains and workspace preview domains.', icon: glyph(Globe04), teamAction: 'account.team', visible: everyone, Page: DomainsPage },
  { id: 'source', group: 'team', label: 'Source & releases', description: 'Which GitSpace the account runs and when it updates.', icon: glyph(Rocket01), teamAction: 'account.team', visible: everyone, Page: SourcePage },
  { id: 'github', group: 'team', label: 'GitHub App', description: 'The GitHub App installed for the team and the repositories it reaches.', icon: glyph(GitBranch01), teamAction: 'account.team', visible: everyone, Page: GitHubAppPage },
  { id: 'audit', group: 'team', label: 'Audit log', description: 'Who did what: people, their MCP clients and bots (with their sponsor). Owners and Admins only.', icon: glyph(FileSearch02), teamAction: 'account.audit', visible: (viewerId) => whyAccount(viewerId, 'account.audit') === null, Page: AuditPage },
];

type BotPageInfo = SettingsPageInfo & { bot: NonNullable<SettingsPageInfo['bot']> };
/** The pages a bot has, in You's order. */
const BOT_PAGES: readonly BotPageInfo[] = SETTINGS_PAGES.filter((entry): entry is BotPageInfo => entry.bot !== undefined);
/** The bot page a `page` id opens: the Bots list's link (bots) opens Profile; MCP clients are part of Sign-ins. */
function botPageOf(page: string | null): BotPageInfo {
  const id = page === 'mcp' ? 'passkeys' : page;
  return BOT_PAGES.find((entry) => entry.id === id) ?? BOT_PAGES[0]!;
}

/** A principal's avatar as a Select icon, one per principal so the trigger keeps the same component. */
const avatarIcons = new Map<string, IconComponent>();
function avatarIcon(id: string): IconComponent {
  const known = avatarIcons.get(id);
  if (known) return known;
  const icon = ({ size = 16 }: IconComponentProps) => <Avatar userId={id} size={size + 2} />;
  avatarIcons.set(id, icon);
  return icon;
}

/** "Settings for": whose personal pages the nav shows. You first, then each bot the viewer manages; switching keeps the
 * page when the other principal has it, else opens Profile. */
function PrincipalPicker({ viewer, managed, current, page, navigate }: { viewer: User; managed: readonly Bot[]; current: string; page: string; navigate(page: string, person?: string): void }) {
  const options = [{ id: viewer.id, label: `${viewer.first} (you)` }, ...managed.map((bot) => ({ id: bot.id, label: `${bot.name} · ${bot.sponsor ? `sponsored by ${bot.sponsor === viewer.id ? 'you' : userOf(bot.sponsor).first}` : 'no sponsor'}` }))];
  return <div data-settings-for="" className="flex flex-col gap-1">
    <span className="px-2 text-caption font-semibold uppercase tracking-wide text-muted-foreground">Settings for</span>
    <Select value={current} onValueChange={(id) => id === viewer.id ? navigate(page) : navigate(botPageOf(page).id, id)}>
      <SelectTrigger aria-label="Settings for" icon={avatarIcon(current)} className="w-full" />
      <SelectContent>{options.map((option, index) => <SelectItem key={option.id} value={option.id} index={index} icon={avatarIcon(option.id)}>{option.label}</SelectItem>)}</SelectContent>
    </Select>
  </div>;
}

export function SettingsPage({ page, person, navigate, onBack }: { page: string | null; person: string | null; navigate(page: string, person?: string): void; onBack(): void }) {
  const viewer = useViewer();
  useRoles();
  const list = bots.use();
  const target = person && person !== viewer.id ? findPrincipal(person) : undefined;
  const bot = target?.kind === 'bot' ? target : null;
  const resolved = bot ? resolveScope(viewer, bot.id, 'account.bots') : null;
  const managing = resolved && !('refused' in resolved) ? resolved : null;
  const botPage = bot ? botPageOf(page) : null;
  const managed = list.filter((entry) => !('refused' in resolveScope(viewer, entry.id, 'account.bots')));
  const current = SETTINGS_PAGES.find((entry) => entry.id === page) ?? SETTINGS_PAGES[0]!;
  const visible = SETTINGS_PAGES.filter((entry) => entry.visible(viewer.id));
  const nav = <>
    {managed.length ? <PrincipalPicker viewer={viewer} managed={managed} current={bot && managing ? bot.id : viewer.id} page={botPage?.id ?? current.id} navigate={navigate} /> : null}
    {bot && managing && botPage ? <NavGroup id="bot" title={null}>
      {BOT_PAGES.map((entry) => <NavItem key={entry.id} id={`bot-${entry.id}`} label={entry.bot(bot.name).label} icon={entry.icon} active={entry.id === botPage.id} onClick={() => navigate(entry.id, bot.id)} />)}
    </NavGroup> : <NavGroup id="you" title={managed.length ? null : `You · ${viewer.first}`}>
      {visible.filter((entry) => entry.group === 'you').map((entry) => <NavItem key={entry.id} id={entry.id} label={entry.label} icon={entry.icon} active={!bot && entry.id === current.id} onClick={() => navigate(entry.id)} />)}
    </NavGroup>}
    <NavGroup id="team" title={ACCOUNT_NAME}>
      {visible.filter((entry) => entry.group === 'team').map((entry) => <NavItem key={entry.id} id={entry.id} label={entry.label} icon={entry.icon} active={!bot && entry.id === current.id} onClick={() => navigate(entry.id)} />)}
    </NavGroup>
  </>;
  const badge = <Badge color="gray">Viewing as {viewer.first} · account role {accountRoleOf(viewer.id)?.name}</Badge>;
  return <FullPage back="Back to work" onBack={onBack} nav={nav}>
    <PageCanvas>
      {bot && botPage ? <BotSettings bot={bot} entry={botPage} info={managing} badge={badge} navigate={navigate} />
        : target?.kind === 'person' ? <PersonMoved personId={target.id} />
        : <>
          <PageHeader kicker={current.group === 'team' ? `${ACCOUNT_NAME} · Settings` : `You · ${viewer.name}`} title={current.label} description={current.description} actions={badge} />
          {visible.includes(current) ? <div className="flex flex-col gap-10">
            <current.Page key={`${current.id}:${viewer.id}`} navigate={navigate}
              info={current.group === 'team' ? { scope: 'team', access: whyAccount(viewer.id, current.teamAction) ? 'team-read' : 'team-edit', target: null, teamReason: whyAccount(viewer.id, current.teamAction) } : { scope: 'mine', access: 'own', target: viewer, teamReason: null }} />
          </div> : <EmptyState icon={<Key01 width={22} height={22} strokeWidth={1.5} />} title={`${current.label} isn’t available to ${viewer.first}`}
            description={`${whyAccount(viewer.id, current.teamAction)}. The audit log is for Owners and Admins.`}
            action={<Button variant="secondary" onClick={() => navigate('profile')}>Open Profile</Button>} />}
        </>}
    </PageCanvas>
  </FullPage>;
}

/** Someone's page is on People (the app's top row); an old Settings link to it goes there. */
function PersonMoved({ personId }: { personId: string }) {
  const { navigate } = useMock();
  useEffect(() => { navigate('person', { person: personId }); }, [navigate, personId]);
  return null;
}

/** Bot · name › page: the You page `entry` for the bot, under the managing banner (and, with no sponsor, the blocked
 * notice). `info` is null when the viewer may not manage it: refused, with who may. */
function BotSettings({ bot, entry, info, badge, navigate }: { bot: Bot; entry: BotPageInfo; info: ScopeInfo | null; badge: ReactNode; navigate(page: string, person?: string): void }) {
  const viewer = useViewer();
  const copy = entry.bot(bot.name);
  const head = <PageHeader kicker={<span data-bot-kicker={bot.id}>Bot · {bot.name} · {bot.sponsor ? `sponsored by ${userOf(bot.sponsor).first}` : 'no sponsor'}</span>}
    title={info ? copy.label : bot.name} description={info ? copy.description : undefined} actions={badge} />;
  if (!info) return <>{head}<EmptyState icon={<CpuChip01 width={22} height={22} strokeWidth={1.5} />} title={`${bot.name} isn’t open to ${viewer.first}`}
    description={`Only ${bot.sponsor ? `${userOf(bot.sponsor).first} (its sponsor)` : 'its sponsor'}, Owners and Admins open a bot’s settings and manage its profile, roles, sign-ins, secrets and Git identity. ${viewer.first}’s account role is ${accountRoleOf(viewer.id)?.name}. Its actions read “${actorLabel(bot.id)}” wherever it works.`}
    action={<Button variant="secondary" onClick={() => navigate('bots')}>Back to Bots</Button>} /></>;
  return <>
    {head}
    <div className="flex flex-col gap-10">
      <ScopeBanner info={info} noun="settings" />
      <BotBlockedNotice bot={bot} />
      <entry.Page key={`${entry.id}:${bot.id}:${viewer.id}`} navigate={navigate} info={info} />
    </div>
  </>;
}
