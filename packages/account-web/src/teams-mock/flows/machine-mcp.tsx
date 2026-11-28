// MCP servers hosted on machines, everywhere they show: the "Hosted on machines" section of You › Plugins and Crumb & Co ›
// Plugins (connection rows with Start/Stop and Remove, and the Add MCP server wizard), the toggle in a project's
// settings › Plugins, the block in each live Machines panel, the sessions panel on Sessions, and the workspace's
// Environment popover. A server whose machine is offline stays listed with its tools, marked "Unavailable: <machine> is
// offline". Credentials stay on the machine: rows name where each variable comes from and never show a value.
import { glyph } from '../../glyph.js';
import { Button, InputField, InputGroup, Select, SelectContent, SelectItem, SelectTrigger, Switch, ThinkingIndicator } from '@gitspace/ui';
import { Check, Cloud01, Container, Dataflow03, Laptop01, Lock01, Plus, Server01, Tool01 } from '@untitledui/icons';
import { useEffect, useRef, useState } from 'react';
import { principalOf, WORKSPACES, type Principal } from '../data.js';
import { MACHINE_LIVE } from '../live/data.js';
import { Panel, PanelGrid, Stat } from '../live/parts.js';
import { listNames } from '../scoped/common.js';
import { revokeIn, revokeOnly, whose, type ScopeInfo } from '../scope.js';
import { ACCOUNT_NAME, ACTIVE_PROJECTS, MACHINE_KIND_LABEL, MACHINES, projectName, projectSettings, recordAudit, revoked, type Machine, type MachineKind, type SecretEntry } from '../settings/data.js';
import { Act, Note, Pill, Section, SettingRow, SettingRows, UserName } from '../settings/parts.js';
import { why, whyAccount } from '../settings/roles.js';
import { useMock, useViewer } from '../viewer.js';
import { defaultRule, secretRules, type SecretRule } from './env-model.js';
import { ChipPicker, ChoiceCards, FlowDialog, FlowError, FlowSuccess, Hint, StepButtons, Summary, type FlowIcon } from './kit.js';
import { MACHINE_PATH, MACHINE_STORE, machineLabel, machineMcpServers, machineOnline, relayNote, serversFor, startLine, unavailable, type MachineMcpServer, type McpEnv, type McpStart, type McpTool } from './machine-mcp-data.js';
import { ENV_NAME, secrets } from './team-data.js';
import { addedMachines } from './you-data.js';

const MACHINE_ICON: Readonly<Record<MachineKind, FlowIcon>> = { container: Container, vm: Cloud01, computer: Laptop01 };

/** A machine's connection: its live heartbeat, or for one added in this session (no heartbeat yet) its state. */
function isOnline(machine: Machine): boolean {
  return MACHINE_LIVE[machine.id] ? machineOnline(machine.id) : machine.state === 'online';
}
/** A server's state as rows show it: unavailable while its machine is offline, else running or stopped. */
function StatePill({ server }: { server: MachineMcpServer }) {
  if (unavailable(server)) return <Pill tone="amber">Unavailable</Pill>;
  return server.state === 'running' ? <Pill tone="green">Running</Pill> : <Pill>Stopped</Pill>;
}

/** Where each environment variable comes from; values are never shown. */
function envLine(server: MachineMcpServer): string {
  const label = machineLabel(server.machineId);
  if (!server.env.length) return `Credentials stay on ${label}: it needs no environment from GitSpace`;
  const fromMachine = server.env.filter((entry) => entry.from === 'machine').map((entry) => entry.name);
  const fromGitSpace = server.env.filter((entry) => entry.from === 'gitspace').map((entry) => entry.secret ?? entry.name);
  return [`Credentials stay on ${label}`, fromMachine.length ? `${fromMachine.join(', ')} from its own store` : '', fromGitSpace.length ? `${fromGitSpace.join(', ')} from GitSpace secrets, handed to the process at start` : '', 'values never shown'].filter(Boolean).join(' · ');
}

/** The server's tools as chips; while its machine is offline they stay listed, dimmed, under the reason. */
function ToolChips({ server }: { server: MachineMcpServer }) {
  const reason = unavailable(server);
  return <div data-machine-mcp-tools={server.id} className="mt-1 flex flex-col gap-1">
    {reason ? <span className="text-caption font-medium text-[#b54708]">{reason} · its {server.tools.length} tools stay listed</span> : null}
    <span className={`flex flex-wrap gap-1 ${reason ? 'opacity-60' : ''}`}>{server.tools.map((tool) => <span key={tool.name} title={tool.description} className="rounded-md bg-muted px-1.5 py-px font-mono text-[11px] text-muted-foreground">{tool.name}</span>)}</span>
  </div>;
}

/** A tool list with descriptions: the wizard's test result. */
function ToolList({ tools }: { tools: readonly McpTool[] }) {
  return <ul data-tool-list="" className="flex flex-col divide-y divide-border rounded-xl shadow-[inset_0_0_0_1px_var(--border)]">
    {tools.map((tool) => <li key={tool.name} className="flex min-w-0 items-baseline gap-3 px-3 py-1.5"><span className="shrink-0 font-mono text-caption text-foreground">{tool.name}</span><span className="min-w-0 truncate text-caption text-muted-foreground">{tool.description}</span></li>)}
  </ul>;
}

// ── Plugins: Hosted on machines ──────────────────────────────────────────────────────────────────────────────────────

type RowFlow = { kind: 'add' } | { kind: 'remove'; server: MachineMcpServer };

