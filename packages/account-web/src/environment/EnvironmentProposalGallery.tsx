import { Badge, Button, Card, CardContent, CardDescription, CardGroup, CardHeader, CardTitle, DropdownContent, DropdownMenu, DropdownTrigger, MenuItem, ScrollArea, TabsSubtle, TabsSubtleItem, useShape } from '@gitspace/ui';
import { DotsHorizontal, FileCode02, Key01, Play, Plus, RefreshCw01, Terminal, XClose } from '@untitledui/icons';
import { useState, type ReactNode } from 'react';
import { StatusDot } from '../GitSpaceShell.js';
import { glyph } from '../glyph.js';

/** Sign-off proposal for the Environment tab. Fixture data only: no backend, nothing runs. */
const TerminalIcon = glyph(Terminal);
const PlayIcon = glyph(Play);
const PlusIcon = glyph(Plus);
const RefreshIcon = glyph(RefreshCw01);
const FileIcon = glyph(FileCode02);
const KeyIcon = glyph(Key01);

type ScriptState = 'succeeded' | 'failed' | 'running' | 'waiting' | 'needs-terminal' | 'not-run';
type Script = { name: string; state: ScriptState; detail?: string };
type Phase = { id: string; label: string; scripts: Script[] };
type Machine = { id: string; name: string; os: string; status: 'Ready' | 'Starting' | 'Offline' | 'Paused'; lastSync: string; syncProblem?: string; phases: Phase[]; runs: { phase: string; status: string; at: string }[] };

const PREPARE: Script[] = [{ name: '10-tools.sh', state: 'succeeded', detail: '0.8s' }, { name: '20-aws-tools.sh', state: 'succeeded', detail: '0.1s' }, { name: '30-aws-login.sh', state: 'needs-terminal', detail: 'Interactive: asks for your MFA code' }];
const MATERIALIZE: Script[] = ['10-dependencies.sh', '20-environment.sh', '30-microsoft-graph.sh', '40-bedrock.sh', '50-server-extraction.sh', '60-npm-userconfig.sh'].map((name, index) => ({ name, state: 'succeeded' as const, detail: ['3.0s', '0.1s', '0.1s', '0.1s', '0.3s', '0.1s'][index] }));
const CHECKS: Script[] = ['Node 24', 'pnpm 10.34.6', 'Docker with Compose', 'git-lfs', 'poppler', 'AWS CLI v2', 'Terraform 1.16.5'].map(name => ({ name, state: 'succeeded' as const }));
const RUNS = [
  { phase: 'workspace/materialize', status: 'succeeded', at: '9:06 AM' },
  { phase: 'checks', status: 'succeeded', at: '9:06 AM' },
  { phase: 'machine/prepare', status: 'succeeded', at: '9:06 AM' },
  { phase: 'workspace/dematerialize', status: 'succeeded', at: 'Oct 10, 7:43 AM' },
  { phase: 'machine/prepare', status: 'succeeded', at: 'Oct 8, 2:44 PM' },
];
const phases = (prepare: Script[], materialize: Script[], checks: Script[]): Phase[] => [
  { id: 'machine/prepare', label: 'Prepare machine', scripts: prepare },
  { id: 'workspace/materialize', label: 'Prepare checkout', scripts: materialize },
  { id: 'checks', label: 'Checks', scripts: checks },
];
const darktop = (overrides: Partial<Machine> = {}): Machine => ({ id: 'darktop', name: 'Darktop', os: 'Linux', status: 'Ready', lastSync: '2 min ago', phases: phases(PREPARE, MATERIALIZE, CHECKS), runs: RUNS, ...overrides });

