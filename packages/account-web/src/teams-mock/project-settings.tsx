// A project's own settings, a full page like Settings: it replaces the app sidebar, with "← Back to <project>" (the
// project overview) above its own nav: members and project roles; its repositories; its inference profile; plugins
// (which team plugins are on, which of the team's machine-hosted MCP servers are on, whether holders' own plugins are
// allowed, and the ones the repository declares in .gitspace/bundle.json); secrets, each with its rule, and the values
// it asks of each holder; the environment it may run and open;
// automation definitions (failed runs show in the board's Needs you, running ones on the project card and overview).
// The project's Leads edit (Owners are Lead everywhere); everyone else in the project reads, with the role that blocks
// editing named. Every action opens its flow from src/flows/project.tsx.
import { PageCanvas, PageHeader } from '../GitSpaceShell.js';
import { glyph } from '../glyph.js';
import { Badge, Button, InputField, InputGroup, Select, SelectContent, SelectItem, SelectTrigger, Switch, Tooltip, type IconComponent } from '@gitspace/ui';
import { Building07, CpuChip01, FileCode01, GitBranch01, Key01, Link03, Lock01, Plus, Terminal, User01, Users01, Zap } from '@untitledui/icons';
import { useState } from 'react';
import { userOf, visibleProjects } from './data.js';
import { ChoiceCards, FlowDialog, FlowSuccess, Hint } from './flows/kit.js';
import { ProjectMachineMcp } from './flows/machine-mcp.js';
import { AddSecretDialog, automations, AutomationStateDialog, Gate, NewAutomationWizard, PluginToggleDialog, ProfileChangeDialog } from './flows/project.js';
import { secretRules } from './flows/env-model.js';
import { startingRule } from './flows/secret-rules.js';
import { secrets } from './flows/team-data.js';
import { valueStates } from './flows/you-data.js';
import { EnvironmentSection, RepositoriesSection } from './project-setup.js';
import { ACCOUNT_NAME, ACTIVE_PROJECTS, MODEL_CREDENTIALS, PERSONAL_KINDS, PERSONAL_VALUES, PLUGINS, PROFILES, projectName, projectSettings, recordAudit, type ProjectSettings, type SecretEntry } from './settings/data.js';
import { FullPage, NavGroup, NavItem } from './settings/frame.js';
import { Act, Note, Pill, Section, SettingRow, SettingRows } from './settings/parts.js';
import { MembersSection } from './settings/projects.js';
import { ProjectScriptsSection } from './settings/scripts.js';
import { projectRoleOf, useRoles, why, whyAccount } from './settings/roles.js';
import { AskedValues, SecretsList } from './settings/secrets.js';
import { useMock, useViewer } from './viewer.js';

const SECTIONS = ['members', 'repositories', 'inference', 'plugins', 'secrets', 'environment', 'scripts', 'automations'] as const;
type ProjectSection = (typeof SECTIONS)[number];
const SECTION_LABEL: Readonly<Record<ProjectSection, string>> = { members: 'Members', repositories: 'Repositories', inference: 'Inference', plugins: 'Plugins', secrets: 'Secrets', environment: 'Environment', scripts: 'Approved scripts', automations: 'Automations' };
const SECTION_ICON: Readonly<Record<ProjectSection, IconComponent>> = { members: glyph(Users01), repositories: glyph(GitBranch01), inference: glyph(CpuChip01), plugins: glyph(Link03), secrets: glyph(Lock01), environment: glyph(Terminal), scripts: glyph(FileCode01), automations: glyph(Zap) };

