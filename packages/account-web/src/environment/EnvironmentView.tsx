import { Badge, Button, Card, CardContent, CardDescription, CardGroup, CardHeader, CardTitle, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DropdownContent, DropdownMenu, DropdownTrigger, InputField, InputGroup, MenuItem, ScrollArea, Select, SelectContent, SelectItem, SelectTrigger } from '@gitspace/ui';
import { DotsHorizontal, FileCode02, Key01, Play, Plus, RefreshCw01, Terminal, XClose } from '@untitledui/icons';
import { useState, type ReactNode } from 'react';
import type { WorkspaceStatusColor } from '@gitspace/protocol-workspace';
import { StatusDot } from '../GitSpaceShell.js';
import { glyph } from '../glyph.js';
import { STEP_LABEL } from './lifecycle.js';
import type { EnvironmentMachine, EnvironmentScript, EnvironmentStep, EnvironmentViewProps, ScriptRun } from './types.js';

const TerminalIcon = glyph(Terminal);
const PlayIcon = glyph(Play);
const PlusIcon = glyph(Plus);
const RefreshIcon = glyph(RefreshCw01);
const FileIcon = glyph(FileCode02);
const KeyIcon = glyph(Key01);
const DetachIcon = glyph(XClose);

const RUN_DOT: Record<ScriptRun['status'], WorkspaceStatusColor> = { succeeded: 'green', failed: 'red', running: 'blue', interrupted: 'orange', 'not-started': 'dim', never: 'dim' };
const RUN_TEXT: Record<Exclude<ScriptRun['status'], 'succeeded' | 'failed'>, string> = { running: 'running', interrupted: 'interrupted', 'not-started': 'waiting', never: 'not run' };
const SETUP_TEXT = { pending: 'waiting', 'waiting-for-approval': 'needs approval', running: 'running', succeeded: 'succeeded', failed: 'failed' } as const;
const SETUP_DOT = { pending: 'dim', 'waiting-for-approval': 'orange', running: 'blue', succeeded: 'green', failed: 'red' } as const;

function Section({ title, label, action, children }: { title: ReactNode; label: string; action?: ReactNode; children: ReactNode }) {
  return <section aria-label={label} className="flex flex-col gap-2">
    <div className="flex min-h-10 items-center justify-between gap-2"><h3 className="text-caption font-medium text-muted-foreground">{title}</h3>{action}</div>
    {children}
  </section>;
}

function ScriptRow({ script, phase, machineId, busy, onApprove, onRevoke, onOpenScript, onOpenLog, onRunPhase }: { script: EnvironmentScript; phase: EnvironmentStep['phase']; machineId: string | null } & Pick<EnvironmentViewProps, 'busy' | 'onApprove' | 'onRevoke' | 'onOpenScript' | 'onOpenLog' | 'onRunPhase'>) {
  const run = script.lastRun;
  return <li aria-label={`Script ${script.label}`} className="flex min-h-10 flex-wrap items-center gap-2 text-caption">
    <StatusDot color={script.approval.approved ? RUN_DOT[run.status] : 'orange'} pulse={run.status === 'running'} />
    <Button variant="ghost" size="compact" className="min-w-0 flex-1 justify-start font-mono" onClick={() => onOpenScript(script.id)}><span className="truncate">{script.label}</span></Button>
    {script.interactive ? <Badge className="shrink-0" size="compact" color="amber">Interactive</Badge> : null}
    {!script.approval.approved
      ? <><Badge size="compact" color="amber">Needs approval</Badge><Button variant="secondary" size="compact" disabled={busy} onClick={() => onApprove(script.id)}>Review & approve</Button></>
      : <>
        {run.status === 'succeeded' || run.status === 'failed' ? <span className={`max-w-40 truncate tabular-nums ${run.status === 'failed' ? 'text-destructive' : 'text-muted-foreground'}`}>{run.detail}</span> : script.interactive && run.status === 'never' ? null : <span className="shrink-0 text-muted-foreground">{RUN_TEXT[run.status]}</span>}
        {script.interactive && run.status !== 'running' ? <Button variant="secondary" size="compact" leadingIcon={TerminalIcon} disabled={busy || !machineId} onClick={() => { if (machineId) onRunPhase(machineId, phase, { interactive: true, rerun: true }); }}>Run in terminal</Button> : null}
        {run.status !== 'never' ? <Button variant="ghost" size="compact" onClick={() => onOpenLog(run.runId, { id: script.id, label: script.label })}>Log</Button> : null}
        <Button variant="ghost" size="compact" disabled={busy} onClick={() => onRevoke(script.id)}>Revoke</Button>
      </>}
  </li>;
}

