// A project's setup, in its settings. Repositories: the project's repository and the extra ones it declares, each with
// how it's reached (the GitHub App, through the team's machines with the team SSH key, or not reachable, with the
// fix) and where workspaces clone it; "Add repository" runs the "Connect repositories" wizard (source, repositories,
// where in the workspace, review) that New project runs too. Environment: the Instructions ("How to work on this
// project", with proposals above them), the machine profiles the project's work needs, the secrets it uses with each
// one's rule, browser origins and network, and the revision history (Instructions and profile list together), each
// revision with its diff and Roll back. The flows are in flows/env-page.tsx.
import { glyph } from '../glyph.js';
import { Button, InputCopy, InputField, InputGroup, Select, SelectContent, SelectItem, SelectTrigger } from '@gitspace/ui';
import { AlertCircle, CheckCircle, Download01, Edit01, GitBranch01, Globe01, Lock01, Plus, Server01, Stars01, XCircle } from '@untitledui/icons';
import { useState } from 'react';
import { actorLabel, PROJECTS, userOf } from './data.js';
import { machineProfiles, projectProfiles } from './flows/env-model.js';
import { EditInstructionsDialog, EditProfilesDialog, envAccess, envRevisions, ImportInstructionsDialog, Markdown, ProfileSummary, ProposalDialog, proposalsOf, refusalOf, revisionDiff, RevisionDiffDialog, RollBackDialog, savedOf, SetUpWithAgentWizard, setupRuns, useSecretUses } from './flows/env-page.js';
import { RuleSummary } from './flows/secret-rules.js';
import { DiffBlock, Gate, leadsOf, reachOf, RefusedDialog, whoCan } from './flows/project.js';
import { ChoiceCards, FlowDialog, FlowError, FlowSuccess, Hint, StepButtons, Summary } from './flows/kit.js';
import { appCovers, ENVIRONMENT, GITHUB_APP, OTHER_REPOSITORIES, PROJECT_REACH, projectName, projectSettings, recordAudit, TEAM_SSH_KEY, type ProjectSettings } from './settings/data.js';
import { Act, Note, Pill, Section, SettingRow, SettingRows } from './settings/parts.js';
import { projectRoleOf, why } from './settings/roles.js';
import { createStore } from './store.js';
import { useMock, useViewer } from './viewer.js';

export interface Placement { path: string; branch: string }
/** Where workspaces clone each connected repository, per project; a repository without an entry uses
 * `defaultPlacement`. */
const repoPlacements = createStore<Readonly<Record<string, Readonly<Record<string, Placement>>>>>({});
function defaultPlacement(repository: string): Placement { return { path: `repos/${repository.split('/').pop() ?? repository}`, branch: 'main' }; }

function ReachLine({ repository }: { repository: string }) {
  const reach = reachOf(repository);
  const Icon = reach.state === 'app' ? CheckCircle : reach.state === 'machine' ? Server01 : XCircle;
  return <span className={`inline-flex flex-wrap items-center gap-1.5 text-caption ${reach.state === 'none' ? 'text-destructive' : 'text-muted-foreground'}`}><Icon width={13} height={13} />{reach.label}{reach.fix ? <span className="text-foreground">· Fix: {reach.fix}</span> : null}</span>;
}

/** The repositories to pick from: each says how it's reached; one that isn't can't be picked, says what would fix it
 * and, on another Git host, can be checked again. */
export function ConnectRepositories({ candidates, picked, onPicked, retried, onCheckAgain }: { candidates: readonly string[]; picked: readonly string[]; onPicked(next: readonly string[]): void; retried: Readonly<Record<string, string>>; onCheckAgain?(repository: string): void }) {
  if (!candidates.length) return <Note>No repositories match.</Note>;
  return <ul data-connect-repositories="" className="flex max-h-80 flex-col gap-1.5 overflow-y-auto">{candidates.map((repository) => {
    const reach = reachOf(repository);
    const on = picked.includes(repository);
    return <li key={repository} className="flex flex-col gap-1.5">
      <button type="button" role="checkbox" aria-checked={on} data-repository-choice={repository} disabled={reach.state === 'none'} onClick={() => onPicked(on ? picked.filter((entry) => entry !== repository) : [...picked, repository])}
        className={`flex w-full min-w-0 items-start gap-2.5 rounded-xl p-2.5 text-left disabled:cursor-not-allowed ${on ? 'bg-[color-mix(in_oklab,#6B97FF_10%,transparent)] shadow-[inset_0_0_0_1.5px_#6B97FF]' : 'shadow-[inset_0_0_0_1px_var(--border)] hover:bg-hover'}`}>
        <span aria-hidden className={`mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-[5px] text-[10px] ${on ? 'bg-[#6B97FF] text-white' : reach.state === 'none' ? 'bg-muted' : 'shadow-[inset_0_0_0_1.5px_var(--border)]'}`}>{on ? '✓' : ''}</span>
        <span className="flex min-w-0 flex-col gap-0.5"><span className={`truncate font-mono text-[12.5px] ${reach.state === 'none' ? 'text-muted-foreground' : 'text-foreground'}`} title={repository}>{repository}</span><ReachLine repository={repository} /></span>
      </button>
      {reach.state === 'none' && onCheckAgain && !repository.startsWith('github.com/') ? <div className="ml-7 flex flex-col gap-1.5">
        {retried[repository] ? <><FlowError>{retried[repository]}</FlowError><InputCopy label="Team SSH key (public)" value={TEAM_PUBLIC_KEY} /></> : null}
        <div><Button variant="secondary" size="compact" onClick={() => onCheckAgain(repository)}>I’ve registered it: check again</Button></div>
      </div> : null}
    </li>;
  })}</ul>;
}