export function ProjectSettingsPage({ project, section, onProject, onSection, onBack }: { project: string; section: string; onProject(project: string): void; onSection(section: string): void; onBack(): void }) {
  const viewer = useViewer();
  useRoles();
  const settings = projectSettings.use();
  const seen = visibleProjects(viewer.id);
  const projects = ACTIVE_PROJECTS.filter((entry) => seen.has(entry.id));
  const current: ProjectSection = SECTIONS.find((entry) => entry === section) ?? 'members';
  const own = settings[project];
  const nav = <NavGroup id="project" title={`${projectName(project)} settings`}>
    {SECTIONS.map((entry) => <NavItem key={entry} id={entry} label={SECTION_LABEL[entry]} icon={SECTION_ICON[entry]} active={entry === current} onClick={() => onSection(entry)} />)}
  </NavGroup>;
  if (!seen.has(project) || !own) return <FullPage back="Back to work" onBack={onBack} nav={null}><PageCanvas><p className="py-10 text-body text-muted-foreground">{viewer.first} isn’t a member of {projectName(project)}.</p></PageCanvas></FullPage>;
  return <FullPage back={`Back to ${projectName(project)}`} onBack={onBack} nav={nav}>
    <PageCanvas>
      <PageHeader kicker={`${projectName(project)} · Project settings`} title={SECTION_LABEL[current]} description="This project’s own settings. Team-wide settings are in Settings under Crumb & Co; personal ones under You."
        actions={<span className="flex items-center gap-2">
          <Select value={project} onValueChange={onProject}><SelectTrigger aria-label="Project" /><SelectContent>{projects.map((item, index) => <SelectItem key={item.id} value={item.id} index={index}>{item.name}</SelectItem>)}</SelectContent></Select>
          <Badge color="gray">{viewer.first} · {projectRoleOf(viewer.id, project)?.name} here</Badge>
        </span>} />
      <div className="flex flex-col gap-10 pb-10">
        {current === 'members' ? <MembersSection project={project} /> : null}
        {current === 'repositories' ? <RepositoriesSection project={project} settings={own} /> : null}
        {current === 'inference' ? <InferenceSection project={project} settings={own} /> : null}
        {current === 'plugins' ? <PluginsSection project={project} settings={own} /> : null}
        {current === 'secrets' ? <SecretsSection project={project} /> : null}
        {current === 'environment' ? <EnvironmentSection project={project} /> : null}
        {current === 'automations' ? <AutomationsSection project={project} /> : null}
        {current === 'scripts' ? <ProjectScriptsSection project={project} /> : null}
      </div>
    </PageCanvas>
  </FullPage>;
}

function InferenceSection({ project, settings }: { project: string; settings: ProjectSettings }) {
  const viewer = useViewer();
  const [to, setTo] = useState<string | null>(null);
  const edit = why(viewer.id, project, 'project.settings');
  const profile = PROFILES.find((entry) => entry.id === settings.profile);
  return <Section title="Inference" scope="Project" readOnly={edit} description="This project applies one of the team’s profiles. The profile decides models, services, which team providers pay, and which kinds of holders’ own providers may pay; edit those in Inference → Team.">
    <SettingRows label="Inference">
      <SettingRow media={glyph(CpuChip01)} title="Inference profile" description={profile ? profile.models.slice(0, 4).map((model) => `${model.role}: ${model.model}`).join(' · ') : ''}>
        <Select value={settings.profile} disabled={edit !== null} onValueChange={(value) => { if (value !== settings.profile) setTo(value); }}>
          <Tooltip content={edit ?? 'Inference profile'}><span><SelectTrigger aria-label="Inference profile" /></span></Tooltip>
          <SelectContent>{PROFILES.map((entry, index) => <SelectItem key={entry.id} value={entry.id} index={index}>{entry.name}</SelectItem>)}</SelectContent>
        </Select>
      </SettingRow>
      <SettingRow title="Holders’ own providers (from the profile)" description={profile?.personal.length ? `${profile.name} lets a holder’s own ${profile.personal.join(' or ')} pay for their turns here` : `${profile?.name} pays with team providers only`}
        extra={<span className="mt-1 flex flex-wrap gap-1.5">{PERSONAL_KINDS.map((kind) => <Pill key={kind} tone={profile?.personal.includes(kind) ? 'green' : 'gray'}>{kind}: {profile?.personal.includes(kind) ? 'yes' : 'no'}</Pill>)}</span>}>
        <Pill>Read only · set in the profile</Pill>
      </SettingRow>
      <SettingRow title="Team providers (from the profile)" description={profile?.teamProviders.map((id) => MODEL_CREDENTIALS.find((entry) => entry.id === id)?.label ?? id).join(', ')} />
    </SettingRows>
    {to ? <ProfileChangeDialog project={project} to={to} onClose={() => setTo(null)} /> : null}
  </Section>;
}