function StepBlock({ step, machineId, busy, onRetire, ...actions }: { step: EnvironmentStep; machineId: string | null; busy: boolean; onRetire(): void } & Pick<EnvironmentViewProps, 'onApprove' | 'onRevoke' | 'onOpenScript' | 'onOpenLog' | 'onRunPhase'>) {
  const needsApproval = step.scripts.some(script => !script.approval.approved);
  const ran = step.scripts.some(script => script.lastRun.status !== 'never');
  const running = step.scripts.some(script => script.lastRun.status === 'running');
  const run = (): void => {
    if (!machineId) return;
    if (step.phase === 'cloud/destroy') onRetire();
    else actions.onRunPhase(machineId, step.phase, ran ? { rerun: true } : undefined);
  };
  return <div aria-label={`Setup step ${step.label}`} className="flex flex-col">
    <div className="flex min-h-10 flex-wrap items-center justify-between gap-2">
      <span className="flex items-center gap-2 text-caption font-medium">{step.label}{needsApproval ? <Badge size="compact" color="amber">Needs approval</Badge> : null}</span>
      <span className="flex items-center gap-2"><code className="font-mono text-caption text-muted-foreground">{step.phase}</code>
        {step.scripts.length ? <Button variant="ghost" size="compact" leadingIcon={step.phase === 'checks' ? RefreshIcon : PlayIcon} loading={running} disabled={busy || !machineId || running} onClick={run}>
          {step.phase === 'checks' ? 'Run checks' : step.phase === 'cloud/destroy' ? 'Retire…' : ran ? 'Run again' : 'Run'}
        </Button> : null}
      </span>
    </div>
    {step.scripts.length
      ? <ul className="flex flex-col">{step.scripts.map(script => <ScriptRow key={script.id} script={script} phase={step.phase} machineId={machineId} busy={busy} {...actions} />)}</ul>
      : <p className="text-caption text-muted-foreground">No {step.phase === 'checks' ? 'checks' : 'scripts'} for this profile.</p>}
  </div>;
}

