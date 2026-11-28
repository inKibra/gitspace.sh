// Team settings pages with one scope each: the account's domains, which GitSpace source and release channel it runs,
// and the GitHub App installed for it. Owners and Admins edit; Members read. Each action opens its dialog or wizard
// from ../flows/team.tsx; the pages read the live state from ../flows/team-data.ts.
import { glyph } from '../../glyph.js';
import { Select, SelectContent, SelectItem, SelectTrigger, Switch } from '@gitspace/ui';
import { ClockRewind, GitBranch01, Globe04, Plus, Rocket01 } from '@untitledui/icons';
import { useState } from 'react';
import { TEAM, userOf } from '../data.js';
import {
  AddDomainFlow, ChangeReposDialog, ChannelDialog, CreateAppFlow, DomainDnsDialog, InstallAppFlow, RemoveCustomDomainDialog, ReturnToLatestDialog, RollbackFlow, UninstallAppDialog,
} from '../flows/team.js';
import { customDomains, githubApp, release, RELEASES, type CustomDomain } from '../flows/team-data.js';
import { useMock, useViewer } from '../viewer.js';
import { ACCOUNT_NAME, projectName, projectSettings, recordAudit } from './data.js';
import { Act, Note, Pill, Section, SettingRow, SettingRows } from './parts.js';
import { whyAccount } from './roles.js';

export function DomainsPage() {
  const viewer = useViewer();
  const domains = customDomains.use();
  const edit = whyAccount(viewer.id, 'account.team');
  const [adding, setAdding] = useState(false);
  const [checking, setChecking] = useState<CustomDomain | null>(null);
  const [removing, setRemoving] = useState<CustomDomain | null>(null);
  return <>
    <Section title="Account address" scope="Team" readOnly={edit} description={`Where ${ACCOUNT_NAME} signs in and where its workspaces’ previews are served.`}
      actions={<Act reason={edit} variant="secondary" leadingIcon={glyph(Plus)} onClick={() => setAdding(true)}>Add domain</Act>}>
      <SettingRows label="Account address">
        <SettingRow media={glyph(Globe04)} title={<span className="font-mono">{TEAM.host}</span>} description="GitSpace address · TLS managed by GitSpace"><Pill tone="green">Active</Pill></SettingRow>
        {domains.map((domain) => <SettingRow key={domain.name} media={glyph(Globe04)} title={<span data-custom-domain={domain.name} className="font-mono">{domain.name}</span>} description={domain.detail}>
          {domain.state === 'verified' ? <Pill tone="green">Verified</Pill> : <><Pill tone="amber">DNS pending</Pill><Act reason={edit} variant="ghost" onClick={() => setChecking(domain)}>DNS records</Act></>}
          <Act reason={edit} variant="ghost" aria-label={`Remove ${domain.name}`} onClick={() => setRemoving(domain)}>Remove</Act>
        </SettingRow>)}
      </SettingRows>
    </Section>
    <Note>The email domains invites may go to are under People &amp; roles → Invites.</Note>
    {adding ? <AddDomainFlow onClose={() => setAdding(false)} /> : null}
    {checking ? <DomainDnsDialog domain={checking} onClose={() => setChecking(null)} /> : null}
    {removing ? <RemoveCustomDomainDialog domain={removing} onClose={() => setRemoving(null)} /> : null}
  </>;
}

export function SourcePage() {
  const viewer = useViewer();
  const { say } = useMock();
  const edit = whyAccount(viewer.id, 'account.team');
  const current = release.use();
  const [switching, setSwitching] = useState<'stable' | 'beta' | null>(null);
  const [rolling, setRolling] = useState(false);
  const [returning, setReturning] = useState(false);
  const running = RELEASES.find((entry) => entry.version === current.running);
  return <>
    <Section title="Source and releases" scope="Team" readOnly={edit} description={`Which GitSpace ${ACCOUNT_NAME} runs and when it updates.`}>
      <SettingRows label="Source and releases">
        <SettingRow media={glyph(Rocket01)} title="Release channel" description="Stable gets a release a week after Beta; Beta the day it’s cut.">
          <Select value={current.channel} disabled={edit !== null} onValueChange={(value) => { if ((value === 'stable' || value === 'beta') && value !== current.channel) setSwitching(value); }}><SelectTrigger aria-label="Release channel" /><SelectContent><SelectItem value="stable" index={0}>Stable</SelectItem><SelectItem value="beta" index={1}>Beta</SelectItem></SelectContent></Select>
        </SettingRow>
        <SettingRow media={glyph(GitBranch01)} title="Running" description={<span className="font-mono">gitspace {current.running} · main@{running?.commit} · deployed {running?.deployed}</span>}>
          {current.rolledBack ? <><Pill tone="amber">Rolled back · updates paused</Pill><Act reason={edit} variant="primary" onClick={() => setReturning(true)}>Return to latest</Act></> : <Pill tone="green">Up to date</Pill>}
        </SettingRow>
        <SettingRow title="Update automatically" description={current.rolledBack ? 'Paused while rolled back.' : 'Sundays 02:00–04:00 Europe/London. Running turns finish first.'}>
          <Switch label="Update automatically" checked={current.auto} disabled={edit !== null || current.rolledBack} onToggle={() => {
            release.set({ ...current, auto: !current.auto });
            recordAudit({ actor: viewer.id, kind: 'setting', text: `Turned automatic GitSpace updates ${current.auto ? 'off' : 'on'}` });
            say(`Automatic updates ${current.auto ? 'off' : 'on'}`);
          }} />
        </SettingRow>
      </SettingRows>
    </Section>
    <Section title="Recent releases" scope="Team" readOnly={edit} description="Roll back if a release breaks something for the team; it pauses updates until you return to latest."
      actions={<Act reason={edit} variant="secondary" leadingIcon={glyph(ClockRewind)} onClick={() => setRolling(true)}>Roll back</Act>}>
      <SettingRows label="Recent releases">{RELEASES.map((entry) => <SettingRow key={entry.version} title={<span className="inline-flex items-center gap-2 font-mono">{entry.version}{entry.version === current.running ? <Pill tone="green">Running</Pill> : null}</span>}
        description={`${entry.deployed} · ${entry.notes}`} />)}</SettingRows>
    </Section>
    {switching ? <ChannelDialog to={switching} onClose={() => setSwitching(null)} /> : null}
    {rolling ? <RollbackFlow onClose={() => setRolling(false)} /> : null}
    {returning ? <ReturnToLatestDialog onClose={() => setReturning(false)} /> : null}
  </>;
}

