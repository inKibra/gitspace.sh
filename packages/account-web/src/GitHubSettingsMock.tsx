// Throwaway design mock: Settings → GitHub, organized by organization. Each organization is one row: installed (with
// its repositories and projects), waiting on an owner (who asked, for what, since when, how the owner approves, cancel),
// or installed by someone GitSpace cannot vouch for (keep or remove). "Today" renders the real GitHubSettings with the
// same account's data. Static data only.
import type { GitHubState } from '@gitspace/protocol/github';
import {
  Accordion, AccordionContent, AccordionItem, AccordionTrigger, Badge, Button, Card, CardDescription, CardFooter, CardGroup, CardHeader, CardMedia,
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
  DropdownContent, DropdownMenu, DropdownTrigger, IconProvider, MenuItem, ShapeProvider, Sidebar, SidebarContent, SidebarFooter, SidebarGroup,
  SidebarGroupLabel, SidebarHeader, SidebarInset, SidebarInsetTopbar, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarProvider,
  SidebarUserFooter, SidebarWorkspaceHeader, SizeProvider, TooltipProvider, untitledIcons, useShape, WorkspaceTile, type IconComponent, type IconComponentProps,
} from '@gitspace/ui';
import { Activity, Check, Clock, Columns03, Copy01, FolderClosed, Key01, LinkExternal01, PuzzlePiece01, Stars01, Zap } from '@untitledui/icons';
import { StrictMode, useState, type ReactElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import '@gitspace/ui/fluid-theme.css';
import './styles.css';
import { glyph } from './glyph.js';
import { PageCanvas, PageHeader } from './GitSpaceShell.js';
import { GitHubSettings } from './SettingsPage.js';
import { restoreAppearance } from './appearance.js';

type Scenario = 'waiting' | 'approved' | 'unclaimed' | 'stranger' | 'uninstall' | 'removed' | 'today';
const SCENARIOS: readonly { id: Scenario; label: string }[] = [
  { id: 'waiting', label: 'BrandByX request waiting on an owner' },
  { id: 'approved', label: 'BrandByX approved: org known, kept automatically' },
  { id: 'unclaimed', label: 'Install while an unknown-org request is pending' },
  { id: 'stranger', label: 'Install with no request pending: removed' },
  { id: 'uninstall', label: 'Uninstalling inKibra from GitSpace' },
  { id: 'removed', label: 'An owner uninstalled it on GitHub' },
  { id: 'today', label: 'Built: the real page with this data' },
];
const APP = 'GitSpace bradleat';
const at = (hoursAgo: number): string => new Date(Date.now() - hoursAgo * 3_600_000).toISOString();
const time = (iso: string): string => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
/** Installs GitSpace uninstalled because nothing explained them, newest first. */
const REMOVED: readonly { org: string; by: string; at: string }[] = [
  { org: 'acme-labs', by: 'octocat', at: at(0.3) }, { org: 'spam-org-41', by: 'spam-bot', at: at(2) }, { org: 'spam-org-40', by: 'spam-bot', at: at(2.1) },
  { org: 'spam-org-39', by: 'spam-bot', at: at(2.2) }, { org: 'old-side-project', by: 'bradleat-alt', at: at(50) },
];

function monogram(letter: string): IconComponent {
  return function Monogram({ className }: IconComponentProps) { return <span aria-hidden className={`text-[12px] font-semibold leading-none ${className ?? ''}`}>{letter}</span>; };
}
const TILES: Readonly<Record<string, IconComponent>> = { inKibra: monogram('I'), BrandByX: monogram('B'), 'acme-labs': monogram('A'), unknown: monogram('?') };

/** This account's data as the built page reads it: one installation, and the two Settings requests migrated into one
 * whose organization is unknown. */
const TODAY: GitHubState = {
  app: { id: 1, slug: 'gitspace-bradleat', name: APP, htmlUrl: 'https://github.com/apps/gitspace-bradleat', owner: { login: 'bradleat', kind: 'user' }, createdAt: '2026-10-17T08:25:25.000Z', keyUpdatedAt: '2026-10-17T08:25:25.000Z' },
  installations: [{ id: 11, account: { login: 'inKibra', kind: 'organization' }, repositorySelection: 'selected', repositories: ['inKibra/core', 'inKibra/gitspace.sh'], permissions: { checks: 'write', contents: 'write', issues: 'write', metadata: 'read', pull_requests: 'write', statuses: 'write', workflows: 'write' }, installedAt: '2026-10-17T08:30:00.000Z', projects: [{ id: 'gitspace', name: 'GitSpace', repository: 'inKibra/gitspace.sh' }, { id: 'core', name: 'inkibra core', repository: 'inKibra/core' }] }],
  requests: [{ id: 'migrated', organization: null, project: null, repository: null, firstRequestedAt: '2026-10-31T01:16:03.000Z', lastRequestedAt: '2026-10-31T10:22:46.000Z', times: 2 }],
  unconfirmed: [],
  removed: [],
  uninstalled: [],
  deliveries: [
    { id: 'd3', event: 'installation', action: 'deleted', installationId: 99, repository: null, receivedAt: '2026-10-31T14:18:19.000Z', outcome: 'dropped: unknown installation' },
    { id: 'd2', event: 'installation', action: 'created', installationId: 99, repository: null, receivedAt: '2026-10-31T14:08:15.000Z', outcome: 'not started from GitSpace: removed unless claimed within 10 minutes' },
    { id: 'd1', event: 'check_suite', action: 'completed', installationId: 11, repository: 'inKibra/core', receivedAt: '2026-10-31T17:17:25.000Z', outcome: 'automations: 1 run in 1 project' },
  ],
};

/** A labelled fact under an organization: what it covers, who asked, since when. */
function Fact({ label, children }: { label: string; children: ReactNode }): ReactElement {
  return <div className="flex gap-3 text-caption"><span className="w-28 shrink-0 text-muted-foreground">{label}</span><span className="min-w-0 text-foreground [overflow-wrap:anywhere]">{children}</span></div>;
}

/** One organization: its tile, name, state, and below it what GitSpace knows and the actions that fit. */
function OrganizationRow({ login, index, state, summary, children, actions }: { login: string; index: number; state: ReactNode; summary: string; children: ReactNode; actions?: ReactNode }): ReactElement {
  return <Card size="compact" index={index} className="flex-wrap">
    <CardMedia icon={TILES[login] ?? TILES.unknown} />
    <CardHeader><span className="text-body font-medium text-foreground">{login === 'unknown' ? 'Unknown organization' : login}</span><CardDescription>{summary}</CardDescription></CardHeader>
    <CardFooter>{state}</CardFooter>
    <div className="flex basis-full flex-col gap-3 pb-3 pl-[42px] pr-3">
      <div className="flex flex-col gap-1.5">{children}</div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </div>
  </Card>;
}

/** How an owner approves a request; `org` is null when GitSpace does not know which organization it was for. */
function OwnerSteps({ org }: { org: string | null }): ReactElement {
  const shape = useShape();
  return <div className={`flex flex-col gap-1 bg-surface-2 p-3 text-caption text-muted-foreground ${shape.container}`}>
    <span className="font-medium text-foreground">How {org ? `an owner of ${org}` : 'the organization’s owner'} approves it</span>
    <span>github.com/organizations/{org ?? '<organization>'}/settings/installations → Pending GitHub Apps installation requests → {APP} → Review → choose the repositories → Install. GitHub also emails the owners.</span>
    {org ? null : <span>Not sure which organization you picked? It's listed on github.com/settings/installations under your requests.</span>}
  </div>;
}

/** Uninstalling from GitSpace: removes the App from the organization on GitHub, after saying what stops working. */
function UninstallDialog({ org, projects, open, onOpenChange }: { org: string; projects: string; open: boolean; onOpenChange(open: boolean): void }): ReactElement {
  return <Dialog open={open} onOpenChange={onOpenChange}>
    {open ? <DialogContent>
      <DialogHeader>
        <DialogTitle>Uninstall {APP} from {org}?</DialogTitle>
        <DialogDescription>This removes the App from {org} on GitHub, for the whole organization. An owner can install it again later.</DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-2 text-caption text-muted-foreground">
        <span className="font-medium text-foreground">What stops for {projects}</span>
        <span>· Cloud imports and syncing of these private repositories</span>
        <span>· Pushes, pull requests and checks GitSpace makes as the App</span>
        <span>· GitHub events for their automations</span>
        <span>Workspaces keep their cloud copies and branches; nothing is deleted.</span>
      </div>
      <DialogFooter>
        <Button variant="secondary" type="button" onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button variant="primary" type="button" onClick={() => onOpenChange(false)}>Uninstall from {org}</Button>
      </DialogFooter>
    </DialogContent> : null}
  </Dialog>;
}

function Organizations({ scenario }: { scenario: Exclude<Scenario, 'today'> }): ReactElement {
  const [copied, setCopied] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const [uninstalling, setUninstalling] = useState<string | null>(scenario === 'uninstall' ? 'inKibra' : null);
  const [reviewingRemoved, setReviewingRemoved] = useState(false);
  return <>
    <CardGroup orientation="inline" border="outlined" separated proximityHover={false}>
      <OrganizationRow login="inKibra" index={0} summary="Organization · 2 selected repositories" state={<Badge variant="dot" size="compact" color="green">Installed</Badge>}
        actions={<>
          <Button variant="secondary" size="compact" type="button" trailingIcon={glyph(LinkExternal01)}>Choose repositories on GitHub</Button>
          <Button variant="ghost" size="compact" type="button" onClick={() => setUninstalling('inKibra')}>Uninstall…</Button>
        </>}>
        <Fact label="Repositories"><span className="font-mono">inKibra/core, inKibra/gitspace.sh</span></Fact>
        <Fact label="Projects">GitSpace, inkibra core</Fact>
        <Fact label="Installed">Oct 17 · by you</Fact>
      </OrganizationRow>
      {scenario === 'approved'
        ? <OrganizationRow login="BrandByX" index={1} summary="Organization · 1 selected repository" state={<Badge variant="dot" size="compact" color="green">Installed</Badge>}
            actions={<>
              <Button variant="secondary" size="compact" type="button" trailingIcon={glyph(LinkExternal01)}>Choose repositories on GitHub</Button>
              <Button variant="ghost" size="compact" type="button" onClick={() => setUninstalling('BrandByX')}>Uninstall…</Button>
            </>}>
            <Fact label="Repositories"><span className="font-mono">BrandByX/payne-portals</span></Fact>
            <Fact label="Projects">Landscaping Portal · importing</Fact>
            <Fact label="Installed">{time(at(3))} by <span className="font-mono">leather-s</span>, an owner of BrandByX · it answered your request from {time(at(17))}, so GitSpace kept it.</Fact>
          </OrganizationRow>
        : scenario === 'unclaimed'
          ? <OrganizationRow login="BrandByX" index={1} summary="Organization · 1 selected repository" state={<Badge variant="dot" size="compact" color="amber">Is this yours?</Badge>}
              actions={<>
                <Button variant="primary" size="compact" type="button">Yes, it's mine</Button>
                <Button variant="ghost" size="compact" type="button">Not mine: uninstall</Button>
              </>}>
              <Fact label="Installed">{time(at(0.1))} by <span className="font-mono">leather-s</span>, an owner of BrandByX</Fact>
              <Fact label="Why we ask">You have a request from {time(at(30))} whose organization GitSpace doesn't know. If this is the answer to it, confirm and the request is resolved.</Fact>
              <Fact label="Repositories"><span className="font-mono">BrandByX/payne-portals</span> · would link Landscaping Portal</Fact>
              <Fact label="Until you confirm">GitSpace doesn't use it: no access to its repositories, none of its events. Uninstalled in 7 days if not confirmed.</Fact>
            </OrganizationRow>
          : scenario === 'removed'
            ? <OrganizationRow login="BrandByX" index={1} summary="Organization · not installed" state={<Badge variant="dot" size="compact" color="red">Uninstalled on GitHub</Badge>}
                actions={<>
                  <Button variant="primary" size="compact" type="button" trailingIcon={glyph(LinkExternal01)}>Install again on BrandByX</Button>
                  <Button variant="ghost" size="compact" type="button">Dismiss</Button>
                </>}>
                <Fact label="Uninstalled">{time(at(1))} by <span className="font-mono">leather-s</span> on GitHub</Fact>
                <Fact label="Affected">Landscaping Portal can no longer sync <span className="font-mono">BrandByX/payne-portals</span>; its workspaces keep their cloud copies.</Fact>
              </OrganizationRow>
            : cancelled
              ? null
              : <OrganizationRow login="BrandByX" index={1} summary="Organization · not installed" state={<Badge variant="dot" size="compact" color="amber">Waiting on an owner</Badge>}
                  actions={<>
                    <Button variant="primary" size="compact" type="button" leadingIcon={glyph(copied ? Check : Copy01)} onClick={() => setCopied(true)}>{copied ? 'Copied' : 'Copy steps for the owner'}</Button>
                    <Button variant="secondary" size="compact" type="button" trailingIcon={glyph(LinkExternal01)}>I'm an owner: open on GitHub</Button>
                    <Button variant="ghost" size="compact" type="button" onClick={() => setCancelled(true)}>Cancel request</Button>
                  </>}>
                  <Fact label="Requested">by you · {time(at(17))}, and again {time(at(8))} (shown once)</Fact>
                  <Fact label="For">Landscaping Portal · <span className="font-mono">BrandByX/payne-portals</span></Fact>
                  <Fact label="Waiting"><Clock className="mr-1 inline align-[-2px]" width={12} height={12} strokeWidth={1.5} />17 hours · GitSpace keeps the install when an owner of BrandByX approves it, whenever that is.</Fact>
                  <OwnerSteps org="BrandByX" />
                </OrganizationRow>}
      {scenario === 'waiting'
        ? <OrganizationRow login="unknown" index={2} summary="Organization not known yet" state={<Badge variant="dot" size="compact" color="gray">Requested</Badge>}
            actions={<>
              <Button variant="secondary" size="compact" type="button" leadingIcon={glyph(Copy01)}>Copy steps for the owner</Button>
              <Button variant="ghost" size="compact" type="button">Cancel request</Button>
            </>}>
            <Fact label="Requested">by you · {time(at(30))} from Install on GitHub, for an organization you don't own</Fact>
            <Fact label="Note">GitHub doesn't tell GitSpace which organization a request is for. When an owner approves it, GitSpace asks you to confirm the install before using it.</Fact>
            <OwnerSteps org={null} />
          </OrganizationRow>
        : null}
    </CardGroup>
    <UninstallDialog org={uninstalling ?? ''} projects={uninstalling === 'BrandByX' ? 'Landscaping Portal' : 'GitSpace and inkibra core'} open={uninstalling !== null} onOpenChange={open => { if (!open) setUninstalling(null); }} />
    {scenario === 'stranger'
      ? <div className="flex items-center gap-2 text-caption text-muted-foreground">
          <span>GitSpace removed {REMOVED.length} installs it didn't expect · latest {time(REMOVED[0]?.at ?? at(0))}</span>
          <Button variant="tertiary" size="compact" type="button" onClick={() => setReviewingRemoved(true)}>Review</Button>
        </div>
      : null}
    <Dialog open={reviewingRemoved} onOpenChange={setReviewingRemoved}>
      {reviewingRemoved ? <DialogContent>
        <DialogHeader>
          <DialogTitle>Installs GitSpace removed</DialogTitle>
          <DialogDescription>Each was installed with no pending request that could be for its organization, and not by you, so GitSpace uninstalled it right away. The latest 50 are kept.</DialogDescription>
        </DialogHeader>
        <ul className="flex max-h-[320px] flex-col gap-2 overflow-y-auto text-caption">
          {REMOVED.map(item => <li key={`${item.org}-${item.at}`} className="flex gap-3">
            <span className="w-32 shrink-0 tabular-nums text-muted-foreground">{time(item.at)}</span>
            <span className="min-w-0 flex-1 text-foreground">{item.org}</span>
            <span className="font-mono text-muted-foreground">by {item.by}</span>
          </li>)}
        </ul>
        <p className="text-caption text-muted-foreground">Was one of these yours? Install again from Install on GitHub, or from the project that needs it, so GitSpace expects it.</p>
        <DialogFooter>
          <Button variant="secondary" type="button" onClick={() => setReviewingRemoved(false)}>Close</Button>
          <Button variant="ghost" type="button" onClick={() => setReviewingRemoved(false)}>Clear list</Button>
        </DialogFooter>
      </DialogContent> : null}
    </Dialog>
  </>;
}

function ProposedPage({ scenario }: { scenario: Exclude<Scenario, 'today'> }): ReactElement {
  return <div className="flex flex-col gap-8">
    <section className="flex flex-col gap-3" aria-label="Your GitHub App">
      <CardGroup orientation="inline" border="outlined" proximityHover={false}>
        <Card size="compact" index={0}>
          <CardMedia icon={monogram('G')} />
          <CardHeader><span className="text-body font-medium text-foreground">{APP}</span><CardDescription>Owned by bradleat · created Oct 17 · private key Oct 17</CardDescription></CardHeader>
          <CardFooter className="gap-2">
            <Button variant="primary" size="compact" type="button" trailingIcon={glyph(LinkExternal01)}>Install on GitHub</Button>
            <Button variant="ghost" size="compact" type="button">Replace private key</Button>
          </CardFooter>
        </Card>
      </CardGroup>
      <p className="text-caption text-muted-foreground">On an account you own, GitHub installs it at once. Elsewhere GitHub sends the owners a request; GitSpace asks you to confirm the install when it arrives. To give one project access, start from that project: GitSpace then knows the organization and keeps the install itself.</p>
    </section>
    <section className="flex flex-col gap-3" aria-label="Organizations">
      <h2 className="text-subtitle font-semibold text-foreground">Organizations</h2>
      <Organizations key={scenario} scenario={scenario} />
    </section>
    <Accordion type="single" collapsible>
      <AccordionItem value="deliveries" index={0}>
        <AccordionTrigger>Recent webhook deliveries · 20</AccordionTrigger>
        <AccordionContent>
          <ul className="flex flex-col gap-2 text-caption">
            <li className="flex gap-3"><span className="w-36 shrink-0 tabular-nums text-muted-foreground">{time('2026-10-31T17:17:25.000Z')}</span><span className="font-mono">check_suite.completed</span><span className="text-muted-foreground">inKibra/core · ran 1 automation</span></li>
            <li className="flex gap-3"><span className="w-36 shrink-0 tabular-nums text-muted-foreground">{time('2026-10-31T14:08:15.000Z')}</span><span className="font-mono">installation.created</span><span className="text-muted-foreground">BrandByX · your request, kept</span></li>
          </ul>
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  </div>;
}

function MockSidebar(): ReactElement {
  const nav: readonly { label: string; icon: IconComponent }[] = [
    { label: 'Kanban', icon: glyph(Columns03) }, { label: 'Projects', icon: glyph(FolderClosed) }, { label: 'Inference', icon: glyph(Stars01) },
    { label: 'Plugins', icon: glyph(PuzzlePiece01) }, { label: 'Automations', icon: glyph(Zap) }, { label: 'Secrets & values', icon: glyph(Key01) }, { label: 'Monitoring', icon: glyph(Activity) },
  ];
  return <Sidebar variant="inset">
    <SidebarHeader><SidebarWorkspaceHeader name="GitSpace" tile={<WorkspaceTile>G</WorkspaceTile>} /></SidebarHeader>
    <SidebarContent>
      <SidebarGroup collapsible><SidebarGroupLabel>Navigate</SidebarGroupLabel>
        <SidebarMenu>{nav.map(item => <SidebarMenuItem key={item.label}><SidebarMenuButton icon={item.icon}>{item.label}</SidebarMenuButton></SidebarMenuItem>)}</SidebarMenu>
      </SidebarGroup>
    </SidebarContent>
    <SidebarFooter><SidebarUserFooter name="Bradley Leatherwood" avatar={<span className="flex size-5 items-center justify-center rounded-full bg-muted-foreground text-[10px] font-semibold text-background">B</span>} menu={<MenuItem index={0} label="Settings" onSelect={() => undefined} />} /></SidebarFooter>
  </Sidebar>;
}

function GitHubSettingsMock(): ReactElement {
  const [scenario, setScenario] = useState<Scenario>('waiting');
  return <div className="flex h-dvh flex-col bg-background">
    <SidebarProvider className="gitspace-shell min-h-0 flex-1" persist={false}>
      <MockSidebar />
      <SidebarInset className="min-w-0">
        <SidebarInsetTopbar><span className="text-body font-medium">Account settings</span></SidebarInsetTopbar>
        <PageCanvas>
          <PageHeader kicker="Settings" title="GitHub" description="Your GitHub App reads your private repositories and sends their events here. GitSpace reaches a private repository only through an organization the App is installed on." />
          {scenario === 'today'
            ? <div className="flex flex-col gap-8"><GitHubSettings github={TODAY} onStartGitHubApp={async () => { throw new Error('mock'); }} onStartGitHubInstall={async () => '#'} onRotateGitHubKey={async () => { throw new Error('mock'); }} onGitHubAction={async () => undefined} /></div>
            : <ProposedPage scenario={scenario} />}
        </PageCanvas>
      </SidebarInset>
    </SidebarProvider>
    <div className="fixed right-4 top-3 z-50">
      <DropdownMenu>
        <DropdownTrigger render={<Button variant="secondary" size="compact" type="button" className="border border-dashed border-border shadow-surface-1">{SCENARIOS.find(item => item.id === scenario)?.label} (mock)</Button>} />
        <DropdownContent align="end" className="w-[300px] min-w-[300px]">{SCENARIOS.map((item, index) => <MenuItem key={item.id} index={index} label={item.label} onSelect={() => setScenario(item.id)} />)}</DropdownContent>
      </DropdownMenu>
    </div>
  </div>;
}

restoreAppearance();
const root = document.getElementById('root');
if (!root) throw new Error('root missing');
createRoot(root).render(<StrictMode>
  <ShapeProvider defaultShape="rounded"><SizeProvider defaultSize="default"><IconProvider icons={untitledIcons}><TooltipProvider>
    <GitHubSettingsMock />
  </TooltipProvider></IconProvider></SizeProvider></ShapeProvider>
</StrictMode>);