function MachineCard({ machine, index, busy, props, onRecover }: { machine: EnvironmentMachine; index: number; busy: boolean; props: EnvironmentViewProps; onRecover(runId: string): void }) {
  const failed = machine.setup.find(step => step.state === 'failed');
  const running = machine.setup.some(step => step.state === 'running');
  const { sync } = machine;
  return <Card size="compact" index={index} aria-label={`Machine ${machine.name}`}>
    <CardHeader>
      <CardTitle><span className="flex items-center gap-2">{machine.name}<span role="status" className="ml-auto flex items-center gap-2 text-caption font-normal"><StatusDot color={machine.color} />{machine.status}</span>
        <DropdownMenu size="compact">
          <DropdownTrigger render={<Button variant="ghost" size="icon-compact" type="button" aria-label={`${machine.name} actions`}><DotsHorizontal width={16} height={16} strokeWidth={1.5} /></Button>} />
          <DropdownContent align="end" sideOffset={6} className="min-w-[220px]">
            {props.onOpenTerminal && machine.ready ? <MenuItem index={0} icon={TerminalIcon} label="Open terminal" onSelect={() => props.onOpenTerminal?.(machine.id)} /> : null}
            {machine.online ? <MenuItem index={1} icon={RefreshIcon} label="Run checks" onSelect={() => props.onRunPhase(machine.id, 'checks')} /> : null}
            <MenuItem index={2} icon={DetachIcon} label="Detach" onSelect={() => props.onDetach(machine.id)} />
          </DropdownContent>
        </DropdownMenu>
      </span></CardTitle>
      <CardDescription><span className="tabular-nums">Last sync {sync.lastSyncAt ? new Date(sync.lastSyncAt).toLocaleString() : 'not yet'}</span></CardDescription>
    </CardHeader>
    <CardContent>
      <div className="flex flex-col gap-3">
        <ul aria-label="Setup results" className="flex flex-col">{machine.setup.length ? machine.setup.map(step => <li key={step.phase} className="flex min-h-10 flex-wrap items-center gap-2 text-caption">
          <StatusDot color={SETUP_DOT[step.state]} pulse={step.state === 'running'} />
          <span className="shrink-0">{STEP_LABEL[step.phase]}</span>
          <span className={`min-w-0 flex-1 truncate text-right ${step.state === 'failed' ? 'text-destructive' : 'text-muted-foreground'}`}>{SETUP_TEXT[step.state]}{step.error && step.state === 'failed' ? ` · ${step.error}` : ''}</span>
          {step.runId ? <Button variant="ghost" size="compact" onClick={() => props.onOpenLog(step.runId!, { id: step.phase, label: STEP_LABEL[step.phase] })}>Log</Button> : null}
        </li>) : <li className="text-caption text-muted-foreground">Setup has not run on this machine yet.</li>}</ul>
        {failed && !running ? <div className="flex"><Button variant="secondary" size="compact" leadingIcon={PlayIcon} disabled={busy || !machine.online} onClick={() => props.onRunPhase(machine.id, failed.phase, { rerun: true })}>Run setup again</Button></div> : null}
        <div aria-label="Sync" className="flex flex-col gap-1 text-caption">
          <p className="tabular-nums text-muted-foreground">{sync.unsent === null ? 'Unsent changes not reported yet' : `${sync.unsent} unsent ${sync.unsent === 1 ? 'change' : 'changes'}`}{sync.unapplied ? ' · cloud changes not yet on this machine' : ''}</p>
          {sync.problem ? <p role="status" className="break-words text-warning">Sync problem · {sync.problem}</p> : null}
          <div className="flex flex-wrap gap-1">
            <Button variant="ghost" size="compact" leadingIcon={RefreshIcon} disabled={busy || !machine.online} onClick={() => props.onSyncNow(machine.id)}>Sync now</Button>
            <Button variant="ghost" size="compact" disabled={busy || !machine.online || sync.unsent === 0} onClick={() => props.onShowUnsent(machine.id)}>Show unsent changes</Button>
          </div>
        </div>
        {machine.runs.length ? <details className="text-caption">
          <summary className="min-h-10 cursor-pointer py-2 text-muted-foreground">Recent runs · last {machine.runs.length}</summary>
          <ul className="flex flex-col">{machine.runs.map(run => <li key={run.id} className="flex min-h-10 flex-wrap items-center gap-2">
            <StatusDot color={run.status === 'failed' ? 'red' : run.active ? 'blue' : run.status === 'succeeded' ? 'green' : 'dim'} />
            <span className="flex-1">{STEP_LABEL[run.phase]} · {run.status}</span>
            <span className="tabular-nums text-muted-foreground">{new Date(run.startedAt).toLocaleString()}</span>
            <Button variant="ghost" size="compact" onClick={() => props.onOpenLog(run.id, { id: run.phase, label: STEP_LABEL[run.phase] })}>Logs</Button>
            {run.active ? <><Button variant="ghost" size="compact" disabled={busy} onClick={() => props.onCancelRun(run.id)}>Cancel</Button><Button variant="ghost" size="compact" disabled={busy} onClick={() => onRecover(run.id)}>Recover…</Button></> : null}
          </li>)}</ul>
        </details> : null}
      </div>
    </CardContent>
  </Card>;
}