const TEAM_PUBLIC_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIK3q7Vx7mN0b2Lr8KpTz4WcHf1sYeA6uJ9dGiO5nXc0Lk crumbco-team';
const HOSTS = ['gitlab.crumbco.example', 'bitbucket.org', 'git.sr.ht'] as const;
/** Repositories on other Git hosts the team's workspaces have cloned before, offered by host. */
const HOST_KNOWN = ['gitlab.crumbco.example/ops/terraform', 'gitlab.crumbco.example/ops/menu-printer-config', 'bitbucket.org/openbank/sandbox-fixtures', 'git.sr.ht/~crumb/menu-fonts'];
/** Repositories that answer anonymously over HTTPS. */
const PUBLIC = ['github.com/stripe-samples/apple-pay-js', 'github.com/mapbox/mapbox-gl-js', 'gitlab.com/fdroid/fdroidclient'];

export type RepoSource = 'app' | 'host' | 'public';
/** The Connect repositories wizard's answers so far. */
export interface Connect {
  source: RepoSource; org: string; host: string; query: string; address: string; addressError: string | null;
  picked: readonly string[]; checked: readonly string[]; retried: Readonly<Record<string, string>>;
  url: string; publicRepo: string | null; urlError: string | null;
  placements: Readonly<Record<string, Placement>>;
}
export const NEW_CONNECT: Connect = { source: 'app', org: GITHUB_APP.installations[0]?.org ?? '', host: HOSTS[0], query: '', address: '', addressError: null, picked: [], checked: [], retried: {}, url: '', publicRepo: null, urlError: null, placements: {} };
export const CONNECT_STEPS = ['Source', 'Repositories', 'In workspaces', 'Review'] as const;

/** The repositories the wizard will connect: the picked ones, or the checked public one. */
export function connectedOf(value: Connect): readonly string[] { return value.source === 'public' ? value.publicRepo ? [value.publicRepo] : [] : value.picked; }
function placementOf(value: Connect, repository: string): Placement { return value.placements[repository] ?? defaultPlacement(repository); }
function placementErrors(value: Connect, repository: string): { path: string | null; branch: string | null } {
  const { path, branch } = placementOf(value, repository);
  const paths = connectedOf(value).map((entry) => placementOf(value, entry).path);
  return {
    path: !path.trim() ? 'Enter where it goes, like repos/terraform.' : path.startsWith('/') || path.split('/').includes('..') ? 'Use a path inside the workspace: no leading / and no ..' : !/^[A-Za-z0-9._/-]+$/.test(path) ? 'Letters, digits, . _ - and / only.' : paths.filter((entry) => entry === path).length > 1 ? 'Two repositories can’t share a path.' : null,
    branch: !/^[A-Za-z0-9._/-]+$/.test(branch) || branch.startsWith('-') ? 'Enter a branch name, like main.' : null,
  };
}
/** What stops the wizard leaving `step` (0 source … 2 in workspaces), or null. */
export function connectError(step: number, value: Connect, required: boolean): string | null {
  if (step === 1) {
    if (value.source === 'public' && !value.publicRepo) return value.url.trim() ? 'Check the URL first.' : required ? 'Enter a public repository’s URL and check it.' : null;
    if (required && !connectedOf(value).length) return 'Pick at least one repository.';
  }
  if (step === 2 && connectedOf(value).some((repository) => { const errors = placementErrors(value, repository); return errors.path || errors.branch; })) return 'Fix the paths and branches above.';
  return null;
}
function viaOf(value: Connect, repository: string): string {
  return value.source === 'public' ? 'Public HTTPS, read only' : reachOf(repository).state === 'app' ? `GitHub App (${appCovers(repository)})` : 'Team machines · team SSH key';
}

