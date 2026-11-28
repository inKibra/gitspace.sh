// Usage: inference, services and compute spend now, today and this week, by person, bot, project, profile and
// provider; personal plans' subscription windows (how much of the limit is used); budgets against month-to-date
// spend. Budgets are set in Settings (Crumb & Co › Inference) and only shown here. Owners and Admins see the whole
// team; a Member sees their own spend, their projects', their plans' windows and their projects' budgets.
import { glyph } from '../../glyph.js';
import { CoinsStacked01 } from '@untitledui/icons';
import type { ReactNode } from 'react';
import { visibleProjects } from '../data.js';
import { budgets, MODEL_CREDENTIALS, projectName, RECENT_TURNS } from '../settings/data.js';
import { Note, Pill, Section, SettingRow, SettingRows, UserName } from '../settings/parts.js';
import { useMock, useViewer } from '../viewer.js';
import { SPEND, SPEND_BY_PRINCIPAL, SPEND_BY_PROFILE, SPEND_BY_PROJECT, SPEND_BY_PROVIDER, SUBSCRIPTION_WINDOWS } from './data.js';
import { LivePage, Meter, money, seesTeam, Stat, StatStrip } from './parts.js';

function Table({ head, rows }: { head: readonly string[]; rows: ReadonlyArray<ReadonlyArray<ReactNode>> }) {
  return <div className="overflow-x-auto rounded-xl shadow-[inset_0_0_0_1px_var(--border)]">
    <table className="w-full border-collapse text-body">
      <thead><tr className="border-b border-border">{head.map((cell, index) => <th key={cell} className={`px-3 py-2 text-caption font-medium text-muted-foreground ${index ? 'text-right' : 'text-left'}`}>{cell}</th>)}</tr></thead>
      <tbody>{rows.map((row, rowIndex) => <tr key={rowIndex} className="border-t border-border/60">{row.map((cell, index) => <td key={index} className={`px-3 py-1.5 ${index ? 'text-right tabular-nums' : ''}`}>{cell}</td>)}</tr>)}</tbody>
    </table>
  </div>;
}