/** Plugins › Custom MCP › Hosted on machines: the team's servers on team machines, or the person's on their own. */
export function MachineMcpSection({ info }: { info: ScopeInfo }) {
  const viewer = useViewer();
  const { say } = useMock();
  const gone = revoked.use();
  const all = machineMcpServers.use();
  const settings = projectSettings.use();
  const [flow, setFlow] = useState<RowFlow | null>(null);
  const team = info.access === 'team-edit' || info.access === 'team-read';
  const edit = info.access === 'team-read' ? info.teamReason : null;
  const person = info.target;
  const own = info.access === 'own';
  const bot = person?.kind === 'bot' ? person : null;
  const added = addedMachines.use();
  const list = all.filter((server) => !gone.has(server.id) && (team ? server.scope.kind === 'team' : server.scope.kind === 'personal' && server.scope.userId === person?.id));
  const botMachines = bot ? [...MACHINES, ...added].filter((machine) => !gone.has(machine.id) && machine.owner.scope === 'user' && machine.owner.userId === bot.id) : [];
  const addReason = team ? edit : bot && !botMachines.length ? `${bot.name} has no machines yet: add one on its Machines page` : revokeOnly(info, viewer);
  const close = () => setFlow(null);
  const setState = (server: MachineMcpServer, state: MachineMcpServer['state']): void => {
    machineMcpServers.set(machineMcpServers.get().map((entry) => entry.id === server.id ? { ...entry, state, callsLastHour: state === 'stopped' ? 0 : entry.callsLastHour, sessions: state === 'stopped' ? [] : entry.sessions } : entry));
    if (team) recordAudit({ actor: viewer.id, kind: 'resource', text: `${state === 'running' ? 'Started' : 'Stopped'} the team MCP server ${server.name} on ${machineLabel(server.machineId)}` });
    say(`${server.name} ${state === 'running' ? 'started' : 'stopped'} on ${machineLabel(server.machineId)}`);
  };
  const remove = (server: MachineMcpServer): void => {
    if (!team && !own) { revokeIn(info, viewer, server.id, `MCP server ${server.name} on ${machineLabel(server.machineId)}`, 'removed', say); return; }
    machineMcpServers.set(machineMcpServers.get().filter((entry) => entry.id !== server.id));
    if (team) recordAudit({ actor: viewer.id, kind: 'setting', text: `Removed the team MCP server ${server.name} from ${machineLabel(server.machineId)}${server.projects.length ? ` · it was on in ${listNames(server.projects)}` : ''}` });
    say(`${server.name} removed`);
  };
  const onIn = (server: MachineMcpServer): readonly string[] => server.projects.filter((id) => settings[id] !== undefined);
  return <Section title={`Hosted on machines · ${team ? 'Team' : own ? 'You' : person?.first}`} scope={team ? 'Team' : 'You'} readOnly={edit}
    description={team ? `MCP servers that run on ${ACCOUNT_NAME}’s machines. Projects turn each on in their settings › Plugins; each person uses it within their role there. Credentials stay on the machine; workspaces on any machine call it through the relay.`
      : `MCP servers that run on ${own ? 'your' : `${person?.first}’s`} own machines. Only ${own ? 'your' : `${person?.first}’s`} workspaces and agents use them. Credentials stay on the machine; workspaces on any machine call it through the relay.`}
    actions={<Act reason={addReason} variant="secondary" leadingIcon={glyph(Plus)} onClick={() => setFlow({ kind: 'add' })}>Add MCP server</Act>}>
    {list.length ? <SettingRows label="Hosted on machines">{list.map((server) => {
      const offline = unavailable(server);
      const manage = offline ? `${machineLabel(server.machineId)} is offline` : team ? edit : own || bot ? null : `Only ${person?.first} starts and stops servers on their machine`;
      const reach = server.scope.kind === 'team' ? (onIn(server).length ? `On in ${listNames(onIn(server))} (project settings) · each person within their role` : 'On in no project yet') : `Only ${own ? 'your' : `${person?.first}’s`} workspaces and agents`;
      return <SettingRow key={server.id} media={glyph(Server01)}
        title={<span data-machine-mcp={server.id} className="inline-flex flex-wrap items-center gap-2">{server.name}<Pill tone="blue">on {machineLabel(server.machineId)}</Pill><StatePill server={server} /></span>}
        description={<><span className="font-mono text-[12px]">{startLine(server.start)}</span> · {server.tools.length} tools · {server.callsLastHour} calls in the last hour · added {server.added}</>}
        extra={<div className="mt-1 flex flex-col gap-0.5 text-caption">
          <span className="text-foreground">{reach}</span>
          <span data-machine-mcp-credentials={server.id} className="inline-flex items-start gap-1 text-muted-foreground"><Lock01 width={13} height={13} strokeWidth={1.75} className="mt-0.5 shrink-0" />{envLine(server)}</span>
          <span data-relay-note={server.id} className="inline-flex items-center gap-1 text-muted-foreground"><Dataflow03 width={13} height={13} strokeWidth={1.75} className="shrink-0" />Workspaces on any machine: {relayNote(server)}</span>
          <ToolChips server={server} />
        </div>}>
        <Act reason={manage} variant="ghost" aria-label={`${server.state === 'running' ? 'Stop' : 'Start'} ${server.name}`} onClick={() => setState(server, server.state === 'running' ? 'stopped' : 'running')}>{server.state === 'running' ? 'Stop' : 'Start'}</Act>
        <Act reason={team ? edit : null} variant="ghost" aria-label={`Remove ${server.name}`} onClick={() => setFlow({ kind: 'remove', server })}>Remove</Act>
      </SettingRow>;
    })}</SettingRows> : <Note>{team ? 'No servers on team machines yet.' : `${own ? 'You haven’t' : `${person?.first} hasn’t`} added a server on ${own ? 'your' : bot ? 'its' : 'their'} machines.`}</Note>}
    {flow?.kind === 'add' ? <AddMachineMcpFlow start={team ? 'team' : 'personal'} principal={bot ?? undefined} onClose={close} /> : null}
    {flow?.kind === 'remove' ? <RemoveFlow server={flow.server} who={whose(info)} team={team} own={own} onConfirm={() => remove(flow.server)} onClose={close} /> : null}
  </Section>;
}