/** One step of the Connect repositories wizard (0 source, 1 repositories, 2 in workspaces, 3 review). */
export function ConnectStep({ step, value, onChange, exclude, tried }: { step: number; value: Connect; onChange(next: Connect): void; exclude: readonly string[]; tried: boolean }) {
  const [busy, setBusy] = useState(false);
  const set = (next: Partial<Connect>): void => onChange({ ...value, ...next });
  if (step === 0) return <>
    <ChoiceCards label="Source" value={value.source} onChange={(source) => set({ source: source === 'host' ? 'host' : source === 'public' ? 'public' : 'app', picked: [], query: '' })} choices={[
      { id: 'app', title: 'GitHub App installation', icon: GitBranch01, detail: `${GITHUB_APP.name} is installed on ${GITHUB_APP.installations.map((installation) => `${installation.org} (${installation.repositories.length})`).join(' and ')}. App tokens on every machine; access ends when someone leaves.` },
      { id: 'host', title: 'Another Git host, through team machines', icon: Server01, detail: 'GitLab, Bitbucket, any SSH host: cloned with the team SSH key on team machines. Personal machines use their owner’s key.' },
      { id: 'public', title: 'Public URL', icon: Globe01, detail: 'Read only over HTTPS on every machine. Workspaces can’t push to it.' },
    ]} />
    {value.source === 'app' ? <div className="flex flex-col gap-1.5"><span className="text-caption font-medium text-foreground">Installation</span><Select value={value.org} onValueChange={(org) => set({ org, picked: [] })}><SelectTrigger aria-label="Installation" /><SelectContent>{GITHUB_APP.installations.map((installation, index) => <SelectItem key={installation.org} value={installation.org} index={index}>{installation.org} · installed {installation.installed} by {actorLabel(installation.by)}</SelectItem>)}</SelectContent></Select>
      <Hint>Another GitHub organization? An Owner or Admin installs the App there from Crumb & Co › GitHub.</Hint></div> : null}
    {value.source === 'host' ? <div className="flex flex-col gap-1.5"><span className="text-caption font-medium text-foreground">Host</span><Select value={value.host} onValueChange={(host) => set({ host, picked: [] })}><SelectTrigger aria-label="Host" /><SelectContent>{HOSTS.map((host, index) => <SelectItem key={host} value={host} index={index}>{host}{TEAM_SSH_KEY.registered.some((place) => place.includes(host)) ? ' · team key registered' : ' · team key not registered'}</SelectItem>)}</SelectContent></Select>
      <Hint>Team SSH key {TEAM_SSH_KEY.fingerprint.slice(0, 19)}… · created {TEAM_SSH_KEY.created}.</Hint></div> : null}
  </>;
  if (step === 1) {
    if (value.source === 'public') {
      const check = (): void => {
        const match = /^https:\/\/([a-z0-9.-]+\.[a-z]+)\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(value.url.trim());
        if (!match) { set({ urlError: 'Enter an https:// URL like https://github.com/owner/name.', publicRepo: null }); return; }
        const repository = `${match[1]}/${match[2]}/${match[3]}`;
        setBusy(true);
        window.setTimeout(() => {
          setBusy(false);
          if (exclude.includes(repository)) onChange({ ...value, urlError: `${repository} is already connected.`, publicRepo: null });
          else if (PUBLIC.includes(repository)) onChange({ ...value, urlError: null, publicRepo: repository });
          else if (appCovers(repository)) onChange({ ...value, urlError: `${repository} is private, and the GitHub App covers it: go back and pick GitHub App installation so workspaces can push too.`, publicRepo: null });
          else onChange({ ...value, urlError: `${repository} isn’t public: ${match[1]} answered 404 without signing in. If it’s private, connect it through the GitHub App or another Git host; otherwise check the address.`, publicRepo: null });
        }, 800);
      };
      return <>
        <InputGroup className="w-full"><InputField index={0} label="Repository URL" placeholder="https://github.com/stripe-samples/apple-pay-js" value={value.url} onChange={(url) => set({ url, urlError: null, publicRepo: null })} /></InputGroup>
        <div><Button variant="secondary" loading={busy} disabled={busy || !value.url.trim()} onClick={check}>Check URL</Button></div>
        {value.urlError ? <FlowError>{value.urlError}</FlowError> : null}
        {value.publicRepo ? <FlowSuccess title={value.publicRepo}>Public · default branch main · read only over HTTPS on every machine.</FlowSuccess> : null}
      </>;
    }
    const pool = value.source === 'app'
      ? [...(GITHUB_APP.installations.find((installation) => installation.org === value.org)?.repositories ?? []), ...OTHER_REPOSITORIES.filter((repository) => repository.startsWith('github.com/'))]
      : [...HOST_KNOWN, ...value.checked].filter((repository) => repository.startsWith(`${value.host}/`));
    const candidates = pool.filter((repository, index) => pool.indexOf(repository) === index && !exclude.includes(repository) && repository.toLowerCase().includes(value.query.trim().toLowerCase()));
    const add = (): void => {
      const match = /^(?:ssh:\/\/)?(?:[\w.-]+@)?([a-z0-9.-]+\.[a-z]+)[:/]([~\w./-]+?)(?:\.git)?$/.exec(value.address.trim());
      if (!match) { set({ addressError: `Enter an SSH address like git@${value.host}:team/name.git.` }); return; }
      if (match[1] !== value.host) { set({ addressError: `That’s on ${match[1]}; pick ${match[1]} as the host in Source, or change the address.` }); return; }
      const repository = `${match[1]}/${match[2]}`;
      setBusy(true);
      window.setTimeout(() => { setBusy(false); onChange({ ...value, address: '', addressError: null, checked: value.checked.includes(repository) ? value.checked : [...value.checked, repository] }); }, 800);
    };
    return <>
      <InputGroup className="w-full"><InputField index={0} label="Search" placeholder="Filter by name" value={value.query} onChange={(query) => set({ query })} /></InputGroup>
      <ConnectRepositories candidates={candidates} picked={value.picked} onPicked={(picked) => set({ picked })} retried={value.retried}
        onCheckAgain={(repository) => set({ retried: { ...value.retried, [repository]: `Checked again from crumb-cell-1 just now: ${repository.split('/')[0]} still answers “Permission denied (publickey)”. Add this key to the repository (as a deploy key) or to a machine user, then check again.` } })} />
      {value.source === 'host' ? <div className="flex flex-col gap-1.5">
        <InputGroup className="w-full"><InputField index={1} label="Another repository on this host" placeholder={`git@${value.host}:team/name.git`} value={value.address} error={value.addressError ?? undefined} onChange={(address) => set({ address, addressError: null })} /></InputGroup>
        <div><Button variant="secondary" size="compact" loading={busy} disabled={busy || !value.address.trim()} onClick={add}>Check from a team machine</Button></div>
      </div> : <Hint>Listed: what the {value.org} installation covers, and GitHub repositories the team has used that it doesn’t.</Hint>}
      {tried && connectError(1, value, true) ? <FlowError>{connectError(1, value, true)}</FlowError> : null}
    </>;
  }
  const repositories = connectedOf(value);
  if (step === 2) return repositories.length ? <>
    {repositories.map((repository, index) => {
      const placement = placementOf(value, repository);
      const errors = placementErrors(value, repository);
      return <div key={repository} data-placement={repository} className="flex flex-col gap-1.5">
        <span className="truncate font-mono text-caption text-foreground" title={repository}>{repository}</span>
        <InputGroup className="w-full">
          <InputField index={index * 2} label="Path in the workspace" value={placement.path} error={errors.path ?? undefined} onChange={(path) => set({ placements: { ...value.placements, [repository]: { ...placement, path } } })} />
          <InputField index={index * 2 + 1} label="Branch" value={placement.branch} error={errors.branch ?? undefined} onChange={(branch) => set({ placements: { ...value.placements, [repository]: { ...placement, branch } } })} />
        </InputGroup>
      </div>;
    })}
    <Hint>Every workspace clones it at this path, next to the project repository, on this branch. Change it later from the repository’s row.</Hint>
  </> : <Note>No extra repositories: workspaces get only the project repository.</Note>;
  return repositories.length ? <Summary rows={repositories.map((repository): readonly [string, string] => [repository.split('/').slice(1).join('/'), `${placementOf(value, repository).path} · ${placementOf(value, repository).branch} · ${viaOf(value, repository)}`])} /> : <Note>No extra repositories.</Note>;
}