const STATES: { label: string; machines: Machine[] }[] = [
  { label: 'Ready', machines: [darktop()] },
  { label: 'Script failed', machines: [darktop({ phases: phases(PREPARE, [{ name: '10-dependencies.sh', state: 'failed', detail: 'exit 1 · NPM_TOKEN cannot read @topiaconsulting packages (403)' }, ...MATERIALIZE.slice(1)], CHECKS), runs: [{ phase: 'workspace/materialize', status: 'failed', at: '9:41 AM' }, ...RUNS.slice(0, 4)] })] },
  { label: 'Setup running', machines: [darktop({ phases: phases(PREPARE, [{ name: '10-dependencies.sh', state: 'running', detail: 'running 14s' }, ...MATERIALIZE.slice(1).map(script => ({ ...script, state: 'waiting' as const, detail: undefined }))], CHECKS) })] },
  { label: 'Sync problem', machines: [darktop({ syncProblem: 'Could not publish local changes: connection closed. Retrying.' })] },
  { label: 'Offline', machines: [darktop({ status: 'Offline', lastSync: '31 min ago' })] },
  { label: 'Two machines', machines: [darktop(), { ...darktop({ status: 'Starting', lastSync: 'not yet', runs: [] }), id: 'mbp', name: 'MacBook Pro', os: 'macOS', phases: phases(PREPARE.map(script => ({ ...script, state: 'not-run' as const, detail: undefined })), MATERIALIZE.map(script => ({ ...script, state: 'not-run' as const, detail: undefined })), CHECKS.map(script => ({ ...script, state: 'not-run' as const }))) }] },
  { label: 'No machine', machines: [] },
];

const STATUS_COLOR = { Ready: 'green', Starting: 'orange', Offline: 'dim', Paused: 'dim' } as const;
const SCRIPT_DOT = { succeeded: 'green', failed: 'red', running: 'blue', waiting: 'dim', 'needs-terminal': 'orange', 'not-run': 'dim' } as const;
const SECRETS = [
  { name: 'NPM_TOKEN', usedBy: '10-dependencies.sh, 60-npm-userconfig.sh', source: 'project' },
  { name: 'IDF_DEV_ENTRA_CLIENT_SECRET', usedBy: '30-microsoft-graph.sh, 50-server-extraction.sh', source: 'project' },
  { name: 'AWS_BEARER_TOKEN_BEDROCK', usedBy: '40-bedrock.sh, 50-server-extraction.sh', source: 'project' },
  { name: 'AWS_DEV_SECRET_ACCESS_KEY', usedBy: '30-aws-login.sh', source: 'project' },
];
const VALUES = [
  { name: 'ADMIN_EMAILS', usedBy: '20-environment.sh', source: 'project' },
  { name: 'ENTRA_TENANT_ID', usedBy: '30-microsoft-graph.sh, 50-server-extraction.sh', source: 'default' },
  { name: 'IDF_DEV_ENTRA_APPLICATION_ID', usedBy: '30-microsoft-graph.sh, 50-server-extraction.sh', source: 'project' },
  { name: 'AWS_DEV_ACCESS_KEY_ID', usedBy: '30-aws-login.sh', source: 'project' },
  { name: 'AWS_DEV_MFA_SERIAL', usedBy: '30-aws-login.sh', source: 'project' },
  { name: 'AWS_DEV_SESSION_SECONDS', usedBy: '30-aws-login.sh', source: 'default' },
];
const INSPECTOR_TABS = ['Overview', 'Environment', 'Goal', 'Agent setup', 'Files', 'Services', 'Usage'];

function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return <section className="flex flex-col gap-2">
    <div className="flex min-h-10 items-center justify-between gap-2"><h3 className="text-caption font-medium text-muted-foreground">{title}</h3>{action}</div>
    {children}
  </section>;
}

function ScriptRow({ script, onAct }: { script: Script; onAct(text: string): void }) {
  return <li className="flex min-h-10 items-center gap-2 text-caption">
    <StatusDot color={SCRIPT_DOT[script.state]} pulse={script.state === 'running'} />
    <span className={`min-w-0 flex-1 truncate font-mono ${script.state === 'not-run' || script.state === 'waiting' ? 'text-muted-foreground' : ''}`}>{script.name}</span>
    {script.state === 'needs-terminal'
      ? <Button variant="secondary" size="compact" leadingIcon={TerminalIcon} onClick={() => onAct(`Opens the terminal panel on this machine and runs machine/prepare with ${script.name} prompting there.`)}>Run in terminal</Button>
      : <>
        {script.detail ? <span className={`max-w-56 truncate tabular-nums ${script.state === 'failed' ? 'text-destructive' : 'text-muted-foreground'}`}>{script.detail}</span> : script.state === 'waiting' ? <span className="text-muted-foreground">waiting</span> : script.state === 'not-run' ? <span className="text-muted-foreground">not run</span> : null}
        {script.state === 'succeeded' || script.state === 'failed' || script.state === 'running' ? <Button variant="ghost" size="compact" onClick={() => onAct(`Opens the log for ${script.name}.`)}>Log</Button> : null}
      </>}
  </li>;
}