export function GitHubAppPage() {
  const viewer = useViewer();
  const edit = whyAccount(viewer.id, 'account.team');
  const settings = projectSettings.use();
  const app = githubApp.use();
  const [creating, setCreating] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [changing, setChanging] = useState<string | null>(null);
  const [uninstalling, setUninstalling] = useState<string | null>(null);
  return <>
    {app ? <Section title={app.name} scope="Team" readOnly={edit} description="The account has one GitHub App, installed once per GitHub organization. Each installation covers the repositories listed."
      actions={<Act reason={edit} variant="secondary" leadingIcon={glyph(Plus)} onClick={() => setInstalling(true)}>Install on another organization</Act>}>
      {app.installations.length ? app.installations.map((installation) => <SettingRows key={installation.org} label={installation.org}>
        <SettingRow media={glyph(GitBranch01)} title={<span data-installation={installation.org} className="inline-flex items-center gap-2">{installation.org}<Pill tone="green">Installed</Pill><Pill>{installation.selection === 'all' ? 'All repositories' : `${installation.repositories.length} ${installation.repositories.length === 1 ? 'repository' : 'repositories'}`}</Pill></span>}
          description={`Installed ${installation.installed} by ${userOf(installation.by).name} · contents, pull requests, checks: read and write · issues: read`}>
          <Act reason={edit} variant="ghost" onClick={() => setChanging(installation.org)}>Change repositories</Act>
          <Act reason={edit} variant="ghost" onClick={() => setUninstalling(installation.org)}>Uninstall…</Act>
        </SettingRow>
        {installation.repositories.map((repository) => {
          const users = Object.entries(settings).filter(([, entry]) => entry.repositories.includes(repository)).map(([id]) => projectName(id));
          return <SettingRow key={repository} title={<span className="font-mono">{repository}</span>} description={users.length ? `Used by ${users.join(', ')}` : 'Not used by a project'} />;
        })}
      </SettingRows>) : <Note>Not installed on any organization yet: Install on another organization to choose the repositories it reaches.</Note>}
    </Section> : <Section title="GitHub App" scope="Team" readOnly={edit} description={`${ACCOUNT_NAME} has no GitHub App yet. Create one: GitSpace sends GitHub a manifest with the permissions it needs, you confirm on github.com, then install it on your organizations.`}
      actions={<Act reason={edit} variant="primary" leadingIcon={glyph(Plus)} onClick={() => setCreating(true)}>Create the GitHub App</Act>}>
      <Note>Until then, every origin uses the SSH key of the machine’s scope.</Note>
    </Section>}
    <Section title="Git access" scope="Team" description="How a workspace reaches each origin, on every machine.">
      <ol className="flex max-w-3xl list-decimal flex-col gap-1.5 pl-5 text-caption text-muted-foreground [text-wrap:pretty]">
        <li><strong className="text-foreground">An origin the GitHub App covers uses App tokens on every machine</strong>, team or personal: the project’s repository and any extra repositories it declares. Tokens are narrow and short-lived, and end when the person is removed or the App stops covering the repository.</li>
        <li><strong className="text-foreground">Anything the App doesn’t cover uses the machine’s own scope’s SSH key:</strong> the team SSH key on team machines (Machines → Team), the owner’s personal key on their own machines (Settings → Git identity).</li>
        <li><strong className="text-foreground">Personal keys never go on team machines.</strong></li>
        <li><strong className="text-foreground">The commit author is whoever started the turn</strong>, with their own name and email; GitSpace is the committer.</li>
      </ol>
      <SettingRows label="Repositories by project">{Object.entries(settings).map(([id, entry]) => <SettingRow key={id} title={projectName(id)}
        extra={<div className="mt-1 flex flex-col gap-0.5 text-caption">{entry.repositories.map((repository) => {
          const org = app?.installations.find((installation) => installation.repositories.includes(repository))?.org ?? null;
          return <span key={repository} className="flex flex-wrap items-center gap-2"><span className="font-mono text-foreground">{repository}</span><Pill tone={org ? 'green' : 'amber'}>{org ? `GitHub App (${org})` : 'SSH key of the machine’s scope'}</Pill></span>;
        })}</div>} />)}</SettingRows>
    </Section>
    {creating ? <CreateAppFlow onClose={() => setCreating(false)} onInstall={() => { setCreating(false); setInstalling(true); }} /> : null}
    {installing ? <InstallAppFlow onClose={() => setInstalling(false)} /> : null}
    {changing ? <ChangeReposDialog org={changing} onClose={() => setChanging(null)} /> : null}
    {uninstalling ? <UninstallAppDialog org={uninstalling} onClose={() => setUninstalling(null)} /> : null}
  </>;
}
