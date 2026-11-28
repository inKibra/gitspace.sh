// Services, as a monitoring dashboard of every URL GitSpace serves right now. A stats strip (services running,
// crashed, previews live, share links active and expiring today); crashed services pinned on top with their last log
// lines; each workspace service and deployed site with up or down, uptime, requests a minute, error rate and p50
// latency, each with its last hour as a sparkline (and the last deploy for sites); share links with visitors, opens,
// expiry and Revoke (the sharer, Owners, Admins and the project's Leads). One click opens each. Owners and Admins see
// the whole team's; a Member sees their projects'.
import { glyph } from '../../glyph.js';
import { Button } from '@gitspace/ui';
import { LinkExternal01 } from '@untitledui/icons';
import type { ReactNode } from 'react';
import { userOf, visibleProjects, WORKSPACES } from '../data.js';
import { projectName, recordAudit } from '../settings/data.js';
import { Act, Note, Pill, Section, SettingRow, SettingRows, UserName } from '../settings/parts.js';
import { projectRoleOf } from '../settings/roles.js';
import { useMock, useViewer } from '../viewer.js';
import { DEPLOYMENTS, SERVICE_HEALTH, SHARE_VISITORS, shareLinks, WORKSPACE_SERVICES, type ServiceHealth } from './data.js';
import { Dot, LivePage, Panel, PanelGrid, seesTeam, Sparkline, Stat, StatStrip } from './parts.js';

const projectOf = (workspaceId: string): string => WORKSPACES.find((workspace) => workspace.id === workspaceId)?.projectId ?? '';
/** "in 58 min" and "in 23 h" run out today; "in 2 days" doesn't. */
const EXPIRES_TODAY = /\b(min|h)$/;

function OpenUrl({ url }: { url: string }) {
  const { say } = useMock();
  return <Button variant="ghost" size="compact" leadingIcon={glyph(LinkExternal01)} aria-label={`Open ${url}`} title={url} onClick={() => say(`Opens ${url} in a new tab`)} className="min-w-0 max-w-full"><span className="truncate font-mono text-[11.5px]">{url.replace('https://', '')}</span></Button>;
}

/** Up/down, uptime, requests a minute, errors and p50, each with the last hour. */
function Health({ health }: { health: ServiceHealth }) {
  const cell = (label: string, value: string, values: readonly number[], tone: 'good' | 'warn' | 'bad' | 'muted') => <div className="flex min-w-0 flex-col gap-0.5">
    <span className="text-[11px] text-muted-foreground">{label}</span>
    <span className="text-caption font-medium tabular-nums text-foreground">{value}</span>
    <Sparkline values={values} tone={tone} width={96} height={22} label={`${label} over the last hour`} />
  </div>;
  return <div className="grid grid-cols-3 gap-3">
    {cell('Requests/min', String(health.rpm), health.rpmSeries, health.up ? 'good' : 'muted')}
    {cell('Errors', `${health.errors}%`, health.errSeries, health.errors >= 5 ? 'bad' : health.errors >= 1 ? 'warn' : 'good')}
    {cell('p50', health.up ? `${health.p50} ms` : '—', health.latSeries, health.p50 >= 300 ? 'warn' : 'good')}
  </div>;
}

function ServicePanel({ id, title, pills, meta, url, health, children }: { id: string; title: string; pills: ReactNode; meta: ReactNode; url: string; health: ServiceHealth | undefined; children?: ReactNode }) {
  return <Panel id={id} head={<>
    <Dot tone={health?.up === false ? 'bad' : 'good'} pulse={health?.up !== false} />
    <span title={title} data-service={id} className="min-w-0 max-w-full truncate text-body font-semibold text-foreground">{title}</span>
    {pills}
    <span className="ml-auto text-caption text-muted-foreground">{health ? `${health.up ? 'Up' : 'Down'} · uptime ${health.uptime}` : ''}</span>
  </>}>
    <span className="flex flex-wrap items-center gap-1 text-caption text-muted-foreground">{meta}</span>
    {health ? <Health health={health} /> : null}
    {children}
    <div className="flex min-w-0 justify-end"><OpenUrl url={url} /></div>
  </Panel>;
}