function MachineCard({ machine, index, onAct }: { machine: Machine; index: number; onAct(text: string): void }) {
  const failed = machine.phases.flatMap(phase => phase.scripts).some(script => script.state === 'failed');
  const running = machine.phases.flatMap(phase => phase.scripts).some(script => script.state === 'running');
  return <Card size="compact" index={index}>
    <CardHeader>
      <CardTitle><span className="flex items-center gap-2">{machine.name}<span className="ml-auto flex items-center gap-2 text-caption font-normal"><StatusDot color={STATUS_COLOR[machine.status]} />{machine.status}</span>
        <DropdownMenu size="compact">
          <DropdownTrigger render={<Button variant="ghost" size="icon-compact" type="button" aria-label={`${machine.name} actions`}><DotsHorizontal width={16} height={16} strokeWidth={1.5} /></Button>} />
          <DropdownContent align="end" sideOffset={6} className="min-w-[220px]">
            <MenuItem index={0} icon={PlayIcon} label="Run setup" onSelect={() => onAct('Runs every setup phase on this machine. Interactive scripts are skipped.')} />
            <MenuItem index={1} icon={TerminalIcon} label="Run setup in terminal" onSelect={() => onAct('Opens the terminal panel and runs setup there, so interactive scripts can prompt.')} />
            <MenuItem index={2} icon={RefreshIcon} label="Run checks" onSelect={() => onAct('Runs the checks on this machine.')} />
            <MenuItem index={3} icon={TerminalIcon} label="Open terminal" onSelect={() => onAct('Opens a terminal on this machine in the workspace checkout.')} />
            <MenuItem index={4} icon={glyph(XClose)} label="Detach" onSelect={() => onAct('Detaches this machine from the workspace. Its checkout stays on disk until you remove it.')} />
          </DropdownContent>
        </DropdownMenu>
      </span></CardTitle>
      <CardDescription><span className="tabular-nums">{machine.os} · last sync {machine.lastSync}</span></CardDescription>
    </CardHeader>
    <CardContent>
      <div className="flex flex-col gap-3">
        {machine.syncProblem ? <p role="status" className="text-caption text-warning">Sync problem · {machine.syncProblem}</p> : null}
        {machine.phases.map(phase => <div key={phase.id} className="flex flex-col">
          <div className="flex items-center justify-between gap-2"><span className="text-caption font-medium">{phase.label}</span><code className="font-mono text-caption text-muted-foreground">{phase.id}</code></div>
          <ul className="flex flex-col">{phase.scripts.map(script => <ScriptRow key={script.name} script={script} onAct={onAct} />)}</ul>
        </div>)}
        {failed && !running ? <div className="flex"><Button variant="secondary" size="compact" leadingIcon={PlayIcon} onClick={() => onAct('Runs setup again on this machine.')}>Run setup again</Button></div> : null}
        {machine.runs.length ? <details className="text-caption">
          <summary className="min-h-10 cursor-pointer py-2 text-muted-foreground">Recent runs · last {machine.runs.length}</summary>
          <ul className="flex flex-col">{machine.runs.map((run, runIndex) => <li key={runIndex} className="flex min-h-10 items-center gap-2"><StatusDot color={run.status === 'failed' ? 'red' : 'green'} /><span className="flex-1 font-mono">{run.phase}</span><span className="tabular-nums text-muted-foreground">{run.at}</span><Button variant="ghost" size="compact" onClick={() => onAct(`Opens the logs for the ${run.phase} run at ${run.at}.`)}>Logs</Button></li>)}</ul>
        </details> : null}
      </div>
    </CardContent>
  </Card>;
}

