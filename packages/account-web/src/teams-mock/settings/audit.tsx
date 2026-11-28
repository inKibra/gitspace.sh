// The audit log, for Owners and Admins: every prompt, comment, approval, handle change, phase move, setting change,
// membership and bot action, with who did it: a person, a person through their MCP client ("Maya via Claude Code"), or a
// bot with its sponsor ("Release bot (sponsored by Theo)"). Filters: person or bot (or any bot, any person), sponsor,
// kind, project, date range and text; they filter the list, and Export takes the filtered view or a period as CSV or
// JSON. Removed users keep their name here.
import { glyph } from '../../glyph.js';
import { Button, InputField, InputGroup, Select, SelectContent, SelectItem, SelectTrigger } from '@gitspace/ui';
import { Download01, SearchMd } from '@untitledui/icons';
import { useState } from 'react';
import { actorLabel, bots, findPrincipal, USERS } from '../data.js';
import { ExportAuditFlow } from '../flows/team.js';
import { AUDIT_TODAY } from '../flows/team-data.js';
import { useViewer } from '../viewer.js';
import { ACTIVE_PROJECTS, audit, projectName, type AuditEntry, type AuditKind } from './data.js';
import { Note, Pill, Section, SettingRow, SettingRows, UserName } from './parts.js';

const KIND: Readonly<Record<AuditKind, { label: string; tone: 'gray' | 'green' | 'amber' | 'red' | 'blue' | 'violet' | 'teal' }>> = {
  team: { label: 'Team', tone: 'blue' }, prompt: { label: 'Prompt', tone: 'gray' }, comment: { label: 'Comment', tone: 'gray' }, handle: { label: 'Handle', tone: 'violet' }, phase: { label: 'Phase', tone: 'teal' },
  approval: { label: 'Approval', tone: 'green' }, resource: { label: 'Resource', tone: 'gray' }, setting: { label: 'Setting', tone: 'gray' }, agent: { label: 'Agent permission', tone: 'amber' }, bot: { label: 'Bot', tone: 'red' },
};
const KINDS: ReadonlyArray<AuditKind | 'all'> = ['all', 'team', 'prompt', 'comment', 'handle', 'phase', 'approval', 'resource', 'setting', 'agent', 'bot'];
const RANGES: ReadonlyArray<{ id: string; label: string; days: number }> = [
  { id: 'all', label: 'Any time', days: Infinity }, { id: 'today', label: 'Today', days: 0 }, { id: '2d', label: 'Today and yesterday', days: 1 }, { id: '7d', label: 'Last 7 days', days: 6 }, { id: '30d', label: 'Last 30 days', days: 29 },
];

/** How many days ago an entry happened: "Just now" and "Today …" are 0, "Yesterday …" 1, "Nov 21 …" counts back from
 * the log's today. */
function daysAgo(entry: AuditEntry): number {
  if (entry.time.startsWith('Just now') || entry.time.startsWith('Today')) return 0;
  if (entry.time.startsWith('Yesterday')) return 1;
  const day = /^Nov (\d+)/.exec(entry.time)?.[1];
  return day ? AUDIT_TODAY - Number(day) : 365;
}