export function ServicesPage() {
  const viewer = useViewer();
  const { say } = useMock();
  const links = shareLinks.use();
  const seen = visibleProjects(viewer.id);
  const team = seesTeam(viewer);
  const services = WORKSPACE_SERVICES.filter((service) => seen.has(projectOf(service.workspaceId)));
  const crashed = services.filter((service) => SERVICE_HEALTH[service.id]?.up === false);
  const healthy = services.filter((service) => SERVICE_HEALTH[service.id]?.up !== false);
  const deployments = DEPLOYMENTS.filter((deployment) => seen.has(deployment.projectId));
  const shares = links.filter((link) => seen.has(link.projectId));
  return <LivePage title="Services" viewer={viewer} description={`Every URL GitSpace serves right now${team ? '' : ' in your projects'}, with how it’s doing over the last hour. One click opens each.`}>
    <StatStrip>
      <Stat label="Services running" value={String(healthy.length)} detail="dev servers and previews, through the relay" tone="good" />
      <Stat label="Crashed" value={String(crashed.length)} detail={crashed.map((service) => service.workspaceId).join(', ') || 'None'} tone={crashed.length ? 'bad' : undefined} />
      <Stat label="Sites and previews live" value={String(deployments.length)} detail={`${deployments.filter((deployment) => deployment.kind === 'Preview').length} pull-request previews`} />
      <Stat label="Share links active" value={String(shares.length)} detail={`${shares.reduce((sum, link) => sum + (SHARE_VISITORS[link.id]?.visitors ?? 0), 0)} visitors`} />
      <Stat label="Expiring today" value={String(shares.filter((link) => EXPIRES_TODAY.test(link.expires)).length)} detail={shares.filter((link) => EXPIRES_TODAY.test(link.expires)).map((link) => link.kind).join(', ')} tone="warn" />
    </StatStrip>
    {crashed.length ? <Section title="Crashed" description="Pinned on top with their last log lines until they run again.">
      <PanelGrid>{crashed.map((service) => <ServicePanel key={service.id} id={service.id} title={`${service.name} · ${service.workspaceId}`} url={service.url} health={SERVICE_HEALTH[service.id]}
        pills={<><Pill>:{service.port}</Pill><Pill tone="red">Crashed</Pill></>}
        meta={<>on {service.machine} · started by <UserName userId={service.startedBy} /> · {service.since}</>}>
        <pre data-crash-log={service.id} className="overflow-x-auto whitespace-pre-wrap rounded-lg bg-[#101828] px-2.5 py-2 font-mono text-[11px] leading-relaxed text-[#fda29b]">{(SERVICE_HEALTH[service.id]?.logs ?? []).join('\n')}</pre>
        <div className="flex flex-wrap justify-end gap-1.5"><Button variant="secondary" size="compact" onClick={() => say(`Restarts ${service.name} once ${service.machine} answers`)}>Restart</Button><Button variant="ghost" size="compact" onClick={() => say('Opens the full log')}>Full log</Button></div>
      </ServicePanel>)}</PanelGrid>
    </Section> : null}
    <Section title="Workspace services" description="Dev servers and previews workspaces run, reached through the relay. A detached one keeps running until its machine’s owner stops it.">
      <PanelGrid>{healthy.map((service) => <ServicePanel key={service.id} id={service.id} title={`${service.name} · ${service.workspaceId}`} url={service.url} health={SERVICE_HEALTH[service.id]}
        pills={<><Pill>:{service.port}</Pill>{service.state === 'detached' ? <Pill tone="amber">Detached</Pill> : null}</>}
        meta={<>{projectName(projectOf(service.workspaceId))} · on {service.machine} · started by <UserName userId={service.startedBy} /> · {service.since}</>} />)}</PanelGrid>
    </Section>
    <Section title="Sites and previews" description="What projects deploy: production, staging, and a preview per pull request.">
      <PanelGrid>{deployments.map((deployment) => <ServicePanel key={deployment.id} id={deployment.id} title={deployment.name} url={deployment.url} health={SERVICE_HEALTH[deployment.id]}
        pills={<Pill tone={deployment.kind === 'Production' ? 'green' : deployment.kind === 'Staging' ? 'blue' : 'gray'}>{deployment.kind}</Pill>}
        meta={<>{projectName(deployment.projectId)} · last deploy {deployment.when} from {deployment.from} by <UserName userId={deployment.by} /></>} />)}</PanelGrid>
    </Section>
    <Section title="Share links" description="Links people shared out of workspaces. The sharer, Owners, Admins and the project’s Leads revoke one; it stops working at once and the sharer is told.">
      {shares.length ? <SettingRows label="Share links">{shares.map((link) => {
        const lead = projectRoleOf(viewer.id, link.projectId)?.id === 'lead';
        const reason = link.by === viewer.id || team || lead ? null : `Only ${userOf(link.by).first}, Owners, Admins and ${projectName(link.projectId)}’s Leads revoke it`;
        const visits = SHARE_VISITORS[link.id];
        return <SettingRow key={link.id}
          title={<span data-share={link.id} className="inline-flex flex-wrap items-center gap-2">{link.title}<Pill>{link.kind}</Pill><Pill tone={EXPIRES_TODAY.test(link.expires) ? 'amber' : 'gray'}>Expires {link.expires}</Pill></span>}
          description={<span className="inline-flex flex-wrap items-center gap-1">shared by <UserName userId={link.by} you={viewer.id} /> · {link.created} · {link.workspaceId} · {link.audience}</span>}
          extra={<span className="mt-1 text-caption text-foreground">{visits?.visitors ?? 0} {visits?.visitors === 1 ? 'visitor' : 'visitors'} · opened {link.opens} {link.opens === 1 ? 'time' : 'times'} · last {visits?.last ?? '—'}</span>}>
          <OpenUrl url={link.url} />
          <Act reason={reason} variant="ghost" aria-label={`Revoke ${link.title}`} onClick={() => {
            shareLinks.set(shareLinks.get().filter((candidate) => candidate.id !== link.id));
            recordAudit({ actor: viewer.id, kind: 'resource', project: link.projectId, text: `Revoked the share link “${link.title}” (${link.kind}, shared by ${userOf(link.by).name})${lead && !team && link.by !== viewer.id ? ' as Lead' : ''}` });
            say(`Revoked · the link stops working now${link.by === viewer.id ? '' : '; its sharer is told'}`);
          }}>Revoke</Act>
        </SettingRow>;
      })}</SettingRows> : <Note>No active share links.</Note>}
    </Section>
  </LivePage>;
}