function RemoveFlow({ server, who, team, own, onConfirm, onClose }: { server: MachineMcpServer; who: string; team: boolean; own: boolean; onConfirm(): void; onClose(): void }) {
  const [done, setDone] = useState(false);
  return <FlowDialog id="remove-machine-mcp" title={done ? `${server.name} removed` : `Remove ${server.name}?`} done={done} wide={false} onClose={onClose}
    footer={done ? <Button variant="primary" onClick={onClose}>Done</Button> : <><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={() => { onConfirm(); setDone(true); }}>Remove</Button></>}>
    {done ? <FlowSuccess title={`${server.name} removed`}>{team ? 'Gone from every project; in the audit log.' : own ? 'Add it again any time.' : 'They’re told in their Inbox; in the audit log.'}</FlowSuccess>
      : <Hint>GitSpace stops it on {machineLabel(server.machineId)} and its {server.tools.length} tools leave {team ? `the workspaces of ${server.projects.length ? listNames(server.projects) : 'no project'}` : `${who} workspaces`} at their next turn. The machine’s own store keeps its values.</Hint>}
  </FlowDialog>;
}

// ── The wizard ───────────────────────────────────────────────────────────────────────────────────────────────────────

const STEPS = ['Where it runs', 'How it starts', 'Test', 'Who can use it'] as const;
type TestResult = { kind: 'ok'; tools: readonly McpTool[] } | { kind: 'not-found'; command: string } | { kind: 'exited'; code: number; stderr: readonly string[] } | { kind: 'offline'; heartbeat: string };

/** What known servers answer to tools/list; any other server lists its resources. */
const TOOL_CATALOG: ReadonlyArray<{ match: string; tools: readonly McpTool[] }> = [
  { match: 'ios-simulator-mcp', tools: [{ name: 'boot_simulator', description: 'Boot an iOS simulator by name' }, { name: 'install_app', description: 'Install a built .app on the booted simulator' }, { name: 'tap', description: 'Tap at a point on the screen' }, { name: 'screenshot', description: 'A PNG of the simulator’s screen' }, { name: 'record_video', description: 'Record the screen until stopped' }] },
  { match: 'label-printer-mcp', tools: [{ name: 'print_label', description: 'Print a product label (name, allergens, best before)' }, { name: 'list_templates', description: 'Label templates on the printer' }, { name: 'printer_status', description: 'Tape, cover and connection' }] },
];
function toolsFor(name: string, start: McpStart): readonly McpTool[] {
  const line = startLine(start);
  return TOOL_CATALOG.find((entry) => line.includes(entry.match))?.tools ?? [{ name: 'list_resources', description: `Resources ${name} offers` }, { name: 'read_resource', description: 'Read one resource by its URI' }];
}

/** Why a GitSpace secret can't feed this server, under its rule; null when it can. */
function secretRefusal(entry: SecretEntry, team: boolean, userId: string, rules: Readonly<Record<string, SecretRule>>): string | null {
  if (team && entry.scope !== 'team') return 'Your own secrets go only to servers on your own machines';
  if (!team && entry.scope !== userId) return 'Team secrets go only to servers on team machines';
  const rule = rules[`${entry.scope}:${entry.name}`] ?? defaultRule(entry.scope);
  if (rule.delivery.kind === 'scripts' || rule.delivery.kind === 'sponsor') return `${entry.name}’s rule hands it only to approved scripts. Change its rule in ${team ? 'Secrets' : 'You › My secrets'}, or keep the value in the machine’s own store`;
  if (rule.delivery.kind === 'autofill') return `${entry.name}’s rule has only the browser fill it on ${rule.delivery.origins.join(', ')} (and approved scripts get it): a server never sees it. Change its rule in ${team ? 'Secrets' : 'You › My secrets'}, or keep the value in the machine’s own store`;
  if (team && rule.whileHolding) return `${entry.name}’s rule gives it only while someone holds the workspace’s handle, and a team server has no holder: it runs for every project that turns it on`;
  return null;
}

/** Add an MCP server that runs on a machine (a team machine, one of the viewer's own, or with `principal` one of a bot's
 * own): where it runs, how it starts (and the environment it needs), a test that starts it and lists its tools, then
 * who can use it. */