export function AuditPage() {
  const viewer = useViewer();
  const rowsAll = audit.use();
  const params = new URLSearchParams(window.location.search);
  const [actor, setActor] = useState(() => params.get('actor') ?? 'all');
  const [sponsor, setSponsor] = useState(() => params.get('sponsor') ?? 'all');
  const [kind, setKind] = useState<AuditKind | 'all'>('all');
  const [project, setProject] = useState('all');
  const [range, setRange] = useState('all');
  const [text, setText] = useState(() => params.get('q') ?? '');
  const [exporting, setExporting] = useState(false);
  const allBots = bots.use();
  const sponsors = USERS.filter((user) => allBots.some((bot) => bot.sponsor === user.id));
  const sponsorOf = (id: string): string | null => { const principal = findPrincipal(id); return principal?.kind === 'bot' ? principal.sponsor : null; };
  const isBot = (id: string): boolean => findPrincipal(id)?.kind === 'bot';
  const days = RANGES.find((entry) => entry.id === range)?.days ?? Infinity;
  const needle = text.trim().toLowerCase();
  const rows = rowsAll.filter((entry) => (actor === 'all' || (actor === 'any-bot' ? isBot(entry.actor) : actor === 'any-person' ? !isBot(entry.actor) : entry.actor === actor))
    && (sponsor === 'all' || sponsorOf(entry.actor) === sponsor) && (kind === 'all' || entry.kind === kind)
    && (project === 'all' || (project === 'none' ? !entry.project : entry.project === project)) && daysAgo(entry) <= days
    && (!needle || `${entry.text} ${actorLabel(entry.actor, entry.client)}`.toLowerCase().includes(needle)));
  const filters = [
    actor === 'all' ? null : actor === 'any-bot' ? 'any bot' : actor === 'any-person' ? 'any person' : actorLabel(actor),
    sponsor === 'all' ? null : `bots sponsored by ${USERS.find((user) => user.id === sponsor)?.first ?? sponsor}`,
    kind === 'all' ? null : KIND[kind].label, project === 'all' ? null : project === 'none' ? 'account-wide' : projectName(project),
    range === 'all' ? null : RANGES.find((entry) => entry.id === range)?.label ?? null, needle ? `“${text.trim()}”` : null,
  ].filter((entry) => entry !== null);
  const clear = (): void => { setActor('all'); setSponsor('all'); setKind('all'); setProject('all'); setRange('all'); setText(''); };
  return <Section title="Activity" scope="Team" description="Kept for a year. A person’s MCP client is recorded as that person, with the client named; a bot’s actions carry its sponsor at the time. Commits also carry attribution in Git: the turn starter as author, GitSpace as committer, other holders who prompted that turn as Co-authored-by, and a trailer linking the conversation."
    actions={<Button variant="secondary" leadingIcon={glyph(Download01)} onClick={() => setExporting(true)}>Export</Button>}>
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filters">
      <Select value={actor} onValueChange={setActor}><SelectTrigger aria-label="Person or bot" /><SelectContent>
        <SelectItem value="all" index={0}>Everyone and every bot</SelectItem>
        <SelectItem value="any-person" index={1}>Any person</SelectItem>
        <SelectItem value="any-bot" index={2}>Any bot</SelectItem>
        {USERS.map((user, index) => <SelectItem key={user.id} value={user.id} index={index + 3}>{user.name}</SelectItem>)}
        {allBots.map((bot, index) => <SelectItem key={bot.id} value={bot.id} index={USERS.length + index + 3}>{bot.name} · bot</SelectItem>)}
      </SelectContent></Select>
      <Select value={sponsor} onValueChange={setSponsor}><SelectTrigger aria-label="Sponsor" /><SelectContent>
        <SelectItem value="all" index={0}>Any sponsor</SelectItem>
        {sponsors.map((user, index) => <SelectItem key={user.id} value={user.id} index={index + 1}>Bots sponsored by {user.first}</SelectItem>)}
      </SelectContent></Select>
      <Select value={project} onValueChange={setProject}><SelectTrigger aria-label="Project" /><SelectContent>
        <SelectItem value="all" index={0}>Any project</SelectItem>
        <SelectItem value="none" index={1}>Account-wide (no project)</SelectItem>
        {ACTIVE_PROJECTS.map((entry, index) => <SelectItem key={entry.id} value={entry.id} index={index + 2}>{entry.name}</SelectItem>)}
      </SelectContent></Select>
      <Select value={range} onValueChange={setRange}><SelectTrigger aria-label="Date range" /><SelectContent>
        {RANGES.map((entry, index) => <SelectItem key={entry.id} value={entry.id} index={index}>{entry.label}</SelectItem>)}
      </SelectContent></Select>
      <InputGroup size="compact" className="w-64"><InputField index={0} label="Search the log" labelHidden icon={glyph(SearchMd)} placeholder="Search what happened" value={text} onChange={setText} /></InputGroup>
    </div>
    <div role="group" aria-label="Kind" className="flex flex-wrap gap-1.5">
      {KINDS.map((entry) => <Button key={entry} size="compact" variant={kind === entry ? 'secondary' : 'ghost'} aria-pressed={kind === entry} onClick={() => setKind(entry)}>{entry === 'all' ? 'All' : KIND[entry].label}</Button>)}
    </div>
    <div className="flex flex-wrap items-center gap-2 text-caption text-muted-foreground" data-audit-count="">
      <span>Showing {rows.length} of {rowsAll.length}{filters.length ? ` · ${filters.join(' · ')}` : ''}</span>
      {filters.length ? <Button size="compact" variant="ghost" onClick={clear}>Clear filters</Button> : null}
    </div>
    {rows.length ? <SettingRows label="Audit log">{rows.map((entry) => <SettingRow key={entry.time + entry.text}
      title={<span data-audit-actor={entry.actor} className="inline-flex flex-wrap items-center gap-2"><UserName userId={entry.actor} you={viewer.id} client={entry.client} />{isBot(entry.actor) ? <Pill tone="violet">Bot</Pill> : null}{entry.client ? <Pill tone="blue">MCP</Pill> : null}<Pill tone={KIND[entry.kind].tone}>{KIND[entry.kind].label}</Pill>{entry.project ? <Pill>{projectName(entry.project)}</Pill> : null}</span>}
      description={entry.text}>
      <span className="text-caption tabular-nums text-muted-foreground">{entry.time}</span>
    </SettingRow>)}</SettingRows> : <Note>Nothing matches. Clear a filter or widen the date range.</Note>}
    {exporting ? <ExportAuditFlow filtered={rows} all={rowsAll} filters={filters.join(' · ') || 'no filters'} onClose={() => setExporting(false)} /> : null}
  </Section>;
}
