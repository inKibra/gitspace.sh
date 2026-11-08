import type { GitHubInstallationView, GitHubProjectAccess, GitHubProjectBridge } from '@gitspace/protocol/github';
import { Badge, Button, useShape } from '@gitspace/ui';
import { Check, Clock, Copy01, LinkExternal01, Lock01, Monitor01 } from '@untitledui/icons';
import { useState, type ReactElement, type ReactNode } from 'react';
import { z } from 'zod';
import { glyph } from './glyph.js';
import { formatRelativeTime } from './relative-time.js';
import { rpcErrorMessage } from './rpc-error-message.js';

/** A project's repository access while its agent cannot read it. */
export type BlockedProjectAccess = Exclude<GitHubProjectAccess, { state: 'ready' }>;

const INSTALL_INTENT_KEY = 'gitspace.github.install';
/** An install started longer ago than this is not the one GitHub just returned from. */
const INSTALL_INTENT_MS = 60 * 60_000;
const InstallIntentSchema = z.object({ projectId: z.string().min(1).nullable(), at: z.number() });

/** Remembers, in this browser, what an install about to open on GitHub is for: GitHub drops GitSpace's state when it
 * routes the install through its own pages, and Settings then records the request from this. */
export function rememberGitHubInstall(projectId: string | null): void {
  try { window.localStorage.setItem(INSTALL_INTENT_KEY, JSON.stringify({ projectId, at: Date.now() })); }
  catch { /* Storage unavailable: the request is recorded as of unknown organization. */ }
}

/** What the last install this browser started was for, read once; null when none started within the hour. */
export function takeGitHubInstall(): { projectId: string | null } | null {
  try {
    const stored = window.localStorage.getItem(INSTALL_INTENT_KEY);
    window.localStorage.removeItem(INSTALL_INTENT_KEY);
    const intent = InstallIntentSchema.safeParse(JSON.parse(stored ?? 'null'));
    return intent.success && Date.now() - intent.data.at < INSTALL_INTENT_MS ? { projectId: intent.data.projectId } : null;
  } catch { return null; }
}

/** Where an organization's owners answer install requests and see what each installation may read. */
export function githubInstallationsUrl(organization: string): string {
  return `https://github.com/organizations/${encodeURIComponent(organization)}/settings/installations`;
}

/** Where an installation's repositories are chosen: its account's owners change them there. */
export function githubInstallationUrl(installation: Pick<GitHubInstallationView, 'id' | 'account'>): string {
  return installation.account.kind === 'organization'
    ? `${githubInstallationsUrl(installation.account.login)}/${installation.id}`
    : `https://github.com/settings/installations/${installation.id}`;
}

/** What an organization owner does on GitHub to approve a request, written to be forwarded as is. `organization` is null
 * when GitSpace does not know which organization the request was for. */
export function ownerStepsText(appName: string, organization: string | null, repository: string | null): string {
  const allow = repository ? `Allow ${repository.slice(repository.indexOf('/') + 1)} (or all repositories)` : 'Choose the repositories GitSpace should read';
  return [
    `To install ${appName} on ${organization ?? 'your organization'}:`,
    `1. Open ${organization ? githubInstallationsUrl(organization) : 'https://github.com/organizations/<organization>/settings/installations'}`,
    `2. Under "Pending GitHub Apps installation requests", find ${appName} and choose Review.`,
    `3. ${allow}, then Install.`,
  ].join('\n');
}

export function OwnerSteps({ appName, organization, repository }: { appName: string; organization: string | null; repository: string | null }): ReactElement {
  const shape = useShape();
  return <div className={`flex flex-col gap-2 bg-surface-2 p-3 ${shape.container}`}>
    <span className="text-caption font-medium text-foreground">{organization ? `For an owner of ${organization}` : 'For an owner of the organization'}</span>
    <ol className="flex list-decimal flex-col gap-1 pl-5 text-caption text-muted-foreground">
      <li>Open <span className="font-mono text-foreground [overflow-wrap:anywhere]">{organization ? githubInstallationsUrl(organization).replace('https://', '') : 'github.com/organizations/<organization>/settings/installations'}</span></li>
      <li>Under <span className="text-foreground">Pending GitHub Apps installation requests</span>, find <span className="text-foreground">{appName}</span> and choose <span className="text-foreground">Review</span>.</li>
      <li>{repository ? <>Allow <span className="text-foreground">{repository.slice(repository.indexOf('/') + 1)}</span> (or all repositories)</> : 'Choose the repositories GitSpace should read'}, then <span className="text-foreground">Install</span>.</li>
    </ol>
    <span className="text-caption text-muted-foreground">GitHub also emails the owners about the request.{organization ? null : " Not sure which organization you picked? GitHub lists your requests on the App's install page."}</span>
  </div>;
}