function AddRepositoryWizard({ project, onClose }: { project: string; onClose(): void }) {
  const viewer = useViewer();
  const { say } = useMock();
  const settings = projectSettings.use()[project];
  const [step, setStep] = useState(0);
  const [value, setValue] = useState<Connect>(NEW_CONNECT);
  const [tried, setTried] = useState(false);
  const [done, setDone] = useState<readonly string[] | null>(null);
  const name = projectName(project);
  const refused = why(viewer.id, project, 'project.settings');
  if (refused) return <RefusedDialog id="add-repository" title="Connect repositories" reason={refused} who={whoCan(project, 'project.settings')} onClose={onClose} />;
  if (!settings) return null;
  const next = (): void => {
    setTried(true);
    if (connectError(step, value, true)) return;
    setTried(false);
    if (step < 3) { setStep(step + 1); return; }
    const repositories = connectedOf(value);
    projectSettings.set({ ...projectSettings.get(), [project]: { ...settings, repositories: [...settings.repositories, ...repositories] } });
    repoPlacements.set({ ...repoPlacements.get(), [project]: { ...repoPlacements.get()[project], ...Object.fromEntries(repositories.map((repository) => [repository, placementOf(value, repository)])) } });
    recordAudit({ actor: viewer.id, kind: 'setting', project, text: `Connected ${repositories.join(', ')} to ${name}` });
    say(`Connected ${repositories.length} ${repositories.length === 1 ? 'repository' : 'repositories'} to ${name}`);
    setDone(repositories);
  };
  const count = connectedOf(value).length;
  return <FlowDialog id="add-repository" title="Connect repositories" description={`Extra repositories ${name}’s workspaces need. Each says how it’s reached; one that can’t be reached says what would fix it.`}
    steps={CONNECT_STEPS} step={step} done={done !== null} onClose={onClose}
    footer={done ? <Button variant="primary" onClick={onClose}>Done</Button> : <StepButtons step={step} onBack={() => { setTried(false); setStep(step - 1); }} onCancel={onClose} next={next} nextLabel={step === 3 ? `Connect ${count}` : 'Next'} />}>
    {done ? <FlowSuccess title={`Connected ${done.length} ${done.length === 1 ? 'repository' : 'repositories'} to ${name}`}>{done.map((repository) => `${repository} at ${placementOf(value, repository).path}`).join(' · ')}. Workspaces clone {done.length === 1 ? 'it' : 'them'} when they start; if agents need to know how to use {done.length === 1 ? 'it' : 'them'}, edit the Instructions in Environment.</FlowSuccess>
      : <ConnectStep step={step} value={value} onChange={setValue} exclude={settings.repositories} tried={tried} />}
    {tried && step !== 1 && connectError(step, value, true) ? <FlowError>{connectError(step, value, true)}</FlowError> : null}
  </FlowDialog>;
}