export function AddMachineMcpFlow({ start: startScope, principal, onClose }: { start: 'personal' | 'team'; principal?: Principal; onClose(): void }) {
  const viewer = useViewer();
  const { say } = useMock();
  const gone = revoked.use();
  const rules = secretRules.use();
  const allSecrets = secrets.use();
  const existing = machineMcpServers.use();
  const who = principal ?? viewer;
  const bot = who.kind === 'bot';
  const teamReason = whyAccount(viewer.id, 'account.connections') ? 'Only Owners and Admins add a server to a team machine' : null;
  const machines = [...MACHINES, ...addedMachines.get()].filter((machine) => !gone.has(machine.id) && (bot ? machine.owner.scope === 'user' && machine.owner.userId === who.id : machine.owner.scope === 'account' || machine.owner.userId === who.id));
  const pickable = (machine: Machine): boolean => machine.owner.scope === 'user' || teamReason === null;
  const firstOf = (team: boolean): string => machines.find((machine) => pickable(machine) && (machine.owner.scope === 'account') === team && isOnline(machine))?.id ?? '';
  const [machineId, setMachineId] = useState(() => firstOf(startScope === 'team') || firstOf(startScope !== 'team'));
  const machine = machines.find((entry) => entry.id === machineId);
  const team = machine?.owner.scope === 'account';
  const label = machine?.label ?? machineLabel(machineId);
  const [step, setStep] = useState(0);
  const [done, setDone] = useState(false);
  const [name, setName] = useState(startScope === 'team' ? 'label-printer MCP' : 'ios-simulator MCP');
  const [kind, setKind] = useState<McpStart['kind']>('command');
  const [command, setCommand] = useState(startScope === 'team' ? 'uvx' : 'npx');
  const [args, setArgs] = useState(startScope === 'team' ? 'label-printer-mcp --printer QL-820NWB' : '-y ios-simulator-mcp');
  const [url, setUrl] = useState('http://127.0.0.1:8931/mcp');
  const [env, setEnv] = useState<readonly McpEnv[]>(startScope === 'team' ? [{ name: 'PRINTER_TOKEN', from: 'machine' }] : [{ name: 'APPLE_TEAM_ID', from: 'machine' }]);
  const [tried, setTried] = useState(false);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);
  const [projects, setProjects] = useState<ReadonlySet<string>>(new Set(['crumb']));
  const timer = useRef<number | null>(null);
  useEffect(() => () => { if (timer.current !== null) window.clearTimeout(timer.current); }, []);
  const start: McpStart = kind === 'command' ? { kind, command: command.trim(), args: args.trim() ? args.trim().split(/\s+/) : [] } : { kind, url: url.trim() };
  const store = MACHINE_STORE[machineId] ?? [];
  const secretChoices = allSecrets.filter((entry) => entry.scope === 'team' || entry.scope === who.id);
  const refusalOf = (secretName: string | undefined): string | null => {
    const entry = secretChoices.find((candidate) => candidate.name === secretName);
    return entry ? secretRefusal(entry, team, who.id, rules) : null;
  };
  const errors = {
    name: !name.trim() ? 'Name it: people pick it by this name in project settings and the tool list' : existing.some((server) => server.machineId === machineId && server.name === name.trim()) ? `${label} already hosts ${name.trim()}` : null,
    command: kind === 'command' && !command.trim() ? 'Enter the program to run, like npx or uvx' : null,
    url: kind === 'url' && !/^http:\/\/(127\.0\.0\.1|localhost):[0-9]{2,5}(\/\S*)?$/.test(url.trim()) ? `A local URL on ${label}, like http://127.0.0.1:8931/mcp. The relay reaches it from inside the machine, so it never needs a public address` : null,
    env: env.map((entry) => !ENV_NAME.test(entry.name) ? 'Use capitals, digits and underscores, starting with a letter' : entry.from === 'gitspace' && !entry.secret ? 'Pick the secret' : entry.from === 'gitspace' ? refusalOf(entry.secret) : null),
  };
  const formOk = !errors.name && !errors.command && !errors.url && errors.env.every((error) => error === null);
  const setRow = (index: number, next: McpEnv): void => { setEnv(env.map((entry, at) => at === index ? next : entry)); setResult(null); };
  const runTest = (): void => {
    setResult(null); setTesting(true);
    timer.current = window.setTimeout(() => {
      setTesting(false);
      if (!machine || !isOnline(machine)) { setResult({ kind: 'offline', heartbeat: MACHINE_LIVE[machineId]?.heartbeat ?? 'unknown' }); return; }
      if (start.kind === 'command' && !MACHINE_PATH.includes(start.command)) { setResult({ kind: 'not-found', command: start.command }); return; }
      const missing = env.find((entry) => entry.from === 'machine' && !store.includes(entry.name));
      if (missing) {
        setResult({ kind: 'exited', code: 1, stderr: [`$ ${startLine(start)}`, `[${name.trim()}] reading configuration`, `Error: ${missing.name} is not set`, '    at loadConfig (config.js:14:11)', '    at main (index.js:6:3)', 'process exited with code 1 after 0.4 s'] });
        return;
      }
      setResult({ kind: 'ok', tools: toolsFor(name.trim(), start) });
    }, 1300);
  };
  const next = (): void => {
    if (step === 1) { setTried(true); if (!formOk) return; }
    if (step < 3) { setStep(step + 1); return; }
    if (result?.kind !== 'ok') return;
    const server: MachineMcpServer = { id: `mcp-${Date.now().toString(36)}`, name: name.trim(), machineId, scope: team ? { kind: 'team' } : { kind: 'personal', userId: who.id }, start, env, tools: result.tools,
      state: 'running', callsLastHour: 0, sessions: [], projects: team ? [...projects] : [], added: team ? `just now by ${viewer.first}` : 'just now' };
    machineMcpServers.set([...machineMcpServers.get(), server]);
    if (team) recordAudit({ actor: viewer.id, kind: 'setting', text: `Added the team MCP server ${server.name} on ${label}${projects.size ? ` · on in ${listNames([...projects])}` : ''}` });
    if (bot) recordAudit({ actor: viewer.id, kind: 'bot', text: `Added the MCP server ${server.name} on ${label} for ${who.name}` });
    say(`${server.name} added on ${label}`);
    setDone(true);
  };
  const choices = machines.map((entry) => {
    const online = isOnline(entry);
    const hosted = existing.filter((server) => server.machineId === entry.id).length;
    return { id: entry.id, title: entry.label, icon: MACHINE_ICON[entry.kind], disabled: pickable(entry) ? null : teamReason,
      badge: <>{entry.owner.scope === 'account' ? <Pill>Team</Pill> : <Pill tone="violet">{bot ? `${who.first}’s` : 'Yours'}</Pill>}{online ? null : <Pill tone="amber">Offline</Pill>}</>,
      detail: `${MACHINE_KIND_LABEL[entry.kind]} · ${online ? 'online' : `offline · last heartbeat ${MACHINE_LIVE[entry.id]?.heartbeat ?? 'unknown'}`}${hosted ? ` · hosts ${hosted} ${hosted === 1 ? 'server' : 'servers'}` : ''}` };
  });
  const own = machines.filter((entry) => entry.owner.scope === 'user');
  return <FlowDialog id="machine-mcp" title={done ? `${name.trim()} runs on ${label}` : 'Add an MCP server on a machine'} steps={STEPS} step={step} done={done} onClose={onClose}
    description={done ? undefined : 'The server runs on one of the machines; workspaces on any machine call it through the relay. Its credentials stay on that machine.'}
    footer={done ? <Button variant="primary" onClick={onClose}>Done</Button> : <StepButtons step={step} onBack={() => setStep(step - 1)} onCancel={onClose} next={next} nextLabel={step === 3 ? 'Add server' : 'Continue'}
      disabled={step === 0 ? !machine || !pickable(machine) : step === 2 ? result?.kind !== 'ok' : false} busy={testing} />}>
    {done ? <FlowSuccess title={`${name.trim()} is running on ${label}`}>
      {team ? (projects.size ? `On in ${listNames([...projects])}: workspaces there get its ${result?.kind === 'ok' ? result.tools.length : 0} tools at their next turn, each person within their role.` : 'On in no project yet: Leads turn it on in their project settings › Plugins.') : bot ? `Only workspaces ${who.first} holds use it.` : 'Only your workspaces and agents use it.'} Credentials stay on {label}; calls go through the relay to {label}.{team || bot ? ' In the audit log.' : ''}
    </FlowSuccess> : null}
    {!done && step === 0 ? <>
      <ChoiceCards label="Machine" value={machineId} onChange={(id) => { setMachineId(id); setResult(null); }} choices={choices} />
      {own.length ? null : <Hint>{bot ? `${who.name} has no machines yet: add one on its Machines page.` : 'You have no machines of your own yet: add one under You › Machines.'}</Hint>}
      {teamReason ? <Hint>Team machines are listed but closed to you: only Owners and Admins add a server to them. A Member adds servers on their own machines, for their own workspaces.</Hint>
        : <Hint>{bot ? `On one of ${who.name}’s machines it’s ${who.first}’s alone, for workspaces it holds.` : 'On one of your machines it’s yours alone; on a team machine projects turn it on, and each person uses it within their role.'}</Hint>}
    </> : null}
    {!done && step === 1 ? <>
      <InputGroup><InputField index={0} label="Name" value={name} onChange={(value) => setName(value)} error={tried ? errors.name ?? undefined : undefined} /></InputGroup>
      <ChoiceCards label="How it starts" columns={2} value={kind} onChange={(id) => { if (id === 'command' || id === 'url') { setKind(id); setResult(null); } }} choices={[
        { id: 'command', title: 'Run a command', detail: `GitSpace starts it on ${label} and talks to it over stdio`, icon: Tool01 },
        { id: 'url', title: 'A local URL', detail: `It already listens on ${label}; GitSpace connects over HTTP from inside the machine`, icon: Dataflow03 },
      ]} />
      {kind === 'command' ? <InputGroup>
        <InputField index={1} label="Command" value={command} onChange={(value) => { setCommand(value); setResult(null); }} placeholder="npx" error={tried ? errors.command ?? undefined : undefined} />
        <InputField index={2} label="Arguments" value={args} onChange={(value) => { setArgs(value); setResult(null); }} placeholder="-y some-mcp-server --flag" />
      </InputGroup> : <InputGroup><InputField index={1} label="Local URL" value={url} onChange={(value) => { setUrl(value); setResult(null); }} error={tried ? errors.url ?? undefined : undefined} /></InputGroup>}
      <div className="flex flex-col gap-2">
        <span className="text-caption font-medium text-foreground">Environment</span>
        {env.map((entry, index) => <div key={index} data-env-row={index} className="flex flex-col gap-1.5 rounded-xl px-3 py-2 shadow-[inset_0_0_0_1px_var(--border)]">
          <div className="flex items-end gap-2">
            <InputGroup className="min-w-0 flex-1"><InputField index={3 + index} label={`Variable ${index + 1}`} value={entry.name} onChange={(value) => setRow(index, { ...entry, name: value.trim() })} /></InputGroup>
            <Select value={entry.from} onValueChange={(value) => { if (value === 'machine') setRow(index, { name: entry.name, from: 'machine' }); if (value === 'gitspace') setRow(index, { name: entry.name, from: 'gitspace' }); }}>
              <SelectTrigger aria-label={`Source of variable ${index + 1}`} />
              <SelectContent><SelectItem value="machine" index={0}>Machine’s own store</SelectItem><SelectItem value="gitspace" index={1}>GitSpace secret</SelectItem></SelectContent>
            </Select>
            <Button variant="ghost" size="compact" className="shrink-0" aria-label={`Remove variable ${index + 1}`} onClick={() => { setEnv(env.filter((_, at) => at !== index)); setResult(null); }}>Remove</Button>
          </div>
          {entry.from === 'gitspace' ? <div className="self-start"><Select value={entry.secret ?? ''} onValueChange={(value) => setRow(index, { ...entry, secret: value })}>
            <SelectTrigger aria-label={`Secret for variable ${index + 1}`} />
            <SelectContent>{secretChoices.map((secret, at) => <SelectItem key={secret.id} value={secret.name} index={at}>{`${secret.name} · ${secret.scope === 'team' ? 'team' : 'yours'}`}</SelectItem>)}</SelectContent>
          </Select></div> : null}
          {tried && errors.env[index] ? <FlowError>{errors.env[index]}</FlowError>
            : entry.from === 'machine' ? <Hint>{store.includes(entry.name) ? `In ${label}’s store: the value stays on the machine and GitSpace never sees it.` : `Not in ${label}’s store yet: set it there with gitspace machine secret set ${entry.name || 'NAME'}. The value never leaves the machine.`}</Hint>
              : entry.secret ? <Hint>{refusalOf(entry.secret) ?? `GitSpace hands ${entry.secret} to the process when it starts, under its rule; the value is never shown here or to agents.`}</Hint> : null}
        </div>)}
        <div><Button variant="secondary" size="compact" leadingIcon={glyph(Plus)} onClick={() => { setEnv([...env, { name: '', from: 'machine' }]); setResult(null); }}>Add variable</Button></div>
        <Hint>{`${label}’s own store has ${store.length ? store.join(', ') : 'nothing yet'}. GitSpace secrets follow their rules: ${team ? 'a team server takes team secrets that aren’t limited to approved scripts or to holders' : 'a personal server takes your own secrets that aren’t limited to approved scripts'}.`}</Hint>
      </div>
    </> : null}
    {!done && step === 2 ? <>
      <Summary rows={[['Machine', `${label}${team ? ' · team' : bot ? ` · ${who.first}’s` : ' · yours'}`], ['Starts', <span key="start" className="font-mono text-[12px]">{startLine(start)}</span>], ['Environment', env.length ? env.map((entry) => `${entry.name} (${entry.from === 'machine' ? 'machine store' : `GitSpace · ${entry.secret ?? ''}`})`).join(', ') : 'None']]} />
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" loading={testing} disabled={testing} onClick={runTest}>{result ? 'Test again' : 'Start it and list its tools'}</Button>
        {testing ? <span className="inline-flex items-center gap-2 text-caption text-muted-foreground"><ThinkingIndicator />Starting on {label}…</span> : null}
      </div>
      {result?.kind === 'offline' ? <FlowError>{label} is offline (last heartbeat {result.heartbeat}), so nothing started. {machine?.kind === 'computer' ? 'Wake it or open GitSpace on it,' : 'Start it from Machines,'} then test again, or go Back and pick a machine that’s online.</FlowError> : null}
      {result?.kind === 'not-found' ? <FlowError>Command not found: {result.command} isn’t on {label}’s PATH. Install it there, or use one it has: {MACHINE_PATH.join(', ')}. Then test again.</FlowError> : null}
      {result?.kind === 'exited' ? <div data-stderr="" className="flex flex-col gap-1.5">
        <FlowError>It exited at start with code {result.code}. The end of its stderr:</FlowError>
        <pre className="overflow-x-auto rounded-xl bg-surface-2 px-3 py-2 font-mono text-[11.5px] leading-relaxed text-foreground shadow-[inset_0_0_0_1px_var(--border)]">{result.stderr.join('\n')}</pre>
        <Hint>Set the missing value in {label}’s store (gitspace machine secret set NAME on the machine), or go Back and take it from a GitSpace secret. Then test again.</Hint>
      </div> : null}
      {result?.kind === 'ok' ? <div className="flex flex-col gap-2">
        <p role="status" className="flex items-center gap-2 text-caption text-foreground"><Check width={14} height={14} className="text-[#079455]" />Started on {label} in 0.8 s · MCP 2025-06-18 · {result.tools.length} tools</p>
        <ToolList tools={result.tools} />
      </div> : null}
    </> : null}
    {!done && step === 3 ? <>
      {team ? <>
        <span className="text-caption font-medium text-foreground">On in projects</span>
        <ChipPicker label="Projects" options={ACTIVE_PROJECTS.map((project) => ({ id: project.id, label: project.name }))} picked={projects} onChange={setProjects} />
        <Hint>{projects.size ? `Turned on in ${listNames([...projects])}’s settings › Plugins, which ${projects.size === 1 ? 'its' : 'their'} Leads can change.` : 'None yet: a project’s Leads turn it on in its settings › Plugins.'} Each person uses its tools within their role in the project.</Hint>
      </> : <Hint>{bot ? `Only ${who.name}: the workspaces it holds and its turns there, in projects that allow holders’ own plugins. Nobody else’s turns call it.` : 'Only you: the workspaces you hold and your agents’ turns there, in projects that allow holders’ own plugins. Nobody else’s turns call it.'}</Hint>}
      <Summary rows={[['Server', name.trim()], ['Runs on', `${label} (${team ? 'team' : bot ? `${who.first}’s` : 'yours'})`], ['Starts', startLine(start)], ['Credentials', `Stay on ${label}`], ['Reach', `Calls go through the relay to ${label}`], ['Who', team ? (projects.size ? `Projects: ${listNames([...projects])}` : 'No project yet') : bot ? `Only ${who.name}` : 'Only you']]} />
    </> : null}
  </FlowDialog>;
}