export function CopyStepsButton({ text, label = 'Copy steps for the owner', variant = 'primary' }: { text: string; label?: string; variant?: 'primary' | 'secondary' }): ReactElement {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setCopied(true); setFailed(false); }
    catch { setFailed(true); }
  };
  return <Button variant={variant} size="compact" type="button" leadingIcon={glyph(copied ? Check : Copy01)} onClick={() => void copy()}>{failed ? 'Copy failed: select the steps above' : copied ? 'Copied' : label}</Button>;
}

/** One step of getting access: done, current, or still to come. */
function Step({ state, title, detail }: { state: 'done' | 'current' | 'next'; title: ReactNode; detail?: ReactNode }): ReactElement {
  const shape = useShape();
  return <li className="flex gap-3">
    <span className={`mt-0.5 inline-flex size-5 shrink-0 items-center justify-center ${shape.bg} ${state === 'done' ? 'bg-foreground text-background' : state === 'current' ? 'bg-active text-foreground ring-1 ring-inset ring-border' : 'text-muted-foreground ring-1 ring-inset ring-border'}`}>
      {state === 'done' ? <Check width={12} height={12} strokeWidth={1.5} /> : state === 'current' ? <Clock width={12} height={12} strokeWidth={1.5} /> : null}
    </span>
    <span className="flex min-w-0 flex-col gap-0.5">
      <span className={`text-body ${state === 'next' ? 'text-muted-foreground' : 'text-foreground'}`}>{title}</span>
      {detail ? <span className="text-caption text-muted-foreground">{detail}</span> : null}
    </span>
  </li>;
}