function RemoveRepositoryDialog({ project, repository, onClose }: { project: string; repository: string; onClose(): void }) {
  const viewer = useViewer();
  const { say } = useMock();
  const settings = projectSettings.use()[project];
  const [done, setDone] = useState(false);
  const name = projectName(project);
  const tail = repository.split('/').slice(1).join('/');
  const mentioned = (savedOf(envRevisions.get()[project] ?? [])[0]?.instructions ?? '').includes(tail);
  const confirm = (): void => {
    if (settings) projectSettings.set({ ...projectSettings.get(), [project]: { ...settings, repositories: settings.repositories.filter((entry) => entry !== repository) } });
    recordAudit({ actor: viewer.id, kind: 'setting', project, text: `Removed ${repository} from ${name}` });
    say(`Removed ${repository}`);
    setDone(true);
  };
  return <FlowDialog id="remove-repository" title={`Remove ${tail} from ${name}?`} wide={false} done={done} onClose={onClose}
    footer={done ? <Button variant="primary" onClick={onClose}>Done</Button> : <><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={confirm}>Remove</Button></>}>
    {done ? <FlowSuccess title={`${repository} is no longer connected to ${name}`}>Connect it again any time from Add repository. Recorded in the audit log.</FlowSuccess> : <>
      <Summary rows={[['Repository', repository], ['New workspaces', 'Don’t clone it'], ['Open workspaces', 'Keep their copy until they’re set up again']]} />
      {mentioned ? <FlowError>{name}’s Instructions tell agents to use it: edit them in Environment so agents stop looking for it.</FlowError> : <Hint>{name}’s Instructions don’t mention it.</Hint>}
    </>}
  </FlowDialog>;
}