// ── Project settings › Plugins ──────────────────────────────────────────────────────────────────────────────────────

/** The team's machine-hosted servers, each turned on or off in this project. */
export function ProjectMachineMcp({ project }: { project: string }) {
  const viewer = useViewer();
  const gone = revoked.use();
  const list = machineMcpServers.use().filter((server) => server.scope.kind === 'team' && !gone.has(server.id));
  const [toggling, setToggling] = useState<MachineMcpServer | null>(null);
  const edit = why(viewer.id, project, 'project.settings');
  return <Section title="Hosted on machines" scope="Project" readOnly={edit} description={`${ACCOUNT_NAME}’s MCP servers that run on team machines. Turned on here, each person in ${projectName(project)} uses its tools within their role; calls go through the relay to its machine.`}>
    {list.length ? <SettingRows label="Hosted on machines">{list.map((server) => {
      const on = server.projects.includes(project);
      return <SettingRow key={server.id} media={glyph(Server01)} title={<span data-project-machine-mcp={server.id} className="inline-flex flex-wrap items-center gap-2">{server.name}<Pill tone="blue">on {machineLabel(server.machineId)}</Pill><StatePill server={server} /></span>}
        description={<>{server.tools.length} tools · {relayNote(server)}</>} extra={<ToolChips server={server} />}>
        <Switch label={`${server.name} on in ${projectName(project)}`} checked={on} disabled={edit !== null} onToggle={() => setToggling(server)} />
      </SettingRow>;
    })}</SettingRows> : <Note>No servers on team machines.</Note>}
    {toggling ? <MachineMcpToggleDialog project={project} server={toggling} onClose={() => setToggling(null)} /> : null}
  </Section>;
}