export function EnvironmentProposalGallery() {
  const shape = useShape();
  const [state, setState] = useState(0);
  const [note, setNote] = useState('Fixture data · nothing runs. Use the states above and the menus to see each case.');
  const machines = STATES[state]!.machines;
  const enrolled = [{ id: 'darktop', name: 'Darktop', detail: 'Linux · online' }, { id: 'mbp', name: 'MacBook Pro', detail: 'macOS · offline' }];
  const attachable = enrolled.filter(item => !machines.some(machine => machine.id === item.id));
  return <div className="flex h-dvh min-h-0 bg-surface-0 text-foreground">
    <main className="flex min-w-0 flex-1 flex-col gap-4 p-6">
      <div className="flex flex-col gap-1"><h1 className="text-title font-semibold">Environment tab · proposal</h1><p className="max-w-prose text-body text-muted-foreground text-pretty">Machines, setup per machine, secrets and values. Status is Ready, Starting, Offline or Paused only; setup results and sync problems are shown on their own lines and never change it.</p></div>
      <TabsSubtle size="compact" selectedIndex={state} onSelect={setState} aria-label="Proposal state">{STATES.map((item, index) => <TabsSubtleItem index={index} label={item.label} key={item.label} />)}</TabsSubtle>
      <p role="status" className={`${shape.container} max-w-prose bg-surface-2 p-3 text-caption text-muted-foreground shadow-surface-1`}>{note}</p>
    </main>
    <aside className="flex w-[460px] min-w-0 flex-col border-l border-border bg-surface-2" aria-label="Inspector">
      <div className="flex shrink-0 items-center gap-1 px-2 pb-1 pt-2">
        <TabsSubtle idPrefix="proposalInspectorTabs" size="compact" className="min-w-0 flex-1" selectedIndex={1} onSelect={() => {}} aria-label="Inspector views">{INSPECTOR_TABS.map((label, index) => <TabsSubtleItem index={index} label={label} key={label} />)}</TabsSubtle>
      </div>
      <ScrollArea className="min-h-0 flex-1 border-t border-border" viewportClassName="h-full">
        <div className="flex flex-col gap-5 p-4">
          <Section title={`Machines · ${machines.length}`} action={<DropdownMenu size="compact">
            <DropdownTrigger render={<Button variant="secondary" size="compact" leadingIcon={PlusIcon} disabled={!attachable.length}>Attach machine</Button>} />
            <DropdownContent align="end" sideOffset={6} className="min-w-[240px]">
              {attachable.map((item, index) => <MenuItem index={index} key={item.id} label={`${item.name} · ${item.detail}`} onSelect={() => setNote(`Attaches ${item.name}. It shows Starting until it is online with sync running, then Ready.`)} />)}
            </DropdownContent>
          </DropdownMenu>}>
            {machines.length
              ? <div className="flex flex-col gap-3">{machines.map((machine, index) => <MachineCard key={machine.id} machine={machine} index={index} onAct={setNote} />)}</div>
              : <p className="text-caption text-muted-foreground">No machine attached. Attach one so the agent can run commands.</p>}
          </Section>
          <Section title="Secrets" action={<Button variant="ghost" size="compact" onClick={() => setNote('Opens Secrets & values.')}>Manage</Button>}>
            <CardGroup border="outlined" separated proximityHover={false}>{SECRETS.map((secret, index) => <Card size="compact" index={index} key={secret.name}>
              <CardHeader className="py-2.5"><CardTitle><span className="flex items-center gap-2"><KeyIcon size={16} strokeWidth={1.5} className="text-muted-foreground" /><code className="min-w-0 truncate font-mono text-body">{secret.name}</code><Badge className="ml-auto" size="compact" color="green">{secret.source}</Badge></span></CardTitle><CardDescription><span className="font-mono">{secret.usedBy}</span></CardDescription></CardHeader>
            </Card>)}</CardGroup>
          </Section>
          <Section title="Values">
            <CardGroup border="outlined" separated proximityHover={false}>{VALUES.map((value, index) => <Card size="compact" index={index} key={value.name}>
              <CardHeader className="py-2.5"><CardTitle><span className="flex items-center gap-2"><code className="min-w-0 truncate font-mono text-body">{value.name}</code><Badge className="ml-auto" size="compact" color={value.source === 'default' ? 'gray' : 'blue'}>{value.source}</Badge><Button variant="ghost" size="compact" onClick={() => setNote(`Edits ${value.name}.`)}>Edit</Button></span></CardTitle><CardDescription><span className="font-mono">{value.usedBy}</span></CardDescription></CardHeader>
            </Card>)}</CardGroup>
          </Section>
          <details className="text-caption">
            <summary className="flex min-h-10 cursor-pointer items-center gap-2 text-muted-foreground"><FileIcon size={16} strokeWidth={1.5} />About this setup</summary>
            <p className="pt-1 text-muted-foreground text-pretty">Local-only development setup: no cloud resources. machine/prepare installs Node 24, pnpm 10 and git-lfs into the managed tools directory when missing… (the repo's own notes from .gitspace/bundle.json, collapsed by default)</p>
          </details>
        </div>
      </ScrollArea>
    </aside>
  </div>;
}