/** New project: its name, repository and base branch, then the Connect repositories steps for extra ones (optional). */
export function NewProjectWizard({ onClose }: { onClose(): void }) {
  const viewer = useViewer();
  const { say } = useMock();
  const taken = Object.values(projectSettings.use()).flatMap((entry) => entry.repositories);
  const repositories = GITHUB_APP.installations.flatMap((installation) => installation.repositories).filter((repository) => !taken.includes(repository));
  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [repository, setRepository] = useState(repositories[0] ?? '');
  const [branch, setBranch] = useState('main');
  const [value, setValue] = useState<Connect>(NEW_CONNECT);
  const [tried, setTried] = useState(false);
  const [done, setDone] = useState(false);
  const nameError = !name.trim() ? 'Name the project.' : PROJECTS.some((project) => project.name.toLowerCase() === name.trim().toLowerCase()) ? `Crumb & Co already has a project named ${name.trim()}.` : null;
  const branchError = !/^[A-Za-z0-9._/-]+$/.test(branch.trim()) ? 'Enter the base branch, like main.' : null;
  const extra = connectedOf(value);
  const next = (): void => {
    setTried(true);
    if (step === 0 ? nameError || branchError || !repository : connectError(step - 1, value, false)) return;
    setTried(false);
    if (step < 4) { setStep(step + 1); return; }
    recordAudit({ actor: viewer.id, kind: 'setting', text: `Created the project ${name.trim()} from ${repository}${extra.length ? ` with ${extra.join(', ')}` : ''}` });
    say(`Created ${name.trim()} · you’re its Lead`);
    setDone(true);
  };
  return <FlowDialog id="new-project" title="New project" description="The project’s repository and base branch, then any extra repositories its workspaces need. You’re its Lead; members, profile and environment are in its settings afterwards."
    steps={['Project', ...CONNECT_STEPS]} step={step} done={done} onClose={onClose}
    footer={done ? <Button variant="primary" onClick={onClose}>Done</Button> : <StepButtons step={step} onBack={() => { setTried(false); setStep(step - 1); }} onCancel={onClose} next={next}
      nextLabel={step === 4 ? 'Create project' : step === 2 && !extra.length ? 'Skip: no extra repositories' : 'Next'} />}>
    {done ? <FlowSuccess title={`${name.trim()} is created · you’re its Lead`}>{repository} on {branch.trim()}{extra.length ? `, with ${extra.join(', ')}` : ''}. Next: its settings › Environment, to have an agent write its instructions or import its AGENTS.md; then add members.</FlowSuccess>
      : step === 0 ? <>
        <InputGroup className="w-full">
          <InputField index={0} label="Name" placeholder="Catering" value={name} error={tried ? nameError ?? undefined : undefined} onChange={setName} />
          <InputField index={1} label="Base branch" value={branch} error={tried ? branchError ?? undefined : undefined} onChange={setBranch} />
        </InputGroup>
        <div className="flex flex-col gap-1.5"><span className="text-caption font-medium text-foreground">Repository</span>
          <Select value={repository} onValueChange={setRepository}><SelectTrigger aria-label="Repository" /><SelectContent>{repositories.map((entry, index) => <SelectItem key={entry} value={entry} index={index}>{entry} · GitHub App ({appCovers(entry)})</SelectItem>)}</SelectContent></Select>
          <Hint>Repositories the GitHub App covers that no project uses yet. Another organization needs the App installed there first.</Hint></div>
      </> : <>{step === 4 ? <Summary rows={[['Project', name.trim()], ['Repository', `${repository} · ${branch.trim()}`], ['Lead', `${viewer.first} (you)`]]} /> : null}
        <ConnectStep step={step - 1} value={value} onChange={setValue} exclude={[repository]} tried={tried} /></>}
    {tried && step > 0 && step !== 2 && connectError(step - 1, value, false) ? <FlowError>{connectError(step - 1, value, false)}</FlowError> : null}
  </FlowDialog>;
}

export function RepositoriesSection({ project, settings }: { project: string; settings: ProjectSettings }) {
  const viewer = useViewer();
  const placements = repoPlacements.use()[project] ?? {};
  const edit = why(viewer.id, project, 'project.settings');
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const base = PROJECTS.find((entry) => entry.id === project)?.branch ?? 'main';
  return <Section title="Repositories" scope="Project" readOnly={edit} description="The project’s repository first, then the extra ones it declares. Each says how workspaces reach it on every machine, and where they clone it."
    actions={<Gate reason={edit} variant="secondary" leadingIcon={glyph(Plus)} onOpen={() => setAdding(true)}>Add repository</Gate>}>
    <SettingRows label="Repositories">{settings.repositories.map((repository, index) => {
      const placement = placements[repository] ?? defaultPlacement(repository);
      return <SettingRow key={repository} media={glyph(GitBranch01)}
        title={<span data-repository={repository} className="inline-flex min-w-0 flex-wrap items-center gap-2"><span className="truncate font-mono" title={repository}>{repository}</span>{index === 0 ? <Pill tone="blue">Project repository</Pill> : <Pill>Extra</Pill>}</span>}
        description={<span className="flex flex-col gap-0.5"><ReachLine repository={repository} /><span className="font-mono text-caption text-muted-foreground">{index === 0 ? `workspace root · ${base}` : `${placement.path} · ${placement.branch}`}</span></span>}>
        {index === 0 ? null : <Act reason={edit} variant="ghost" aria-label={`Remove ${repository}`} onClick={() => setRemoving(repository)}>Remove</Act>}
      </SettingRow>;
    })}</SettingRows>
    {adding ? <AddRepositoryWizard project={project} onClose={() => setAdding(false)} /> : null}
    {removing ? <RemoveRepositoryDialog project={project} repository={removing} onClose={() => setRemoving(null)} /> : null}
  </Section>;
}

const FROM_LABEL = { project: 'Project secret', team: 'Team secret', personal: 'Each holder’s own · You › Secrets' } as const;
type EnvDialog = { kind: 'agent' | 'import' | 'instructions' | 'profiles' } | { kind: 'diff' | 'roll-back' | 'approve' | 'decline'; n: number };