/** "Oct 31, 3:22 AM": when something happened on GitHub, in the reader's time zone. */
export function githubTime(iso: string): string {
  return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** Opens the App's install page `onInstall` resolves to, holding the failure to show when it cannot. */
function useInstall(onInstall: () => Promise<string>): { installing: boolean; error: string | null; install(): Promise<void> } {
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const install = async () => {
    setInstalling(true);
    setError(null);
    try { window.location.assign(await onInstall()); }
    catch (cause) { setError(rpcErrorMessage(cause, 'Install GitHub App')); setInstalling(false); }
  };
  return { installing, error, install };
}

/** The other way in: a machine of the person's that can read the repository bridges a project whose cloud copy exists. */
function MachineWayIn({ repository, onAttachMachine }: { repository: string; onAttachMachine(): void }): ReactElement {
  const shape = useShape();
  return <div className={`flex flex-col gap-2 bg-surface-2 p-3 ${shape.container}`}>
    <span className="text-caption font-medium text-foreground">Or attach a machine that can read it</span>
    <span className="text-caption text-muted-foreground">When this project already has its cloud copy, attach one of your machines that can read <span className="font-mono text-foreground">{repository}</span> (your account SSH key on GitHub) to it, and GitSpace syncs with GitHub through that machine, using your own access. A new project's first copy still needs the App, which also adds pull requests, checks, automations and syncing without a machine.</span>
    <div className="flex flex-wrap gap-2"><Button variant="secondary" size="compact" type="button" leadingIcon={glyph(Monitor01)} onClick={onAttachMachine}>Attach a machine</Button></div>
  </div>;
}

/**
 * The project page's card while its agent cannot read its repository and no machine bridges it: it offers both ways in,
 * installing the account's App or attaching a machine that can read the repository, and tracks an App install.
 * `onInstall` resolves to the App's install page with the repository's owner chosen; `onAttachMachine` opens the
 * project's Environment.
 */
export function RepositoryAccessCard({ access, onInstall, onOpenSettings, onAttachMachine }: { access: BlockedProjectAccess; onInstall(): Promise<string>; onOpenSettings(): void; onAttachMachine(): void }): ReactElement {
  const shape = useShape();
  const { installing, error, install } = useInstall(onInstall);
  const { repository, organization, appName } = access;
  const name = repository.slice(repository.indexOf('/') + 1);
  const badge = access.state === 'needs-app' ? <Badge variant="dot" size="compact" color="gray">Not connected</Badge>
    : access.state === 'requested' ? <Badge variant="dot" size="compact" color="amber">Waiting on {organization}</Badge>
      : <Badge variant="dot" size="compact" color="amber">Repository not allowed</Badge>;
  return <section aria-label="Repository access" className={`flex w-full max-w-[560px] flex-col gap-4 border border-border bg-card p-5 ${shape.container}`}>
    <div className="flex items-start justify-between gap-3">
      <span className="flex items-center gap-2 text-caption text-muted-foreground"><Lock01 width={14} height={14} strokeWidth={1.5} /><span className="font-mono">{repository}</span> · private</span>
      {badge}
    </div>
    {access.state === 'needs-app' && access.appName === null ? <>
      <div className="flex flex-col gap-1.5">
        <h2 className="text-subtitle font-semibold text-foreground">Create your GitHub App first, or attach a machine</h2>
        <p className="text-body text-muted-foreground">This repository is private, and this account has no GitHub App yet. Create it in Settings → GitHub, then install it on {organization} from here, or attach one of your machines that can read the repository.</p>
      </div>
      <div className="flex flex-wrap gap-2"><Button variant="primary" size="compact" type="button" onClick={onOpenSettings}>Open Settings → GitHub</Button></div>
    </> : access.state === 'needs-app' ? <>
      <div className="flex flex-col gap-1.5">
        <h2 className="text-subtitle font-semibold text-foreground">Install your GitHub App on {organization}, or attach a machine</h2>
        <p className="text-body text-muted-foreground">This repository is private, and your GitHub App, <span className="text-foreground">{appName}</span>, isn't installed on {organization}. This project's agent and workspaces start once GitSpace can read it, through the App or through one of your machines.</p>
      </div>
      <p className="text-caption text-muted-foreground">If you're not an owner of {organization}, GitHub sends your install to its owners as a request, and this page tracks it.</p>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" size="compact" type="button" loading={installing} trailingIcon={glyph(LinkExternal01)} onClick={() => void install()}>Install on {organization}</Button>
      </div>
    </> : access.state === 'requested' ? <>
      <div className="flex flex-col gap-1.5">
        <h2 className="text-subtitle font-semibold text-foreground">Waiting for an owner of {organization} to approve</h2>
        <p className="text-body text-muted-foreground">You asked to install <span className="text-foreground">{access.appName}</span> on {organization}. Only an organization owner can approve it. GitSpace keeps the install and imports <span className="font-mono text-foreground">{name}</span> as soon as they do.</p>
      </div>
      <ol className="flex flex-col gap-3">
        <Step state="done" title="Requested by you" detail={`${githubTime(access.request.firstRequestedAt)}${access.request.times > 1 ? ` · asked ${access.request.times} times, last ${githubTime(access.request.lastRequestedAt)}` : ''}`} />
        <Step state="current" title={`An owner of ${organization} approves it on GitHub`} detail={`Pending · requested ${formatRelativeTime(new Date(access.request.firstRequestedAt))}`} />
        <Step state="next" title={`GitSpace imports ${name}`} detail="Starts on its own when GitHub reports the install." />
      </ol>
      <OwnerSteps appName={access.appName} organization={organization} repository={repository} />
      <div className="flex flex-wrap items-center gap-2">
        <CopyStepsButton text={ownerStepsText(access.appName, organization, repository)} />
        <Button variant="secondary" size="compact" type="button" trailingIcon={glyph(LinkExternal01)} onClick={() => window.open(githubInstallationsUrl(organization), '_blank', 'noopener,noreferrer')}>I'm an owner: open on GitHub</Button>
      </div>
    </> : <>
      <div className="flex flex-col gap-1.5">
        <h2 className="text-subtitle font-semibold text-foreground">Allow {name} in the App on {organization}</h2>
        <p className="text-body text-muted-foreground"><span className="text-foreground">{access.appName}</span> is installed on {organization}, but only for selected repositories, and <span className="font-mono text-foreground">{name}</span> isn't one of them. An owner adds it in the App's repository access.</p>
      </div>
      <ol className="flex flex-col gap-3">
        <Step state="done" title={`Installed on ${organization}`} detail={access.installation.repositories.length ? `Selected repositories: ${access.installation.repositories.map((full) => full.slice(full.indexOf('/') + 1)).join(', ')}` : 'No repositories selected'} />
        <Step state="current" title={`${name} added to the App's repositories`} detail={`GitHub → ${organization} settings → GitHub Apps → ${access.appName} → Configure → Repository access`} />
        <Step state="next" title={`GitSpace imports ${name}`} />
      </ol>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" size="compact" type="button" trailingIcon={glyph(LinkExternal01)} onClick={() => window.open(githubInstallationUrl(access.installation), '_blank', 'noopener,noreferrer')}>Add {name} on GitHub</Button>
        <CopyStepsButton variant="secondary" label="Copy steps for an owner" text={[`To let ${access.appName} read ${repository}:`, `1. Open ${githubInstallationUrl(access.installation)}`, `2. Under Repository access, add ${name} (or choose All repositories), then Save.`].join('\n')} />
      </div>
    </>}
    <MachineWayIn repository={repository} onAttachMachine={onAttachMachine} />
    {error ? <p role="alert" className="text-caption text-destructive">{error}</p> : null}
  </section>;
}

/**
 * The project page's strip while a machine bridges its private repository to GitHub in place of the App: which machine
 * syncs (or that sync is paused while it is offline), and what the App would add, with the next step towards it.
 */
export function RepositoryBridgeBanner({ access, bridge, onInstall, onOpenSettings }: { access: BlockedProjectAccess; bridge: GitHubProjectBridge; onInstall(): Promise<string>; onOpenSettings(): void }): ReactElement {
  const shape = useShape();
  const { installing, error, install } = useInstall(onInstall);
  const { repository, organization } = access;
  const name = repository.slice(repository.indexOf('/') + 1);
  const adds = 'for pull requests, checks, automations and syncing without a machine.';
  const lead = bridge.online ? `Syncs with GitHub through ${bridge.label}, using your own access.` : `GitHub sync paused: ${bridge.label} is offline.`;
  const hint = access.state === 'needs-app' && access.appName === null ? `Create your GitHub App in Settings → GitHub, then install it on ${organization} ${adds}`
    : access.state === 'needs-app' ? `Install ${access.appName} on ${organization} ${adds}`
      : access.state === 'requested' ? `Waiting for an owner of ${organization} to approve ${access.appName}: only an organization owner can approve it.`
        : `${access.appName} is installed on ${organization}, but ${name} isn't one of its selected repositories. An owner adds it in the App's repository access.`;
  return <section aria-label="GitHub sync" className={`flex w-full max-w-3xl flex-wrap items-center gap-3 bg-surface-2 px-3 py-2 ${shape.container}`}>
    <p className="min-w-0 flex-1 text-caption text-muted-foreground">{lead} {hint}</p>
    {access.state === 'needs-app' && access.appName === null ? <Button variant="secondary" size="compact" type="button" onClick={onOpenSettings}>Open Settings → GitHub</Button>
      : access.state === 'needs-app' ? <Button variant="secondary" size="compact" type="button" loading={installing} trailingIcon={glyph(LinkExternal01)} onClick={() => void install()}>Install on {organization}</Button>
        : access.state === 'requested' ? <CopyStepsButton variant="secondary" text={ownerStepsText(access.appName, organization, repository)} />
          : <Button variant="secondary" size="compact" type="button" trailingIcon={glyph(LinkExternal01)} onClick={() => window.open(githubInstallationUrl(access.installation), '_blank', 'noopener,noreferrer')}>Add {name} on GitHub</Button>}
    {error ? <p role="alert" className="basis-full text-caption text-destructive">{error}</p> : null}
  </section>;
}