function PluginsSection({ project, settings }: { project: string; settings: ProjectSettings }) {
  const viewer = useViewer();
  const [toggling, setToggling] = useState<string | null>(null);
  const edit = why(viewer.id, project, 'project.settings');
  const team = PLUGINS.filter((plugin) => plugin.owner.scope === 'account');
  return <>
    <Section title="Team plugins" scope="Project" readOnly={edit} description={`Which of ${ACCOUNT_NAME}’s plugins work here. Setting them up is the team’s (Plugins → Team).`}>
      <SettingRows label="Team plugins">{team.map((plugin) => {
        const on = settings.teamPlugins.includes(plugin.id);
        return <SettingRow key={plugin.id} media={glyph(Link03)} title={<>{plugin.name}<Pill>{plugin.auth}</Pill>{plugin.status === 'off' ? <Pill>Off for the team</Pill> : null}</>} description={plugin.detail}>
          <Switch label={`${plugin.name} on in ${projectName(project)}`} checked={on} disabled={edit !== null || plugin.status === 'off'} onToggle={() => setToggling(plugin.id)} />
        </SettingRow>;
      })}</SettingRows>
    </Section>
    <ProjectMachineMcp project={project} />
    <Section title="Holders’ own plugins" scope="Project" readOnly={edit} description="Whether a holder’s own sign-ins (their Slack, Linear, Composio links, paired Chrome) join workspaces here while they hold the handle.">
      <SettingRows label="Holders’ own plugins">
        <SettingRow media={glyph(User01)} title="Holders’ own plugins allowed" description={settings.holdersPlugins ? 'On: each holder’s own plugins join while they hold the handle' : 'Off: only the team’s and the repository’s plugins work here'}>
          <Switch label="Holders’ own plugins allowed" checked={settings.holdersPlugins} disabled={edit !== null} onToggle={() => setToggling('holders')} />
        </SettingRow>
      </SettingRows>
    </Section>
    <Section title="Declared by the repository" scope="Project" description="Plugins the repository declares in .gitspace/bundle.json. They change with the code: edit the file, not this page.">
      <SettingRows label="Declared plugins">{settings.declared.map((entry) => <SettingRow key={entry.name} media={glyph(FileCode01)} title={<>{entry.name}<Pill>{entry.kind}</Pill></>} description={entry.detail}>
        <span className="font-mono text-caption text-muted-foreground">.gitspace/bundle.json</span>
      </SettingRow>)}</SettingRows>
    </Section>
    {toggling ? <PluginToggleDialog project={project} plugin={toggling} onClose={() => setToggling(null)} /> : null}
  </>;
}

function SecretsSection({ project }: { project: string }) {
  const viewer = useViewer();
  const [adding, setAdding] = useState(false);
  const [sheet, setSheet] = useState(false);
  const edit = why(viewer.id, project, 'secrets.edit');
  const view = why(viewer.id, project, 'secrets.view');
  return <>
    <Section title="Secrets" scope="Project" readOnly={edit} description={`${projectName(project)}’s own secrets, values, tokens and logins; they override the team’s of the same name. Engineers and Leads add and rotate them; each row’s rule (who may use it, only while holding, delivered only to approved scripts, in a cleared shell with a passkey, or by browser autofill on named sites) is the Leads’ to edit. Owners and Admins may forbid shell delivery on any of them, Lead or not.`}
      actions={view ? undefined : <><Button variant="secondary" size="compact" onClick={() => setSheet(true)}>Preview secure input’s Save to…</Button><Gate reason={edit} variant="secondary" leadingIcon={glyph(Plus)} onOpen={() => setAdding(true)}>Add</Gate></>}>
      {view ? <Note>{view}.</Note> : <SecretsList scope={project} reason={edit} />}
    </Section>
    {view ? null : <Section title="Asked of each holder" scope="Project" description={`Values ${projectName(project)} asks every holder for, each their own. The rule here bounds everyone’s; a holder may narrow it for their own value under You › My secrets.`}>
      <AskedValues project={project} />
    </Section>}
    {adding ? <AddSecretDialog project={project} onClose={() => setAdding(false)} /> : null}
    {sheet ? <SaveToSheet project={project} onClose={() => setSheet(false)} /> : null}
  </>;
}

/** Secure input, after the person typed a login into an agent's tab: where should GitSpace keep it? The team's or the
 * project's secrets (delivered only to approved scripts to start), or the person's own value the project asks for. */