function EditValueDialog({ value, onClose, onSave }: { value: { name: string; value: string }; onClose(): void; onSave(value: string): void }) {
  const [draft, setDraft] = useState(value.value);
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent size="sm">
      <DialogHeader><DialogTitle>Edit {value.name}</DialogTitle><DialogDescription>Saved for this workspace. Setup scripts receive it on their next run.</DialogDescription></DialogHeader>
      <InputGroup><InputField index={0} label={value.name} value={draft} onChange={setDraft} /></InputGroup>
      <DialogFooter><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={draft === value.value} onClick={() => { onSave(draft); onClose(); }}>Save</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}

/** The Environment tab: Overview, Machines (status, setup results, sync), Setup (steps and their scripts) and Values. */
export function EnvironmentView(props: EnvironmentViewProps) {
  const { model, busy = false } = props;
  const [editing, setEditing] = useState<{ name: string; value: string } | null>(null);
  const [retiring, setRetiring] = useState(false);
  const [recovering, setRecovering] = useState<string | null>(null);
  const setupMachine = model.machines.find(machine => machine.id === model.setupMachineId) ?? null;
  const approvals = model.steps.flatMap(step => step.scripts).filter(script => !script.approval.approved).length + model.browserOrigins.filter(origin => !origin.approved).length;
  const ready = model.machines.filter(machine => machine.ready).length;
  const scriptActions = { onApprove: props.onApprove, onRevoke: props.onRevoke, onOpenScript: props.onOpenScript, onOpenLog: props.onOpenLog, onRunPhase: props.onRunPhase };
  return <ScrollArea className="min-h-0 flex-1" viewportClassName="h-full">
    <div className="flex flex-col gap-5 p-4">
      <Section label="Overview" title="Overview">
        <span className="text-caption text-muted-foreground">{model.project} · {model.workspace}</span>
        <p role="status" className="flex flex-wrap items-center gap-2 text-caption tabular-nums">
          <StatusDot color={approvals ? 'orange' : ready ? 'green' : 'dim'} />
          {model.machines.length ? `${ready} of ${model.machines.length} ${model.machines.length === 1 ? 'machine' : 'machines'} ready` : 'No machine'}
          {approvals ? ` · ${approvals} ${approvals === 1 ? 'needs' : 'need'} approval` : ''}
        </p>
        {model.profile.options.length > 1 ? <Select value={model.profile.selected} onValueChange={props.onProfileChange} disabled={busy}>
          <SelectTrigger aria-label="Runtime profile" />
          <SelectContent>{model.profile.options.map((name, index) => <SelectItem key={name} value={name} index={index}>{name}</SelectItem>)}</SelectContent>
        </Select> : null}
        {!model.configured ? <div className="flex flex-wrap items-center justify-between gap-2 text-caption text-muted-foreground">
          <p className="max-w-prose text-pretty">This repository has no setup scripts yet.</p>
          {props.onConfigure ? <Button variant="ghost" size="compact" disabled={busy} onClick={props.onConfigure}>Configure with agent</Button> : null}
        </div> : null}
        <details className="text-caption">
          <summary className="flex min-h-10 cursor-pointer items-center gap-2 text-muted-foreground"><FileIcon size={16} strokeWidth={1.5} />About this setup</summary>
          <div className="flex flex-col gap-2 pt-1 text-muted-foreground text-pretty">
            {model.notes ? <p>{model.notes}</p> : null}
            {Object.keys(model.bindings).length ? <dl aria-label="Resource bindings" className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-x-3 gap-y-1">{Object.entries(model.bindings).map(([name, value]) => <div className="contents" key={name}><dt className="break-all font-mono">{name}</dt><dd className="break-all font-mono text-foreground">{value}</dd></div>)}</dl> : null}
            <p>Approved scripts run as your user on the machine and can use its existing credentials. Secret grants control only the secrets GitSpace injects. This is not a sandbox.</p>
          </div>
        </details>
      </Section>

      <Section label="Machines" title={`Machines · ${model.machines.length}`} action={<DropdownMenu size="compact">
        <DropdownTrigger render={<Button variant="secondary" size="compact" leadingIcon={PlusIcon} disabled={busy || !model.attachable.length}>Attach machine</Button>} />
        <DropdownContent align="end" sideOffset={6} className="min-w-[240px]">
          {model.attachable.map((machine, index) => <MenuItem index={index} key={machine.id} label={machine.label} onSelect={() => props.onAttach(machine.id)} />)}
        </DropdownContent>
      </DropdownMenu>}>
        {model.machines.length
          ? <div className="flex flex-col gap-3">{model.machines.map((machine, index) => <MachineCard key={machine.id} machine={machine} index={index} busy={busy} props={props} onRecover={setRecovering} />)}</div>
          : <p role="status" className="flex items-center gap-2 text-caption text-muted-foreground"><StatusDot color="dim" />No machine. Attach one so setup and commands can run.</p>}
        {props.machinesFooter}
        {model.conflicts.length ? <div role="alert" aria-label="Sync conflicts" className="flex flex-col gap-1 text-caption">
          <p className="font-medium text-destructive">Conflicts · choose which version to keep. The other is backed up first.</p>
          <ul className="flex flex-col">{model.conflicts.map(path => <li key={path} className="flex min-h-10 flex-wrap items-center gap-2">
            <code className="min-w-0 flex-1 break-all font-mono">{path}</code>
            <Button variant="ghost" size="compact" disabled={busy} onClick={() => props.onResolveConflict(path, 'cloud')}>Keep cloud</Button>
            <Button variant="ghost" size="compact" disabled={busy} onClick={() => props.onResolveConflict(path, 'machine')}>Keep machine</Button>
          </li>)}</ul>
        </div> : null}
      </Section>

      <Section label="Setup" title={setupMachine ? `Setup · ${setupMachine.name}` : 'Setup'} action={model.machines.length > 1 ? <select aria-label="Setup machine" className="min-h-10 rounded-md bg-surface-3 px-3 text-caption" value={model.setupMachineId ?? ''} disabled={busy} onChange={event => props.onSelectSetupMachine(event.target.value)}>
        <option value="">Choose a machine</option>
        {model.machines.map(machine => <option key={machine.id} value={machine.id}>{machine.name}</option>)}
      </select> : null}>
        {!model.setupMachineId ? <p className="text-caption text-muted-foreground">{model.machines.length ? 'Choose a machine to see its results and run setup there.' : 'Attach a machine to run setup. Approvals and logs stay available.'}</p> : null}
        <div className="flex flex-col gap-3">
          {model.steps.map(step => <StepBlock key={step.phase} step={step} machineId={model.setupMachineId} busy={busy} onRetire={() => setRetiring(true)} {...scriptActions} />)}
          <div aria-label="Setup step Agent setup" className="flex min-h-10 flex-wrap items-center justify-between gap-2">
            <span className="flex flex-col"><span className="text-caption font-medium">Agent setup</span><span className="text-caption text-muted-foreground">Agents, skills and rules this repository defines.</span></span>
            {props.onOpenAgentSetup ? <Button variant="ghost" size="compact" onClick={props.onOpenAgentSetup}>Open Agent setup</Button> : null}
          </div>
          {model.browserOrigins.length ? <div aria-label="Setup step Browser access" className="flex flex-col">
            <span className="flex min-h-10 items-center text-caption font-medium">Browser access</span>
            <ul className="flex flex-col">{model.browserOrigins.map(origin => <li key={origin.hash} className="flex min-h-10 flex-wrap items-center gap-2 text-caption">
              <StatusDot color={origin.approved ? 'green' : 'orange'} /><code className="min-w-0 flex-1 break-all font-mono">{origin.pattern}</code>
              {origin.approved ? <Button variant="ghost" size="compact" disabled={busy} onClick={() => props.onRevoke(origin.hash)}>Revoke</Button> : <><Badge size="compact" color="amber">Needs approval</Badge><Button variant="secondary" size="compact" disabled={busy} onClick={() => props.onApprove(origin.hash)}>Review & approve</Button></>}
            </li>)}</ul>
          </div> : null}
        </div>
      </Section>

      <Section label="Values" title="Values" action={<Button variant="ghost" size="compact" leadingIcon={KeyIcon} onClick={props.onOpenSecrets}>Open Secrets & values</Button>}>
        {model.secrets.length || model.values.length ? <CardGroup border="outlined" separated proximityHover={false}>
          {model.secrets.map((secret, index) => <Card size="compact" index={index} key={`secret:${secret.name}`} aria-label={`Secret ${secret.name}`}>
            <CardHeader className="py-2.5"><CardTitle><span className="flex items-center gap-2"><KeyIcon size={16} strokeWidth={1.5} className="text-muted-foreground" /><code className="min-w-0 truncate font-mono text-body">{secret.name}</code><Badge className="ml-auto" size="compact" color={secret.granted ? 'green' : 'red'}>{secret.granted ? `${secret.source} secret` : 'missing'}</Badge></span></CardTitle></CardHeader>
          </Card>)}
          {model.values.map((value, index) => <Card size="compact" index={model.secrets.length + index} key={`value:${value.name}`} aria-label={`Value ${value.name}`}>
            <CardHeader className="py-2.5"><CardTitle><span className="flex items-center gap-2"><code className="min-w-0 truncate font-mono text-body">{value.name}</code><Badge className="ml-auto" size="compact" color={value.source === 'default' ? 'gray' : 'blue'}>{value.source}</Badge><Button variant="ghost" size="compact" disabled={busy} onClick={() => setEditing(value)}>Edit</Button></span></CardTitle></CardHeader>
          </Card>)}
        </CardGroup> : <p className="text-caption text-muted-foreground">This profile declares no secrets or values.</p>}
      </Section>

      {editing ? <EditValueDialog value={editing} onClose={() => setEditing(null)} onSave={value => props.onEditValue(editing.name, value)} /> : null}
      <Dialog open={retiring} onOpenChange={setRetiring}>
        <DialogContent size="sm">
          <DialogHeader><DialogTitle>Retire this workspace’s cloud resources?</DialogTitle><DialogDescription>Runs the approved cloud/destroy scripts to delete the resources recorded for this workspace. Check the bindings and script content first; deletion may be irreversible.</DialogDescription></DialogHeader>
          <DialogFooter><Button variant="secondary" onClick={() => setRetiring(false)}>Cancel</Button><Button variant="primary" disabled={busy || !model.setupMachineId} onClick={() => { if (model.setupMachineId) props.onRunPhase(model.setupMachineId, 'cloud/destroy', { retire: true }); setRetiring(false); }}>Retire resources</Button></DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={recovering !== null} onOpenChange={open => { if (!open) setRecovering(null); }}>
        <DialogContent size="sm">
          <DialogHeader><DialogTitle>Recover an abandoned run?</DialogTitle><DialogDescription>Recovery releases this run’s claim without rerunning it. The cloud accepts it only when the machine that owns the run is confirmed gone; an offline machine could still be running it. Check external resources before running again.</DialogDescription></DialogHeader>
          <DialogFooter><Button variant="secondary" onClick={() => setRecovering(null)}>Cancel</Button><Button variant="primary" disabled={busy} onClick={() => { if (recovering) props.onRecoverRun(recovering); setRecovering(null); }}>Mark run abandoned</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  </ScrollArea>;
}
