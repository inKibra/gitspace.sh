// The workspace's Environment popover, by scope: who pays for inference (the holders' own model credentials in sticky
// rotation, the team's when every one is out), Git (each repository's route: GitHub App tokens where the App covers
// it, else the machine's scope's SSH key; the turn starter is the author), the machine profiles this workspace needs
// (its project's and any it added, with "Add a profile") and whether its machine is ready for them, the Team's
// resources every workspace uses, the tools from MCP servers hosted on machines (team servers on in the project and
// holders' own; an offline one's tools stay listed with the reason; calls go through the relay), the secrets the viewer's turns may use here (each with its rule; a cleared-shell one
// opens with a passkey and Drop closes it), each holder's own providers, MCP connections, browsers and machines (they
// join while that holder holds the handle; a bot holder's too, but never a cleared shell: a bot has no passkey), and
// resources of people who let go, detached.
import { Popover } from '@base-ui/react/popover';
import { badgeColors, Button, Tooltip } from '@gitspace/ui';
import { ArrowRight, CheckCircle, ChevronDown, CpuChip02, Fingerprint01, GitBranch01, Globe01, Key01, Link01, LinkBroken01, Lock01, Plus, Server01, Stars01, Users01 } from '@untitledui/icons';
import { useRef, useState, type ComponentType, type ReactNode } from 'react';
import { ACCOUNT_RESOURCES, actorLabel, DETACHED, findPrincipal, principalOf, SPENT_TODAY, stepUps, USER_RESOURCES, userOf, WORKSPACES, type Resource } from './data.js';
import { machineProfiles, machineReadiness, projectProfiles, workspaceProfiles } from './flows/env-model.js';
import { profileName, readinessText, workspaceMachine } from './flows/env-page.js';
import { WorkspaceMachineTools } from './flows/machine-mcp.js';
import { dropShell, StepUpDialog, useWorkspaceSecrets, type ShellTarget } from './flows/secret-rules.js';
import { Avatar } from './people.js';
import { appCovers, MACHINES, PROFILES, projectSettings } from './settings/data.js';
import { useMock } from './viewer.js';

type Glyph = ComponentType<{ width?: number; height?: number; strokeWidth?: number; className?: string }>;
const KIND: Readonly<Record<Resource['kind'], { label: string; icon: Glyph }>> = {
  machine: { label: 'Machines', icon: Server01 }, browser: { label: 'Browser', icon: Globe01 }, connection: { label: 'MCP connections', icon: Link01 }, model: { label: 'Providers', icon: Stars01 },
};
const ORDER: readonly Resource['kind'][] = ['machine', 'browser', 'connection', 'model'];

/** The provider the profile's role uses; only holders' credentials for it count. */
const PROVIDER = 'Anthropic';

export interface Payer {
  /** The holder whose credential pays, or null for the team's. */
  userId: string | null;
  /** Holders whose credential for the provider is out, with why. */
  out: ReadonlyArray<{ userId: string; why: string }>;
  /** Holders available in rotation after the payer, least spent today first. */
  next: readonly string[];
}

function credentialOf(userId: string): Resource | undefined {
  return USER_RESOURCES[userId]?.find((resource) => resource.kind === 'model' && resource.name.startsWith(PROVIDER));
}

/** Sticky rotation: the turn starter's credential first while available (`sticky`), else the available holder who
 * spent least today; a bot holder's own provider rotates like a person's. Every holder out (or none with one) is the
 * team's. */
export function payerOf(holders: readonly string[], sticky: string): Payer {
  const withCredential = holders.filter((id) => credentialOf(id) !== undefined);
  const out = withCredential.filter((id) => credentialOf(id)?.state === 'out').map((id) => ({ userId: id, why: credentialOf(id)?.detail ?? 'out' }));
  const available = withCredential.filter((id) => credentialOf(id)?.state === 'ok').sort((a, b) => (SPENT_TODAY[a] ?? 0) - (SPENT_TODAY[b] ?? 0));
  const userId = available.includes(sticky) ? sticky : available[0] ?? null;
  return { userId, out, next: available.filter((id) => id !== userId) };
}