function MachineMcpToggleDialog({ project, server, onClose }: { project: string; server: MachineMcpServer; onClose(): void }) {
  const viewer = useViewer();
  const { say } = useMock();
  const [done, setDone] = useState(false);
  const [on] = useState(server.projects.includes(project));
  const name = projectName(project);
  const offline = unavailable(server);
  const confirm = (): void => {
    machineMcpServers.set(machineMcpServers.get().map((entry) => entry.id === server.id ? { ...entry, projects: on ? entry.projects.filter((id) => id !== project) : [...entry.projects, project] } : entry));
    recordAudit({ actor: viewer.id, kind: 'setting', project, text: `Turned ${server.name} (on ${machineLabel(server.machineId)}) ${on ? 'off' : 'on'} in ${name}` });
    say(`${server.name} ${on ? 'off' : 'on'} in ${name}`);
    setDone(true);
  };
  return <FlowDialog id="machine-mcp-toggle" title={`Turn ${server.name} ${on ? 'off' : 'on'} in ${name}?`} done={done} wide={false} onClose={onClose}
    footer={done ? <Button variant="primary" onClick={onClose}>Done</Button> : <><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={confirm}>Turn {on ? 'off' : 'on'}</Button></>}>
    {done ? <FlowSuccess title={`${server.name} is ${on ? 'off' : 'on'} in ${name}`}>Recorded in the audit log under {viewer.first}.</FlowSuccess> : <>
      <Hint>{on ? `Its ${server.tools.length} tools leave ${name}’s workspaces at their next turn.` : `Its ${server.tools.length} tools join ${name}’s workspaces at their next turn; each person uses them within their role in ${name}. Calls go through the relay to ${machineLabel(server.machineId)}; its credentials stay there.`}</Hint>
      {offline && !on ? <Hint>{offline} now: its tools show in the tool list as unavailable until it’s back.</Hint> : null}
    </>}
  </FlowDialog>;
}