export function UsagePage() {
  const viewer = useViewer();
  const { navigate } = useMock();
  const team = seesTeam(viewer);
  const seen = visibleProjects(viewer.id);
  const principals = SPEND_BY_PRINCIPAL.filter((row) => team || row.id === viewer.id);
  const projects = SPEND_BY_PROJECT.filter((row) => seen.has(row.projectId));
  const windows = SUBSCRIPTION_WINDOWS.filter((row) => team || row.userId === viewer.id);
  const shown = budgets.use().filter((budget) => team || (budget.scope === 'project' && seen.has(budget.target)) || budget.target === viewer.id);
  const mine = SPEND_BY_PRINCIPAL.find((row) => row.id === viewer.id);
  const turns = RECENT_TURNS.filter((turn) => team || turn.startedBy === viewer.id || turn.holders.includes(viewer.id));
  return <LivePage title="Usage" viewer={viewer} description="Inference, services and compute spend: now, today and this week. Budgets are set in Settings and shown here."
    configure={team ? { label: 'Budgets in Settings', onClick: () => navigate('settings', { page: 'inference' }) } : undefined}>
    <StatStrip>
      <Stat label="Team now" value={`${money(SPEND.now.perHour)}/h`} detail={`${SPEND.now.turns} turns running · ${SPEND.now.machines} machines busy`} />
      <Stat label="Team today" value={money(SPEND.today.inference + SPEND.today.services + SPEND.today.compute)} detail={`inference ${money(SPEND.today.inference)} · services ${money(SPEND.today.services)} · compute ${money(SPEND.today.compute)}`} />
      <Stat label="Team this week" value={money(SPEND.week.inference + SPEND.week.services + SPEND.week.compute)} detail={`inference ${money(SPEND.week.inference)} · services ${money(SPEND.week.services)} · compute ${money(SPEND.week.compute)}`} />
      {team ? null : <Stat label="Yours today" value={money(mine?.today ?? 0)} detail="turns you started, whoever’s credential paid" tone="good" />}
      {team ? null : <Stat label="Yours this week" value={money(mine?.week ?? 0)} tone="good" />}
    </StatStrip>

    <Section title={<span className="inline-flex items-center gap-2">Budgets<Pill tone="violet">New</Pill></span>} description="Month to date against each budget. A new feature: budgets don’t exist in GitSpace yet. Set in Settings → Crumb & Co → Inference.">
      {shown.length ? <SettingRows label="Budgets">{shown.map((budget) => {
        const used = Math.round((budget.spent / budget.monthly) * 100);
        return <SettingRow key={budget.id} media={glyph(CoinsStacked01)} title={<span data-usage-budget={budget.id} className="inline-flex items-center gap-2">{budget.label}<Pill>{budget.scope === 'team' ? 'Team' : budget.scope === 'project' ? 'Project' : 'Bot'}</Pill>{used >= budget.alertAt ? <Pill tone="amber">Past {budget.alertAt}%</Pill> : null}</span>}
          description={`${money(budget.spent)} of ${money(budget.monthly)} this month · ${budget.covers}`}>
          <Meter used={used} tone={used >= budget.alertAt ? 'amber' : undefined} /><span className="w-10 text-right text-caption tabular-nums text-muted-foreground">{used}%</span>
        </SettingRow>;
      })}</SettingRows> : <Note>No budgets cover your projects.</Note>}
    </Section>

    <Section title="Subscription windows" description="How much of each personal plan’s limit is used in its current window. When one runs out, the turn’s next holder’s or the team’s provider pays.">
      {windows.length ? <SettingRows label="Subscription windows">{windows.map((window) => <SettingRow key={window.id} title={<span data-window={window.id} className="inline-flex items-center gap-2">{window.plan}<Pill>{window.window}</Pill>{window.used >= 100 ? <Pill tone="red">Out</Pill> : null}</span>} description={window.resets}>
        <Meter used={window.used} tone={window.used >= 100 ? 'red' : window.used >= 80 ? 'amber' : undefined} /><span className="w-10 text-right text-caption tabular-nums text-muted-foreground">{window.used}%</span>
      </SettingRow>)}</SettingRows> : <Note>You have no subscriptions connected.</Note>}
    </Section>

    <Section title={team ? 'By person and bot' : 'You'} description="Turns each started, whoever’s credential paid.">
      <Table head={['Person or bot', 'Today', 'This week']} rows={principals.map((row) => [<UserName key="u" userId={row.id} you={viewer.id} />, money(row.today), money(row.week)])} />
    </Section>
    <Section title={team ? 'By project' : 'Your projects'} description="Inference and compute in each project’s workspaces.">
      <Table head={['Project', 'Today', 'This week']} rows={projects.map((row) => [projectName(row.projectId), money(row.today), money(row.week)])} />
    </Section>
    {team ? <div className="grid grid-cols-1 gap-10 lg:grid-cols-2">
      <Section title="By profile"><Table head={['Profile', 'Today', 'This week']} rows={SPEND_BY_PROFILE.map((row) => [row.profile, money(row.today), money(row.week)])} /></Section>
      <Section title="By provider"><Table head={['Provider or service', 'Today', 'This week']} rows={SPEND_BY_PROVIDER.map((row) => [row.provider, money(row.today), money(row.week)])} /></Section>
    </div> : null}
    <Section title="Recent turns" description="Who started each turn and which credential paid.">
      <SettingRows label="Recent turns">{turns.map((turn) => <SettingRow key={`${turn.time}${turn.workspaceId}`}
        title={<span className="inline-flex items-center gap-2"><span className="tabular-nums text-muted-foreground">{turn.time}</span>{turn.workspaceId}</span>}
        description={<span className="inline-flex flex-wrap items-center gap-1">started by <UserName userId={turn.startedBy} client={turn.client} /> · {turn.note}</span>}>
        <Pill tone={turn.paidBy.startsWith('team') ? 'gray' : 'violet'}>{MODEL_CREDENTIALS.find((entry) => entry.id === turn.paidBy)?.label ?? turn.paidBy}</Pill>
      </SettingRow>)}</SettingRows>
    </Section>
  </LivePage>;
}