/** One line: who pays now and why. */
export function payerLine(payer: Payer): string {
  const paying = payer.userId ? `${principalOf(payer.userId).first}’s ${PROVIDER}` : `the team’s ${PROVIDER} key`;
  if (!payer.out.length) return `Using ${paying}`;
  return `${payer.out.map((entry) => `${principalOf(entry.userId).first}’s ${PROVIDER}`).join(', ')} ${payer.out.length === 1 ? 'is' : 'are'} ${payer.out[0]?.why.split(' · ')[0]?.toLowerCase()} → using ${paying}`;
}

function ResourceRow({ icon: Icon, name, detail, tone, dim }: { icon: Glyph; name: string; detail: string; tone?: string; dim?: boolean }) {
  return <li className={`flex min-w-0 items-center gap-2 py-0.5 text-[12px] ${dim ? 'opacity-55' : ''}`}>
    <Icon width={13} height={13} strokeWidth={1.75} className="shrink-0 text-muted-foreground" />
    <span className="min-w-0 truncate text-foreground">{name}</span>
    <span className="min-w-0 flex-1 truncate text-right text-[11px]" style={tone ? { color: tone } : undefined}><span className={tone ? '' : 'text-muted-foreground'}>{detail}</span></span>
  </li>;
}

function Section({ title, icon, note, children }: { title: string; icon: ReactNode; note: string; children: ReactNode }) {
  return <section className="flex flex-col gap-1 border-t border-border px-3 py-2 first:border-t-0">
    <header className="flex items-center gap-1.5 text-[12px] font-medium text-foreground">{icon}{title}<span className="font-normal text-muted-foreground">· {note}</span></header>
    {children}
  </section>;
}

function Resources({ resources, empty }: { resources: readonly Resource[]; empty: string }) {
  if (!resources.length) return <p className="text-[11.5px] text-muted-foreground">{empty}</p>;
  return <ul className="flex flex-col">{ORDER.flatMap((kind) => resources.filter((resource) => resource.kind === kind)).map((resource) => <ResourceRow key={resource.name} icon={KIND[resource.kind].icon} name={resource.name}
    detail={resource.detail} tone={resource.state === 'out' ? badgeColors.orange : undefined} dim={resource.state === 'off'} />)}</ul>;
}