export function EnvironmentSection({ project }: { project: string }) {
  const viewer = useViewer();
  const { navigate } = useMock();
  const revisions = envRevisions.use()[project] ?? [];
  const runs = setupRuns.use()[project] ?? [];
  const profiles = machineProfiles.use();
  const needed = projectProfiles.use()[project] ?? [];
  const uses = useSecretUses(project);
  const [dialog, setDialog] = useState<EnvDialog | null>(null);
  const edit = why(viewer.id, project, 'project.settings');
  const access = envAccess(viewer.id, project);
  const change = refusalOf(access);
  const saved = savedOf(revisions);
  const current = saved[0];
  const proposals = proposalsOf(revisions);
  const reach = PROJECT_REACH[project];
  const name = projectName(project);
  const leads = leadsOf(project).map((id) => actorLabel(id)).join(', ');
  const close = (): void => setDialog(null);
  if (!current) return <Note>No environment yet.</Note>;
  return <>
    <Section title="Instructions" scope="Project" readOnly={change}
      description={`How to work on ${name}: agents read this before every turn. Revision ${current.n} is current (${current.when} by ${actorLabel(current.by)}). ${name}’s Leads (${leads}) edit it; any other member of ${name}, and agents, propose, and a Lead approves here or in Needs you.`}
      actions={<>
        <Gate reason={change} variant="secondary" leadingIcon={glyph(Download01)} onOpen={() => setDialog({ kind: 'import' })}>Import from repository</Gate>
        <Gate reason={change} variant="secondary" leadingIcon={glyph(Stars01)} onOpen={() => setDialog({ kind: 'agent' })}>Set up with an agent</Gate>
        <Gate reason={change} variant="primary" leadingIcon={glyph(Edit01)} onOpen={() => setDialog({ kind: 'instructions' })}>{access.mode === 'propose' ? 'Propose an edit' : 'Edit'}</Gate>
      </>}>
      {access.mode === 'propose' ? <Note>You’re {projectRoleOf(viewer.id, project)?.name} in {name}: your edits are proposals one of its Leads approves.</Note> : null}
      {proposals.map((revision) => <div key={revision.n} data-env-proposal={revision.n} className="flex flex-wrap items-start gap-3 rounded-xl bg-[color-mix(in_oklab,#6B97FF_8%,transparent)] px-3 py-2.5 shadow-[inset_0_0_0_1px_color-mix(in_oklab,#6B97FF_35%,transparent)]">
        <span className="flex min-w-0 flex-1 basis-64 flex-col gap-1"><span className="text-body font-medium text-foreground">Proposed revision {revision.n}: {revision.summary}</span>
          <span className="text-caption text-muted-foreground">{revision.when} · from {revision.proposal?.from} · made against revision {revision.proposal?.base} · also in the Leads’ Needs you</span>
          {revision.proposal && revision.proposal.base !== current.n ? <span data-env-proposal-stale="" className="text-caption text-[#b54708]">Revision {current.n} was saved since: approving re-applies its change to revision {current.n}, after you confirm the re-diff.</span> : null}
          <DiffBlock lines={revisionDiff(savedOf(revisions).find((entry) => entry.n === revision.proposal?.base) ?? current, revision)} label={`Proposed revision ${revision.n} diff`} /></span>
        <span className="flex gap-1.5"><Act reason={edit} variant="ghost" onClick={() => setDialog({ kind: 'decline', n: revision.n })}>Decline</Act><Act reason={edit} variant="primary" onClick={() => setDialog({ kind: 'approve', n: revision.n })}>Approve</Act></span>
      </div>)}
      {runs.length ? <SettingRows label="Setup workspaces">{runs.map((run) => <SettingRow key={run.workspace} media={glyph(Stars01)} title={<span className="inline-flex flex-wrap items-center gap-2 font-mono">{run.workspace}<Pill tone="blue">Agent writing instructions</Pill></span>}
        description={`${run.branch} · on ${run.machine} · started by ${actorLabel(run.by)} · proposed revision ${run.proposed}`} />)}</SettingRows> : null}
      <div data-instructions="" className="flex flex-col gap-2 rounded-xl px-4 py-3 shadow-[inset_0_0_0_1px_var(--border)]">
        <Markdown text={current.instructions} />
        <span className="text-caption text-muted-foreground">Revision {current.n} · {current.summary} · {current.when} by {actorLabel(current.by)}</span>
      </div>
    </Section>
    <Section title="Machine profiles this project needs" scope="Project" readOnly={change}
      description={`What a machine must have for ${name}’s work. Placement prefers a machine ready for all of them; a workspace or a task can add one for itself. Changing the list makes a revision (or a proposal), like the Instructions.`}
      actions={<>
        <Button variant="ghost" onClick={() => navigate('settings', { page: 'machine-profiles' })}>Team library</Button>
        <Gate reason={change} variant="secondary" leadingIcon={glyph(Server01)} onOpen={() => setDialog({ kind: 'profiles' })}>{access.mode === 'propose' ? 'Propose a change' : 'Change profiles'}</Gate>
      </>}>
      <SettingRows label="Machine profiles">{needed.map((id) => {
        const profile = profiles.find((entry) => entry.id === id);
        if (!profile) return null;
        return <SettingRow key={id} media={glyph(Server01)} title={<span data-project-profile={id} className="inline-flex flex-wrap items-center gap-2">{profile.name}<Pill>v{profile.versions[0]?.n}</Pill>{profile.image ? <Pill tone="teal">Cloud image</Pill> : null}</span>} description={<ProfileSummary profile={profile} />} />;
      })}</SettingRows>
    </Section>
    <Section title="Secrets this project uses" scope="Project"
      description={`Each with its rule: who may use it, whether only while holding the workspace, and how it’s delivered. Rules are edited on ${name}’s Secrets page (team secrets’ in Crumb & Co › Secrets).`}
      actions={<Button variant="secondary" leadingIcon={glyph(Lock01)} onClick={() => navigate('project-settings', { project, page: 'secrets' })}>Edit rules in Secrets</Button>}>
      <SettingRows label="Secrets this project uses">{uses.map((use) => <SettingRow key={`${use.from}:${use.name}`} media={glyph(Lock01)}
        title={<span data-secret-use={use.name} className="inline-flex flex-wrap items-center gap-2"><span className="font-mono">{use.name}</span><Pill tone={use.from === 'personal' ? 'violet' : use.from === 'team' ? 'gray' : 'teal'}>{FROM_LABEL[use.from]}</Pill></span>}
        description={<span className="flex flex-col gap-0.5"><span>{use.detail}</span><RuleSummary target={use.target} value={use.value} />
          {use.holders.length ? <span>Set by {use.holders.filter((holder) => holder.set).map((holder) => userOf(holder.userId).first).join(', ') || 'nobody yet'}{use.holders.some((holder) => !holder.set) ? <span className="text-[#B54708]"> · not set yet: {use.holders.filter((holder) => !holder.set).map((holder) => userOf(holder.userId).first).join(', ')}</span> : null}</span> : null}</span>} />)}</SettingRows>
    </Section>
    <Section title="Browser origins and network" scope="Project" description="Sites its browsers may open and hosts its workspaces may reach. Requests outside these wait for approval by content hash.">
      <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 16rem), 1fr))' }}>
        <SettingRows label="Browser origins">{(reach?.origins ?? []).map((origin) => <SettingRow key={origin} title={<span className="font-mono">{origin}</span>} description="Browser origin" />)}</SettingRows>
        <SettingRows label="Network">{(reach?.network ?? []).map((host) => <SettingRow key={host} title={<span className="font-mono">{host}</span>} description="Network" />)}</SettingRows>
      </div>
      <SettingRows label="Approvals">{(ENVIRONMENT[project] ?? []).map((entry) => <SettingRow key={entry.name} media={glyph(entry.state.startsWith('Waiting') ? AlertCircle : CheckCircle)} title={<span className="font-mono">{entry.name}</span>} description={entry.kind}>
        <Pill tone={entry.state.startsWith('Waiting') ? 'amber' : 'green'}>{entry.state}</Pill>
      </SettingRow>)}</SettingRows>
    </Section>
    <Section title="Revision history" scope="Project" description="Every save of the Instructions or the profile list is a revision. Roll back makes a new revision with the old contents.">
      <SettingRows label="Revision history">{saved.map((revision, index) => <SettingRow key={revision.n}
        title={<span data-revision={revision.n} className="inline-flex flex-wrap items-center gap-2">Revision {revision.n}{index === 0 ? <Pill tone="green">Current</Pill> : null}</span>}
        description={`${revision.summary} · ${revision.when} by ${actorLabel(revision.by)} · profiles ${revision.profiles.map((id) => profiles.find((profile) => profile.id === id)?.name ?? id).join(', ')}`}>
        <Button variant="ghost" size="compact" aria-label={`Diff of revision ${revision.n}`} onClick={() => setDialog({ kind: 'diff', n: revision.n })}>Diff</Button>
        {index === 0 ? null : <Act reason={edit} variant="ghost" size="compact" aria-label={`Roll back to revision ${revision.n}`} onClick={() => setDialog({ kind: 'roll-back', n: revision.n })}>Roll back</Act>}
      </SettingRow>)}</SettingRows>
    </Section>
    {dialog?.kind === 'agent' ? <SetUpWithAgentWizard project={project} onClose={close} /> : null}
    {dialog?.kind === 'import' ? <ImportInstructionsDialog project={project} onClose={close} /> : null}
    {dialog?.kind === 'instructions' ? <EditInstructionsDialog project={project} onClose={close} /> : null}
    {dialog?.kind === 'profiles' ? <EditProfilesDialog project={project} onClose={close} /> : null}
    {dialog?.kind === 'diff' ? <RevisionDiffDialog project={project} n={dialog.n} onClose={close} onRollBack={edit ? undefined : () => setDialog({ kind: 'roll-back', n: dialog.n })} /> : null}
    {dialog?.kind === 'roll-back' ? <RollBackDialog project={project} n={dialog.n} onClose={close} /> : null}
    {dialog?.kind === 'approve' || dialog?.kind === 'decline' ? <ProposalDialog project={project} n={dialog.n} decision={dialog.kind} onClose={close} /> : null}
  </>;
}