// ── Live: Machines and Sessions ─────────────────────────────────────────────────────────────────────────────────────

/** A live Machines panel's block: the servers the machine hosts, running, stopped or unavailable, with calls in the last hour. */
export function MachineMcpBlock({ machineId }: { machineId: string }) {
  const gone = revoked.use();
  const list = machineMcpServers.use().filter((server) => server.machineId === machineId && !gone.has(server.id));
  if (!list.length) return null;
  return <div data-machine-mcp-block={machineId} className="flex flex-col gap-1">
    <span className="text-caption font-medium text-foreground">MCP servers: {list.length}</span>
    {list.map((server) => <span key={server.id} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-caption">
      <span className="font-mono text-foreground">{server.name}</span><StatePill server={server} />
      <span className="text-muted-foreground">{unavailable(server) ? `${server.tools.length} tools listed · no calls while offline` : `${server.callsLastHour} calls in the last hour · ${server.sessions.length} ${server.sessions.length === 1 ? 'session' : 'sessions'}`} · {server.scope.kind === 'team' ? (server.projects.length ? `on in ${listNames(server.projects)}` : 'on in no project') : `${principalOf(server.scope.userId).first}’s only`}</span>
    </span>)}
  </div>;
}

/** Sessions' count of active machine-hosted sessions among `ids` (everyone: null). */
function sessionsOf(list: readonly MachineMcpServer[], ids: ReadonlySet<string> | null): ReadonlyArray<{ server: MachineMcpServer; sessions: MachineMcpServer['sessions'] }> {
  return list.map((server) => ({ server, sessions: server.sessions.filter((session) => ids === null || ids.has(session.who)) })).filter((entry) => entry.sessions.length > 0);
}