export function EnvironmentPopover({ workspaceId, holders, viewer, sticky, left, defaultOpen = false }: { workspaceId: string; holders: readonly string[]; viewer: string; sticky: string; left: readonly string[]; defaultOpen?: boolean }) {
  const { say } = useMock();
  const popup = useRef<HTMLDivElement | null>(null);
  const live = stepUps.use();
  const profiles = machineProfiles.use();
  const readiness = machineReadiness.use();
  const added = workspaceProfiles.use()[workspaceId] ?? [];
  const project = WORKSPACES.find((workspace) => workspace.id === workspaceId)?.projectId ?? '';
  const fromProject = projectProfiles.use()[project] ?? [];
  const secrets = useWorkspaceSecrets(workspaceId, viewer);
  const [adding, setAdding] = useState(false);
  const [shell, setShell] = useState<ShellTarget | null>(null);
  const payer = payerOf(holders, sticky);
  const detached = [...(DETACHED[workspaceId] ?? []), ...left.flatMap((id) => (USER_RESOURCES[id] ?? []).filter((resource) => resource.kind === 'machine').map((resource) => ({ user: id, what: `${resource.name} · its processes` })))];
  const outShown = payer.out.length > 0;
  const settings = projectSettings.get()[project];
  const profile = PROFILES.find((entry) => entry.id === settings?.profile);
  const repositories = settings?.repositories ?? [];
  const starter = findPrincipal(sticky);
  const here = live.filter((entry) => entry.workspaceId === workspaceId && holders.includes(entry.userId));
  const machineId = workspaceMachine(workspaceId);
  const machineLabel = MACHINES.find((machine) => machine.id === machineId)?.label ?? machineId;
  const needed = [...fromProject, ...added.filter((id) => !fromProject.includes(id))];
  const readyFor = (id: string, machine: string): boolean => readiness[machine]?.[id]?.state === 'ready';
  const unready = needed.filter((id) => !readyFor(id, machineId));
  const better = unready.length ? MACHINES.find((machine) => machine.id !== machineId && machine.state === 'online' && needed.every((id) => readyFor(id, machine.id))) : undefined;
  const addable = profiles.filter((entry) => !needed.includes(entry.id));
  const holding = holders.includes(viewer);
  const add = (id: string): void => {
    workspaceProfiles.set({ ...workspaceProfiles.get(), [workspaceId]: [...added, id] });
    setAdding(false);
    say(readyFor(id, machineId) ? `Added ${profileName(id)} to ${workspaceId} · ${machineLabel} is ready for it` : `Added ${profileName(id)} to ${workspaceId} · ${machineLabel}: ${readinessText(readiness[machineId]?.[id])}`);
  };
  // Opening focuses the popover itself, so no button's tooltip opens with it.
  return <>
  <Popover.Root modal={false} defaultOpen={defaultOpen}>
    <Popover.Trigger data-environment="" aria-label="Environment"
      className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[11.5px] font-medium text-foreground shadow-[inset_0_0_0_1px_var(--border)] hover:bg-hover data-[popup-open]:bg-active">
      <Server01 width={13} height={13} strokeWidth={1.75} />Environment
      {outShown || unready.length ? <span className="size-1.5 rounded-full" style={{ background: badgeColors.orange }} /> : null}
      <ChevronDown width={12} height={12} className="opacity-70" />
    </Popover.Trigger>
    <Popover.Portal>
      <Popover.Positioner side="bottom" align="end" sideOffset={6} className="z-50 outline-none">
        <Popover.Popup data-environment-popup="" initialFocus={popup} ref={popup} tabIndex={-1} className="flex max-h-[min(760px,82vh)] w-[440px] flex-col overflow-y-auto rounded-2xl border border-border bg-background shadow-[0_12px_32px_-12px_rgba(0,0,0,0.35)] outline-none">
          <section data-payer="" className="flex flex-col gap-1.5 px-3 py-2.5" style={{ background: `color-mix(in oklab, ${outShown ? badgeColors.orange : badgeColors.green} 8%, transparent)` }}>
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Inference · who pays this turn</span>
            <span className="flex items-center gap-1.5 text-[13px] font-medium text-foreground">
              {payer.userId ? <Avatar userId={payer.userId} size={18} /> : <Users01 width={15} height={15} />}{payerLine(payer)}
            </span>
            <ol className="flex flex-col gap-0.5 text-[11.5px] text-muted-foreground">
              {payer.out.map((entry) => <li key={entry.userId} className="flex items-center gap-1.5"><Avatar userId={entry.userId} size={14} /><span>{principalOf(entry.userId).first}’s {PROVIDER} · <span style={{ color: badgeColors.orange }}>out · {entry.why}</span></span></li>)}
              {payer.userId ? <li className="flex items-center gap-1.5"><Avatar userId={payer.userId} size={14} /><span className="text-foreground">{principalOf(payer.userId).first}’s {PROVIDER} · paying · sticky until it runs out · ${(SPENT_TODAY[payer.userId] ?? 0).toFixed(2)} today</span></li> : null}
              {payer.next.map((id) => <li key={id} className="flex items-center gap-1.5"><Avatar userId={id} size={14} /><span>{principalOf(id).first}’s {PROVIDER} · next · ${(SPENT_TODAY[id] ?? 0).toFixed(2)} today</span></li>)}
              <li className="flex items-center gap-1.5"><Users01 width={13} height={13} /><span>Team {PROVIDER} key · {payer.userId ? 'when every holder is out' : holders.some((id) => principalOf(id).kind === 'bot') ? 'paying now · a bot holder brings its own providers, plugins and machines like a person; this one has no key of its own' : 'paying now'}</span></li>
            </ol>
            <span className="flex items-center gap-1 text-[11px] text-muted-foreground">Profile “{profile?.name}” · holders’ own: {profile?.personal.join(', ') || 'none, team providers only'}<ArrowRight width={11} height={11} />usage records which credential paid</span>
          </section>
          <Section title="Git" icon={<GitBranch01 width={14} height={14} strokeWidth={1.75} className="text-muted-foreground" />} note={starter ? `commits as ${starter.kind === 'person' ? `${starter.name} <${starter.email}>` : actorLabel(starter.id)}` : 'commits as whoever starts the turn'}>
            <ul data-git="" className="flex flex-col">{repositories.map((repository) => {
              const org = appCovers(repository);
              return <ResourceRow key={repository} icon={org ? GitBranch01 : Key01} name={repository.replace(/^github\.com\//, '')} detail={org ? `GitHub App (${org}) · short-lived token` : 'team SSH key · team machine'} />;
            })}</ul>
          </Section>
          <section data-workspace-profiles="" className="flex flex-col gap-1 border-t border-border px-3 py-2">
            <header className="flex items-center gap-1.5 text-[12px] font-medium text-foreground"><Server01 width={14} height={14} strokeWidth={1.75} className="text-muted-foreground" />Machine profiles<span className="font-normal text-muted-foreground">· on {machineLabel} · {unready.length ? `${unready.length} not ready` : 'ready'}</span></header>
            <ul className="flex flex-col">{needed.map((id) => {
              const ready = readyFor(id, machineId);
              return <ResourceRow key={id} icon={ready ? CheckCircle : Server01} name={`${profileName(id)}${added.includes(id) ? ' · added here' : ' · project'}`} detail={readinessText(readiness[machineId]?.[id])} tone={ready ? badgeColors.green : badgeColors.orange} />;
            })}</ul>
            {better ? <p className="text-[11.5px] text-muted-foreground">Placement prefers a ready machine: {better.label} is ready for all of them.</p> : null}
            {adding ? <div data-add-profile="" className="flex flex-wrap items-center gap-1.5">{addable.length ? addable.map((entry) => <Button key={entry.id} variant="secondary" size="compact" onClick={() => add(entry.id)}>{entry.name} · {entry.summary}</Button>) : <span className="text-[11.5px] text-muted-foreground">This workspace has every profile in the team’s library.</span>}
              <Button variant="ghost" size="compact" onClick={() => setAdding(false)}>Cancel</Button></div>
              : <Tooltip content={holding ? 'For this workspace only; the project’s list is in its settings › Environment' : 'Only its holders add a profile for this workspace'} side="left">
                <span className="self-start"><Button variant="secondary" size="compact" aria-disabled={holding ? undefined : true} className={holding ? undefined : 'opacity-45'} onClick={() => { if (holding) setAdding(true); else say('Only its holders add a profile for this workspace'); }}><Plus width={13} height={13} strokeWidth={1.75} />Add a profile</Button></span>
              </Tooltip>}
          </section>
          <Section title="Team" icon={<Users01 width={14} height={14} strokeWidth={1.75} className="text-muted-foreground" />} note="account and project resources · every workspace">
            <Resources resources={ACCOUNT_RESOURCES} empty="None" />
          </Section>
          <WorkspaceMachineTools workspaceId={workspaceId} holders={holders} viewer={viewer} />
          <section data-workspace-secrets="" className="flex flex-col gap-1 border-t border-border px-3 py-2">
            <header className="flex items-center gap-1.5 text-[12px] font-medium text-foreground"><Lock01 width={14} height={14} strokeWidth={1.75} className="text-muted-foreground" />Secrets your turns may use<span className="font-normal text-muted-foreground">· by each secret’s rule</span></header>
            {secrets.length ? <ul className="flex flex-col gap-0.5">{secrets.map((entry) => <li key={entry.key} data-workspace-secret={entry.key} className={`flex min-w-0 items-center gap-2 py-0.5 text-[12px] ${entry.blocked ? 'opacity-55' : ''}`}>
              <Key01 width={13} height={13} strokeWidth={1.75} className="shrink-0 text-muted-foreground" />
              <span className="flex min-w-0 flex-1 flex-col"><span className="truncate font-mono text-foreground">{entry.name}</span><span className="truncate text-[11px] text-muted-foreground" title={entry.blocked ?? entry.line}>{entry.blocked ?? entry.line}</span></span>
              {entry.shell?.open ? <span className="shrink-0 text-[11px]" style={{ color: entry.shell.open.minutesLeft <= 15 ? badgeColors.orange : undefined }}>open · {entry.shell.open.minutesLeft} min left</span>
                : entry.shell && !entry.blocked ? <Button variant="secondary" size="compact" onClick={() => setShell(entry.shell?.target ?? null)}><Fingerprint01 width={13} height={13} strokeWidth={1.75} />Step up</Button> : null}
            </li>)}</ul> : <p className="text-[11.5px] text-muted-foreground">No secret’s rule includes you here</p>}
          </section>
          {holders.map((id) => {
            const principal = principalOf(id);
            if (principal.kind === 'bot') return <Section key={id} title={actorLabel(id)} icon={<Avatar userId={id} size={16} />} note="holder · bot · its own providers, plugins and machines join while holding">
              <Resources resources={USER_RESOURCES[id] ?? []} empty="Nothing of its own: it uses the team’s" />
              <p className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground"><CpuChip02 width={13} height={13} strokeWidth={1.75} className="shrink-0" />No cleared shell: a bot has no passkey. It proposes approvals; a person accepts.</p>
            </Section>;
            return <Section key={id} title={`${principal.first}${id === viewer ? ' (you)' : ''}`} icon={<Avatar userId={id} size={16} />} note="holder · providers, MCP connections, browsers, machines join while holding">
              <Resources resources={USER_RESOURCES[id] ?? []} empty="Nothing of their own yet" />
            </Section>;
          })}
          <section data-step-ups="" className="flex flex-col gap-1.5 border-t border-border px-3 py-2">
            <header className="flex items-center gap-1.5 text-[12px] font-medium text-foreground"><Fingerprint01 width={14} height={14} strokeWidth={1.75} className="text-muted-foreground" />Cleared shells open here<span className="font-normal text-muted-foreground">· passkey · only their own turns</span></header>
            {here.length ? <ul className="flex flex-col gap-1">{here.map((entry) => {
              const others = holders.filter((id) => id !== entry.userId && principalOf(id).kind === 'person');
              const mine = entry.userId === viewer;
              return <li key={entry.id} data-step-up={entry.id} className="flex min-w-0 items-start gap-2 rounded-xl bg-surface-2 px-2 py-1.5 text-[12px]">
                <Avatar userId={entry.userId} size={16} />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-foreground"><span className="font-medium">{userOf(entry.userId).first}</span> · {entry.credential}</span>
                  <span className="text-[11px] text-muted-foreground">{entry.scope} · <span style={{ color: entry.minutesLeft <= 15 ? badgeColors.orange : undefined }}>{entry.minutesLeft} min left</span>{others.length ? ` · not shared with ${others.map((id) => userOf(id).first).join(' or ')}` : ''}</span>
                </span>
                <Tooltip content={mine ? 'Ends it now; letting go of the handle ends it too' : `Only ${userOf(entry.userId).first} drops it; it ends when they let go`} side="left">
                  <span><Button variant="ghost" size="compact" aria-disabled={mine ? undefined : true} className={mine ? undefined : 'opacity-45'}
                    onClick={() => { if (!mine) { say(`Only ${userOf(entry.userId).first} drops their cleared shell`); return; } dropShell(entry); say(`Dropped ${entry.credential} · your next turns here run without it`); }}>Drop</Button></span>
                </Tooltip>
              </li>;
            })}</ul> : <p className="text-[11.5px] text-muted-foreground">No holder has a cleared shell open here</p>}
          </section>
          {detached.length ? <section className="flex flex-col gap-1 border-t border-border px-3 py-2">
            <header className="flex items-center gap-1.5 text-[12px] font-medium text-foreground"><LinkBroken01 width={14} height={14} strokeWidth={1.75} className="text-muted-foreground" />Detached<span className="font-normal text-muted-foreground">· their users let go; processes keep running</span></header>
            <ul>{detached.map((entry) => <li key={entry.what} className="flex items-center gap-2 py-0.5 text-[12px] text-muted-foreground"><Avatar userId={entry.user} size={14} /><span className="truncate">{entry.what}</span><span className="ml-auto shrink-0 text-[11px]">detached</span></li>)}</ul>
          </section> : null}
        </Popover.Popup>
      </Popover.Positioner>
    </Popover.Portal>
  </Popover.Root>
  {shell ? <StepUpDialog target={shell} workspaceId={workspaceId} onClose={() => setShell(null)} /> : null}
  </>;
}