function SaveToSheet({ project, onClose }: { project: string; onClose(): void }) {
  const viewer = useViewer();
  const { say } = useMock();
  const name = `STAGING_${viewer.first.toUpperCase()}`;
  const asked = (PERSONAL_VALUES[viewer.id] ?? []).find((value) => value.projectId === project && value.name === 'STAGING_LOGIN');
  const options = [
    { id: 'team', icon: Building07, title: `${ACCOUNT_NAME} · team secret ${name}`, detail: 'A team login: only approved scripts get it to start; edit its rule on Secrets.', disabled: whyAccount(viewer.id, 'account.credentials') },
    { id: 'project', icon: Lock01, title: `${projectName(project)} · project secret ${name}`, detail: `${projectName(project)}’s Leads and Engineers may use it, only while holding, only through approved scripts.`, disabled: why(viewer.id, project, 'secrets.edit') },
    { id: 'me', icon: User01, title: 'Only me · my STAGING_LOGIN', detail: `The value ${projectName(project)} asks each holder for, in You › My secrets; used only while you hold a workspace, for your turns.`, disabled: asked ? null : `${projectName(project)} doesn’t ask holders for STAGING_LOGIN` },
  ];
  const [choice, setChoice] = useState(options.find((option) => !option.disabled)?.id ?? 'me');
  const [done, setDone] = useState<'saved' | 'once' | null>(null);
  const picked = options.find((option) => option.id === choice);
  const finish = (how: 'saved' | 'once'): void => {
    if (how === 'saved') {
      recordAudit({ actor: viewer.id, kind: 'setting', project: choice === 'project' ? project : undefined, text: `Saved the staging.crumb.example login from secure input to ${picked?.title}` });
      if (choice === 'me') valueStates.set({ ...valueStates.get(), [`${viewer.id}:${project}:STAGING_LOGIN`]: { set: true, updated: 'Just now' } });
      else {
        const scope = choice === 'project' ? project : 'team';
        const entry: SecretEntry = { id: `secure-input-${choice}-${name}`, name, scope, kind: 'login', detail: 'staging.crumb.example login, from secure input', site: 'staging.crumb.example', username: viewer.first.toLowerCase(), sensitive: true, expires: null, updated: `just now by ${viewer.first}`, lastUsed: 'just now · slot-holds' };
        secrets.set([...secrets.get().filter((existing) => !(existing.scope === scope && existing.name === name)), entry]);
        secretRules.set({ ...secretRules.get(), [`${scope}:${name}`]: startingRule(entry) });
      }
    }
    say(how === 'saved' ? `Saved to ${picked?.title}` : 'Used once; not saved');
    setDone(how);
  };
  return <FlowDialog id="save-to" title="Save this login?" wide={false} done={done !== null} onClose={onClose}
    description={<>You signed in to <span className="font-mono">staging.crumb.example</span> through secure input in slot-holds’ tab. The agent saw dots, not the password.</>}
    footer={done ? <Button variant="primary" onClick={onClose}>Done</Button> : <><Button variant="secondary" onClick={() => finish('once')}>Use once</Button><Button variant="primary" onClick={() => finish('saved')}>Save</Button></>}>
    {done === 'saved' ? <FlowSuccess title={`Saved to ${picked?.title}`}>{choice === 'me' ? 'Your STAGING_LOGIN for this project: used only while you hold a workspace, for turns you start.' : 'Only approved scripts get it to start (a sign-in step, a smoke test). Its row on Secrets shows the rule; edit it there.'}</FlowSuccess>
      : done === 'once' ? <FlowSuccess title="Used once; not saved">The tab is signed in for this session only. Next time, secure input asks again.</FlowSuccess> : <>
        <InputGroup className="w-full"><InputField index={0} label="Username" value={viewer.first.toLowerCase()} onChange={() => undefined} /><InputField index={1} label="Password" type="password" value="hunter2hunter2" onChange={() => undefined} /></InputGroup>
        <ChoiceCards label="Save to" value={choice} onChange={setChoice} choices={options} />
        <Hint>Dimmed choices say why they’re off.</Hint>
      </>}
  </FlowDialog>;
}

function AutomationsSection({ project }: { project: string }) {
  const viewer = useViewer();
  const list = automations.use()[project] ?? [];
  const [creating, setCreating] = useState(false);
  const [toggling, setToggling] = useState<string | null>(null);
  const enable = why(viewer.id, project, 'automations.enable');
  return <Section title="Automations" scope="Project" readOnly={enable} description="Their definitions live here: scheduled and triggered runs. Agents and bots propose them; a person whose role allows it enables them. A failed run goes to Needs you for Owners, Admins, the project’s Leads and whoever enabled it; running ones show on the project card and overview."
    actions={<Gate reason={why(viewer.id, project, 'automations.propose')} variant="secondary" leadingIcon={glyph(Plus)} onOpen={() => setCreating(true)}>New automation</Gate>}>
    {list.length ? <SettingRows label="Automations">{list.map((entry) => <SettingRow key={entry.name} media={glyph(Zap)} title={<span data-automation={entry.name} className="inline-flex flex-wrap items-center gap-2">{entry.name}<Pill tone={entry.state === 'on' ? 'green' : entry.state === 'paused' ? 'gray' : 'amber'}>{entry.state === 'proposed' ? 'Proposed' : entry.state === 'on' ? 'On' : 'Paused'}</Pill></span>}
      description={`${entry.trigger} · ${entry.state === 'proposed' ? `Proposed by ${userOf(entry.by).name}` : `Enabled by ${userOf(entry.enabledBy ?? entry.by).name}`}`}>
      <Act reason={enable} variant="ghost" aria-label={`${entry.state === 'on' ? 'Pause' : 'Enable'} ${entry.name}`} onClick={() => setToggling(entry.name)}>{entry.state === 'on' ? 'Pause' : 'Enable'}</Act>
    </SettingRow>)}</SettingRows> : <Note>No automations.</Note>}
    {creating ? <NewAutomationWizard project={project} onClose={() => setCreating(false)} /> : null}
    {toggling ? <AutomationStateDialog project={project} name={toggling} onClose={() => setToggling(null)} /> : null}
  </Section>;
}