export function MachineMcpStat({ ids }: { ids: ReadonlySet<string> | null }) {
  const gone = revoked.use();
  const active = sessionsOf(machineMcpServers.use().filter((server) => !gone.has(server.id)), ids);
  const count = active.reduce((sum, entry) => sum + entry.sessions.length, 0);
  return <Stat label="MCP servers on machines" value={String(count)} detail={`${count === 1 ? 'session' : 'sessions'} on ${active.length} ${active.length === 1 ? 'server' : 'servers'} · ${active.reduce((sum, entry) => sum + entry.sessions.reduce((calls, session) => calls + session.calls, 0), 0)} calls`} />;
}

/** Sessions › MCP servers on machines: the workspaces calling each server now. */
export function MachineMcpSessions({ ids }: { ids: ReadonlySet<string> | null }) {
  const gone = revoked.use();
  const active = sessionsOf(machineMcpServers.use().filter((server) => !gone.has(server.id)), ids);
  return <Section title="MCP servers on machines" description="Workspaces calling a server that runs on a machine, through the relay: who started the session, where, since when and how many calls.">
    {active.length ? <PanelGrid min="18rem">{active.map(({ server, sessions }) => <Panel key={server.id} id={`mcp-session-${server.id}`} head={<>
      <Server01 width={15} height={15} strokeWidth={1.5} /><span data-machine-mcp-session={server.id} className="truncate text-body font-medium text-foreground">{server.name}</span>
      <Pill tone="blue">on {machineLabel(server.machineId)}</Pill>{server.scope.kind === 'team' ? <Pill>Team</Pill> : <Pill tone="violet">{principalOf(server.scope.userId).first}’s</Pill>}
    </>}>
      {sessions.map((session) => <div key={session.who + session.workspace} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-caption">
        <UserName userId={session.who} /><span className="text-muted-foreground">in {session.workspace} · since {session.since}</span><span className="ml-auto tabular-nums text-foreground">{session.calls} calls</span>
      </div>)}
      <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground"><Dataflow03 width={12} height={12} strokeWidth={1.75} />{relayNote(server)}</span>
    </Panel>)}</PanelGrid> : <Note>No machine-hosted MCP server has a session open.</Note>}
  </Section>;
}

// ── The workspace's Environment popover ─────────────────────────────────────────────────────────────────────────────

/** "Tools from MCP servers on machines": the team servers on in the workspace's project and its holders' own servers,
 * each with its tools; an offline server's tools stay listed with the reason instead of disappearing. */
export function WorkspaceMachineTools({ workspaceId, holders, viewer }: { workspaceId: string; holders: readonly string[]; viewer: string }) {
  const gone = revoked.use();
  const all = machineMcpServers.use().filter((server) => !gone.has(server.id));
  const project = WORKSPACES.find((workspace) => workspace.id === workspaceId)?.projectId ?? '';
  const settings = projectSettings.use()[project];
  const list = serversFor(project, holders, settings?.holdersPlugins ?? false, all);
  return <section data-machine-tools="" className="flex flex-col gap-1.5 border-t border-border px-3 py-2">
    <header className="flex items-center gap-1.5 text-[12px] font-medium text-foreground"><Tool01 width={14} height={14} strokeWidth={1.75} className="text-muted-foreground" />Tools from MCP servers on machines<span className="font-normal text-muted-foreground">· through the relay</span></header>
    {list.length ? list.map((server) => {
      const offline = unavailable(server);
      const owner = server.scope.kind === 'personal' ? server.scope.userId : null;
      const others = owner !== null && owner !== viewer;
      const reason = offline ?? (server.state === 'stopped' ? `Stopped on ${machineLabel(server.machineId)}` : others && owner ? `only ${principalOf(owner).first}’s turns` : null);
      return <div key={server.id} data-machine-tool-server={server.id} className="flex flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-1.5 text-[12px]">
          <Server01 width={13} height={13} strokeWidth={1.75} className="shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate font-medium text-foreground">{server.name}</span>
          <span className="shrink-0 text-[11px] text-muted-foreground">{owner ? `${owner === viewer ? 'yours' : `${principalOf(owner).first}’s`} · while held` : `team · on in ${projectName(project)}`}</span>
          <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">{offline ? 'unavailable' : server.state}</span>
        </span>
        {offline ? <span data-machine-tool-offline={server.id} className="pl-5 text-[11.5px] font-medium text-[#b54708]">{offline} · its tools stay listed</span> : null}
        <ul className="flex flex-col pl-5">{server.tools.map((tool) => <li key={tool.name} data-machine-tool={`${server.id}:${tool.name}`} className={`flex min-w-0 items-center gap-2 py-px text-[11.5px] ${reason ? 'opacity-70' : ''}`}>
          <span className="shrink-0 font-mono text-foreground">{tool.name}</span>
          <span className="min-w-0 flex-1 truncate text-right text-[11px]" title={reason ?? tool.description}><span className={offline ? 'text-[#b54708]' : 'text-muted-foreground'}>{reason ?? tool.description}</span></span>
        </li>)}</ul>
        <span data-relay-note={server.id} className="flex items-center gap-1 pl-5 text-[11px] text-muted-foreground"><Dataflow03 width={11} height={11} strokeWidth={1.75} className="shrink-0" />{relayNote(server)}{server.env.length ? ' · credentials stay there' : ''}</span>
      </div>;
    }) : <p className="text-[11.5px] text-muted-foreground">No machine-hosted server is on in {projectName(project)}, and no holder has one of their own here</p>}
  </section>;
}

