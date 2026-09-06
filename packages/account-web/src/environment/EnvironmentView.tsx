import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardGroup,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Elevated,
  InputField,
  InputGroup,
  ScrollArea,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  Tooltip,
  useShape,
  type BadgeProps,
} from '@gitspace/ui';
import { AlertTriangle, Edit03, FileCode02, Key01, Play, Plus, ShieldTick, Terminal, Tool02, Trash01 } from '@untitledui/icons';
import { useState, type ReactNode } from 'react';
import { StatusDot } from '../GitSpaceShell.js';
import { glyph } from '../glyph.js';
import { LIFECYCLE_PHASES, PHASE_LABEL, PHASE_SCOPE, latestLifecycleRun, lifecycleSummary } from './lifecycle.js';
import type { CapabilityResult, EnvironmentCheckDefinition, EnvironmentProfileDefinition, EnvironmentViewProps, LifecyclePhase, LifecycleRun, LifecycleScript, TrustState } from './types.js';

const AlertIcon = glyph(AlertTriangle);
const EditIcon = glyph(Edit03);
const FileIcon = glyph(FileCode02);
const KeyIcon = glyph(Key01);
const PlayIcon = glyph(Play);
const PlusIcon = glyph(Plus);
const ShieldIcon = glyph(ShieldTick);
const TerminalIcon = glyph(Terminal);
const ToolIcon = glyph(Tool02);
const TrashIcon = glyph(Trash01);

const TRUST_COLOR: Record<TrustState['status'], NonNullable<BadgeProps['color']>> = { approved: 'green', pending: 'amber', changed: 'red' };
const RUN_COLOR: Record<LifecycleRun['status'], NonNullable<BadgeProps['color']>> = { succeeded: 'green', failed: 'red', running: 'blue', never: 'gray' };

function profileDefinition(profileName: string, profiles: Record<string, EnvironmentProfileDefinition>): EnvironmentProfileDefinition {
  const base = profiles.base ?? { checks: [], secrets: [], inputs: [], notes: '' };
  if (profileName === 'base') return base;
  const selected = profiles[profileName] ?? { checks: [], secrets: [], inputs: [], notes: '' };
  return {
    checks: [...new Set([...base.checks, ...selected.checks])],
    secrets: [...new Set([...base.secrets, ...selected.secrets])],
    inputs: [...new Set([...base.inputs, ...selected.inputs])],
    notes: [base.notes, selected.notes].filter(Boolean).join(' '),
  };
}

function statusDot(result: CapabilityResult): ReactNode {
  return <StatusDot color={result.status === 'pass' ? 'green' : result.status === 'fail' ? 'red' : 'dim'} />;
}

function trustBadge(trust: TrustState): ReactNode {
  return <Tooltip content={trust.status === 'approved' ? `Approved by ${trust.approvedBy} · ${trust.approvedAt}` : trust.status === 'changed' ? `Previously approved by ${trust.approvedBy} · ${trust.approvedAt}` : 'This command has never been approved'} side="top">
    <Badge size="compact" color={TRUST_COLOR[trust.status]}>{trust.status === 'changed' ? 'changed · approval required' : trust.status}</Badge>
  </Tooltip>;
}

// FLUID-GAP: the registry has no compact command-diff component.
function CommandDiff({ trust }: { trust: Extract<TrustState, { status: 'changed' }> }) {
  const shape = useShape();
  return <div className={`${shape.container} overflow-hidden bg-surface-3 font-mono text-caption shadow-surface-1`} aria-label="Command changed since approval">
    <div className="flex gap-2 px-3 py-2 text-destructive"><span aria-hidden>−</span><code className="min-w-0 break-all">{trust.approvedCommand}</code></div>
    <div className="flex gap-2 bg-surface-4 px-3 py-2 text-foreground"><span aria-hidden>+</span><code className="min-w-0 break-all">{trust.currentCommand}</code></div>
  </div>;
}

function CheckCard({ check, result, onApprove, onRevoke, onFix, onEdit, onDelete, index }: { check: EnvironmentCheckDefinition; result: CapabilityResult; onApprove(): void; onRevoke(): void; onFix?: () => void; onEdit(): void; onDelete(): void; index?: number }) {
  return <Card size="compact" index={index}>
    <CardHeader>
      <CardTitle><span className="flex items-center gap-2">{statusDot(result)}{check.label}<Badge size="compact" color={check.source === 'catalog' ? 'blue' : 'violet'}>{check.source === 'catalog' ? 'built-in' : 'custom'}</Badge></span></CardTitle>
      <CardDescription>
        <span className="flex flex-col gap-1">
          {check.requirement ? <span>Required {check.requirement}</span> : null}
          {check.probe ? <code className="break-all font-mono">{check.probe}</code> : null}
          <span className={result.status === 'fail' ? 'text-destructive' : undefined}>{result.status === 'unprobed' ? 'Not checked yet' : result.output}</span>
        </span>
      </CardDescription>
    </CardHeader>
    {check.trust?.status === 'changed' ? <CardContent><CommandDiff trust={check.trust} /></CardContent> : null}
    <CardFooter className="flex-wrap gap-1.5">
      {result.status === 'fail' && onFix ? <Button variant="secondary" size="compact" leadingIcon={ToolIcon} onClick={onFix}>Ask agent to fix</Button> : null}
      {check.trust ? <>{trustBadge(check.trust)}<Button variant={check.trust.status === 'approved' ? 'ghost' : 'secondary'} size="compact" leadingIcon={check.trust.status === 'approved' ? undefined : ShieldIcon} onClick={check.trust.status === 'approved' ? onRevoke : onApprove}>{check.trust.status === 'approved' ? 'Revoke approval' : 'Approve'}</Button></> : null}
      <span className="ml-auto flex items-center gap-1"><Button variant="ghost" size="compact" leadingIcon={EditIcon} onClick={onEdit}>Edit</Button><Button variant="ghost" size="compact" leadingIcon={TrashIcon} onClick={onDelete}>Remove</Button></span>
    </CardFooter>
  </Card>;
}

const BUILT_IN_CHECKS: Record<string, EnvironmentCheckDefinition> = {
  vercel: { id: 'vercel', label: 'Vercel CLI', source: 'catalog', probe: 'vercel whoami', fix: 'vercel login' },
  node: { id: 'node', label: 'Node.js', source: 'catalog', requirement: '>= 22' },
  postgres: { id: 'postgres', label: 'Postgres', source: 'catalog', probe: 'pg_isready', fix: 'Start Postgres.' },
};

function AddCheckDialog({ open, onOpenChange, onAdd }: { open: boolean; onOpenChange(open: boolean): void; onAdd(check: EnvironmentCheckDefinition): void }) {
  const [kind, setKind] = useState<'built-in' | 'custom'>('built-in');
  const [builtIn, setBuiltIn] = useState('vercel');
  const [label, setLabel] = useState('');
  const [probe, setProbe] = useState('');
  const add = (): void => {
    if (kind === 'built-in') {
      const check = BUILT_IN_CHECKS[builtIn];
      if (check) onAdd(check);
    } else {
      const id = label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      if (!id || !probe.trim()) return;
      onAdd({ id, label: label.trim(), source: 'custom', probe: probe.trim() });
    }
    onOpenChange(false);
  };
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent size="sm">
      <DialogHeader><DialogTitle>Add check</DialogTitle><DialogDescription>Choose a GitSpace-built check for a common tool, or provide a project command.</DialogDescription></DialogHeader>
      <div className="flex flex-col gap-3">
        <Select value={kind} onValueChange={(value) => setKind(value as 'built-in' | 'custom')}><SelectTrigger aria-label="Check type" /><SelectContent><SelectItem value="built-in" index={0}>Built-in check</SelectItem><SelectItem value="custom" index={1}>Custom command</SelectItem></SelectContent></Select>
        {kind === 'built-in'
          ? <><Select value={builtIn} onValueChange={setBuiltIn}><SelectTrigger aria-label="Built-in check" /><SelectContent>{Object.values(BUILT_IN_CHECKS).map((check, index) => <SelectItem key={check.id} value={check.id} index={index}>{check.label}</SelectItem>)}</SelectContent></Select><p className="text-caption text-muted-foreground">Built-in checks verify installation and, when applicable, login or service readiness.</p></>
          : <><InputGroup><InputField index={0} label="Name" value={label} onChange={setLabel} placeholder="Redis ready" /><InputField index={1} label="Command" value={probe} onChange={setProbe} placeholder="redis-cli ping" /></InputGroup><p className="text-caption text-muted-foreground">The exact project command must be approved before it can run.</p></>}
      </div>
      <DialogFooter><Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button><Button variant="primary" disabled={kind === 'custom' && (!label.trim() || !probe.trim())} onClick={add}>Add</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}

function AddValueDialog({ open, onOpenChange, onAdd }: { open: boolean; onOpenChange(open: boolean): void; onAdd(name: string, defaultValue: string): void }) {
  const [name, setName] = useState('');
  const [defaultValue, setDefaultValue] = useState('');
  const add = (): void => {
    if (!name.trim()) return;
    onAdd(name.trim(), defaultValue);
    onOpenChange(false);
  };
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent size="sm">
      <DialogHeader><DialogTitle>Add value</DialogTitle><DialogDescription>Declare visible configuration required by this runtime profile.</DialogDescription></DialogHeader>
      <InputGroup><InputField index={0} label="Name" value={name} onChange={(next) => setName(next.toUpperCase())} placeholder="API_ORIGIN" /><InputField index={1} label="Default value" value={defaultValue} onChange={setDefaultValue} placeholder="https://api.example.com" /></InputGroup>
      <DialogFooter><Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button><Button variant="primary" disabled={!name.trim()} onClick={add}>Add</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}

function EditCheckDialog({ check, open, onOpenChange, onSave }: { check: EnvironmentCheckDefinition | null; open: boolean; onOpenChange(open: boolean): void; onSave(patch: Partial<Pick<EnvironmentCheckDefinition, 'label' | 'probe' | 'requirement'>>): void }) {
  const [label, setLabel] = useState(check?.label ?? '');
  const [probe, setProbe] = useState(check?.probe ?? '');
  const [requirement, setRequirement] = useState(check?.requirement ?? '');
  if (!check) return null;
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent size="sm">
      <DialogHeader><DialogTitle>Edit {check.label}</DialogTitle><DialogDescription>{check.source === 'catalog' ? 'GitSpace owns the probe. You can change the label and version requirement.' : 'Changing the command invalidates its existing approval.'}</DialogDescription></DialogHeader>
      <InputGroup><InputField index={0} label="Label" value={label} onChange={setLabel} />{check.source === 'custom' ? <InputField index={1} label="Command" value={probe} onChange={setProbe} /> : null}<InputField index={2} label="Version requirement" value={requirement} onChange={setRequirement} placeholder=">= 1.3" /></InputGroup>
      <DialogFooter><Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button><Button variant="primary" onClick={() => { onSave({ label, probe: check.source === 'custom' ? probe : check.probe, requirement }); onOpenChange(false); }}>Save</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}

function EnvironmentValueField({ name, value, disabled, onSave }: { name: string; value: string; disabled: boolean; onSave(value: string): void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const displayed = draft ?? value;
  return <div className="flex items-end gap-2"><InputGroup className="min-w-0 flex-1"><InputField index={0} label={name} value={displayed} onChange={setDraft} /></InputGroup><Button variant="secondary" size="compact" className="min-h-10" disabled={disabled || displayed === value} onClick={() => onSave(displayed)}>Save</Button></div>;
}

function LifecycleCard({ script, disabled, onApprove, onRevoke, onOpenFile, onOpenOutput, index }: { script: LifecycleScript; disabled: boolean; onApprove(): void; onRevoke(): void; onOpenFile?: () => void; onOpenOutput?: () => void; index?: number }) {
  const run = script.lastRun;
  return <Card size="compact" index={index}>
    <CardHeader>
      <CardTitle>{onOpenFile ? <Button variant="ghost" size="compact" className="-ml-2 min-h-10 justify-start break-all font-mono" leadingIcon={FileIcon} onClick={onOpenFile}>{script.path.replace(`${script.phase}/`, '')}</Button> : <code className="break-all font-mono text-caption">{script.path}</code>}</CardTitle>
      <CardDescription><span className="flex flex-wrap items-center gap-1.5">{run.status === 'never' ? 'Never run' : <span className={run.status === 'failed' ? 'text-destructive' : undefined}>{run.status} · <span className="tabular-nums">{run.relativeTime}{'duration' in run ? ` · ${run.duration}` : ''}</span></span>}<Badge size="compact" color={script.profiles ? 'blue' : 'gray'}>{script.profiles ? `${script.profiles.join(', ')} only` : 'all profiles'}</Badge></span></CardDescription>
    </CardHeader>
    {script.trust.status === 'changed' ? <CardContent><CommandDiff trust={script.trust} /></CardContent> : null}
    <CardFooter className="flex-wrap gap-1.5">
      <Badge size="compact" color={RUN_COLOR[run.status]}>{run.status}</Badge>
      {trustBadge(script.trust)}
      <Button variant={script.trust.status === 'approved' ? 'ghost' : 'secondary'} size="compact" className="min-h-10" disabled={disabled} onClick={script.trust.status === 'approved' ? onRevoke : onApprove}>{script.trust.status === 'approved' ? 'Revoke' : 'Review & approve'}</Button>
      {run.status !== 'never' && onOpenOutput ? <Button variant="ghost" size="compact" className="min-h-10" leadingIcon={TerminalIcon} onClick={onOpenOutput}>View log</Button> : null}
    </CardFooter>
  </Card>;
}

export function EnvironmentView({ model, busy = false, runtimeAvailable = true, cloudRunnerAvailable = runtimeAvailable, onConfigure, onRecoverRun, onOpenRunLog, onProfileChange, onApprove, onRevoke, onGrantSecret, onInputChange, onFixCheck, onUpdateCheck, onDeleteCheck, onAddCheck, onAddValue, onOpenSecrets, onOpenLifecycleFile, onOpenLifecycleOutput, onRunChecks, onRunLifecycle }: EnvironmentViewProps) {
  const shape = useShape();
  const [addCheckOpen, setAddCheckOpen] = useState(false);
  const [addValueOpen, setAddValueOpen] = useState(false);
  const [editingCheck, setEditingCheck] = useState<EnvironmentCheckDefinition | null>(null);
  const [removingCheck, setRemovingCheck] = useState<EnvironmentCheckDefinition | null>(null);
  const [confirmation, setConfirmation] = useState<{ phase: LifecyclePhase; rerun: boolean } | null>(null);
  const [recovery, setRecovery] = useState<string | null>(null);
  const selectedProfile = profileDefinition(model.workspace.profile, model.bundle.profiles);
  const machine = model.machines.find((candidate) => candidate.id === model.workspace.machineId) ?? model.machines[0];
  const checks = selectedProfile.checks.map((id) => model.bundle.checks[id]).filter((check): check is EnvironmentCheckDefinition => !!check);
  const visibleLifecycle = model.lifecycle.filter((script) => !script.profiles || script.profiles.includes(model.workspace.profile));
  const lifecycleNeedsApproval = visibleLifecycle.some((script) => script.trust.status !== 'approved');
  const lifecycleFailed = visibleLifecycle.some((script) => script.lastRun.status === 'failed');
  const summary = model.ledger ? lifecycleSummary(model.ledger) : { label: lifecycleFailed ? 'Environment needs attention' : lifecycleNeedsApproval ? 'Environment needs approval' : 'Environment', attention: lifecycleFailed || lifecycleNeedsApproval };
  const readOnly = busy || !runtimeAvailable;
  const requestPhase = (phase: LifecyclePhase, rerun: boolean): void => {
    if (phase === 'cloud/destroy' || rerun) setConfirmation({ phase, rerun });
    else onRunLifecycle(phase);
  };

  return <ScrollArea className="min-h-0 flex-1" viewportClassName="h-full">
    <div className="flex flex-col gap-5 p-4">
      <header className="flex flex-col gap-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <span className="text-caption text-muted-foreground">{model.project.name} · {model.workspace.name}</span>
            <h2 className="text-title font-semibold text-foreground text-balance">Workspace environment</h2>
            <p className="text-caption text-muted-foreground text-pretty">Durable resources and local preparation. Your workspace stays accessible if preparation fails.</p>
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-caption font-medium text-muted-foreground">Runtime profile</span>
          <Select value={model.workspace.profile} onValueChange={onProfileChange} disabled={readOnly}>
            <SelectTrigger aria-label="Runtime profile" />
            <SelectContent>{Object.keys(model.bundle.profiles).map((name, index) => <SelectItem key={name} value={name} index={index}>{name}{name === model.bundle.default ? ' · default' : ''}</SelectItem>)}</SelectContent>
          </Select>
          <p className="text-caption text-muted-foreground">Choose the kind of work this workspace needs to run.</p>
        </div>
        <div className="flex items-center gap-2 text-caption text-muted-foreground" role="status">
          <StatusDot color={summary.attention ? 'orange' : 'dim'} />
          <span>{summary.label}{runtimeAvailable ? ` · ${machine?.label ?? 'current machine'}` : ' · saved cloud state'}</span>
        </div>
      </header>
      {model.configured === false ? <section className="flex flex-wrap items-center justify-between gap-2 text-caption text-muted-foreground" aria-label="Repository environment configuration">
        <p className="max-w-prose text-pretty">No repository lifecycle configured. Keep working, or ask the agent to plan one with you.</p>
        {onConfigure ? <Button variant="ghost" size="compact" className="min-h-10" disabled={busy} onClick={onConfigure}>Configure with agent</Button> : <span>Open this workspace to configure with the agent.</span>}
      </section> : null}
      {model.migrationRequired?.length ? <p role="status" className="text-caption text-destructive text-pretty">Lifecycle migration required: {model.migrationRequired.join(', ')}. These legacy scripts will not execute. Ask the agent to migrate them.</p> : null}
      {!runtimeAvailable ? <p className="text-caption text-muted-foreground text-pretty">{model.ledger?.destroyedAt ? 'Cloud resources were explicitly retired. Their history, recorded bindings, and logs remain available.' : 'History, bindings, and logs are available while closed. Choose an online runner for explicit cloud retirement, or open the workspace for setup and local preparation.'}</p> : null}
      {model.ledger ? <section className="flex flex-col gap-2" aria-label="Durable environment state">
        <div className="flex flex-wrap gap-2"><Badge size="compact" color={model.ledger.provisioned && !model.ledger.destroyedAt ? 'green' : 'gray'}>{model.ledger.destroyedAt ? 'Resources retired' : model.ledger.provisioned ? 'Provisioned' : 'Not provisioned'}</Badge><Badge size="compact" color="gray">{model.ledger.policy.automatic ? 'Automatic local preparation enabled' : model.ledger.destroyedAt || model.ledger.provisioned ? 'Automatic local preparation disabled' : 'Initial setup not requested'}</Badge></div>
        {model.ledger.provisioned ? <p className="text-caption text-muted-foreground tabular-nums">Last successful provision · {model.ledger.provisioned.profile} · {new Date(model.ledger.provisioned.completedAt).toLocaleString()} · {model.ledger.provisioned.machineId}. Preserved across moves and failed reruns.</p> : null}
        {model.ledger.claim?.status === 'blocked' && model.ledger.claim.reason ? <p role="status" className="text-caption text-destructive">{model.ledger.claim.reason}</p> : null}
        <h3 className="text-caption font-medium">Resource bindings</h3>
        {Object.keys(model.ledger.bindings).length ? <dl className={`${shape.container} grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-x-3 gap-y-2 bg-surface-2 p-3 text-caption shadow-surface-1`}>{Object.entries(model.ledger.bindings).map(([name, value]) => <div className="contents" key={name}><dt className="break-all font-mono text-muted-foreground">{name}</dt><dd className="break-all font-mono">{value}</dd></div>)}</dl> : <p className="text-caption text-muted-foreground">No bindings recorded. Partial outputs remain here even when a run fails.</p>}
      </section> : null}

      {selectedProfile.notes ? <Elevated offset={1} className={`${shape.container} flex items-start gap-3 p-3`}>
        <AlertIcon size={16} strokeWidth={1.5} className="mt-0.5 shrink-0 text-muted-foreground" />
        <p className="min-w-0 text-body text-muted-foreground">{selectedProfile.notes}</p>
      </Elevated> : null}

      <fieldset disabled={readOnly} className="contents">
      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2"><h3 className="text-caption font-medium text-muted-foreground">Checks · <span className="tabular-nums">{checks.length}</span></h3><span className="flex items-center gap-1"><Button variant="ghost" size="compact" leadingIcon={PlayIcon} onClick={onRunChecks}>Run checks</Button><Button variant="secondary" size="compact" leadingIcon={PlusIcon} onClick={() => setAddCheckOpen(true)}>Add check</Button></span></div>
        <CardGroup border="outlined" separated proximityHover={false}>{checks.map((check, index) => <CheckCard key={check.id} index={index} check={check} result={machine?.capabilities[check.id] ?? { status: 'unprobed' }} onApprove={() => onApprove(check.id)} onRevoke={() => onRevoke(check.id)} onFix={onFixCheck ? () => onFixCheck(check.id) : undefined} onEdit={() => setEditingCheck(check)} onDelete={() => setRemovingCheck(check)} />)}</CardGroup>
      </section>

      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2"><h3 className="text-caption font-medium text-muted-foreground">Secrets</h3><Button variant="ghost" size="compact" onClick={onOpenSecrets}>Manage secrets & values</Button></div>
        <CardGroup border="outlined" separated proximityHover={false}>{selectedProfile.secrets.map((name, index) => {
          const secret = model.secrets.find((candidate) => candidate.name === name);
          const granted = secret?.granted ?? false;
          return <Card key={name} size="compact" index={index}>
            <CardHeader className="py-2.5"><CardTitle><span className="flex items-center gap-2"><KeyIcon size={16} strokeWidth={1.5} className="text-muted-foreground" /><code className="min-w-0 truncate font-mono text-body">{name}</code><Badge className="ml-auto" size="compact" color={granted ? 'green' : 'red'}>{granted ? `${secret?.source} secret` : 'missing'}</Badge>{!granted ? <Button variant="secondary" size="compact" onClick={() => onGrantSecret(name)}>Add or grant</Button> : null}</span></CardTitle></CardHeader>
          </Card>;
        })}</CardGroup>
      </section>

      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2"><h3 className="text-caption font-medium text-muted-foreground">Values</h3><Button variant="secondary" size="compact" leadingIcon={PlusIcon} onClick={() => setAddValueOpen(true)}>Add value</Button></div>
        {selectedProfile.inputs.length ? <><div className="flex flex-col gap-2">{selectedProfile.inputs.map((name) => {
          const input = model.inputValues.find((candidate) => candidate.name === name);
          return <EnvironmentValueField key={`${model.workspace.profile}:${name}`} name={name} value={input?.value ?? model.bundle.inputs[name]?.default ?? ''} disabled={readOnly} onSave={(value) => onInputChange(name, value)} />;
        })}</div>
        <div className="flex flex-wrap gap-1">{selectedProfile.inputs.map((name) => { const input = model.inputValues.find((candidate) => candidate.name === name); return <Badge key={name} size="compact" color={input?.source === 'workspace' ? 'blue' : 'gray'}>{input?.source === 'workspace' ? 'set for this workspace' : 'inherited from project'}</Badge>; })}</div></> : <p className="text-caption text-muted-foreground">No values declared for this profile.</p>}
      </section>
      </fieldset>

      <section className="flex flex-col gap-4" aria-label="Lifecycle phases">
        <div className="flex flex-col gap-1"><h3 className="text-caption font-medium text-muted-foreground">Lifecycle scripts</h3><p className="text-caption text-muted-foreground"><code className="font-mono">01-base.sh</code> runs for every profile. <code className="font-mono">01-base.ios.sh</code> runs only for ios.</p></div>
        {LIFECYCLE_PHASES.map((phase) => {
          const scripts = visibleLifecycle.filter((script) => script.phase === phase);
          const latest = model.ledger ? latestLifecycleRun(model.ledger, phase, model.workspace) : undefined;
          const running = latest?.status === 'running';
          const approved = scripts.every((script) => script.trust.status === 'approved');
          const succeeded = phase === 'cloud/provision' ? !!model.ledger?.provisioned : latest?.status === 'succeeded';
          const contentMatches = latest && scripts.length === latest.executionHashes.length && scripts.every((script) => latest.executionHashes.includes(script.trust.commandHash));
          const readiness = !scripts.length ? 'No scripts' : !approved ? 'Awaiting approval' : running ? 'Running' : latest?.status === 'failed' || latest?.status === 'abandoned' ? 'Needs attention' : succeeded && (phase !== 'machine/prepare' || contentMatches) ? 'Completed for this scope' : 'Not run for this scope';
          const action = phase === 'cloud/destroy' ? 'Retire resources…' : succeeded ? 'Rerun explicitly…' : latest?.status === 'failed' || latest?.status === 'abandoned' ? 'Retry explicitly…' : phase === 'cloud/provision' ? 'Request initial setup' : 'Run phase';
          return <div key={phase} className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="text-body font-medium text-foreground">{PHASE_LABEL[phase]}</h4><Button variant="ghost" size="compact" className="min-h-10" loading={running} disabled={busy || running || !(phase === 'cloud/destroy' ? cloudRunnerAvailable : runtimeAvailable) || !approved || !scripts.length && phase !== 'cloud/provision' || !!model.ledger?.destroyedAt || !!model.migrationRequired?.length} leadingIcon={phase === 'cloud/destroy' ? TrashIcon : PlayIcon} onClick={() => requestPhase(phase, succeeded || latest?.status === 'failed' || latest?.status === 'abandoned')}>{action}</Button></div>
            <p className="text-caption text-muted-foreground text-pretty"><code className="font-mono">{phase}</code> · {PHASE_SCOPE[phase]}</p>
            <span role="status" className={`text-caption ${readiness === 'Needs attention' ? 'text-destructive' : 'text-muted-foreground'}`}>{readiness}</span>
            <CardGroup border="outlined" separated proximityHover={false}>{scripts.map((script, index) => <LifecycleCard key={script.id} index={index} script={script} disabled={busy} onApprove={() => onApprove(script.id)} onRevoke={() => onRevoke(script.id)} onOpenFile={onOpenLifecycleFile ? () => onOpenLifecycleFile(script.id) : undefined} onOpenOutput={onOpenLifecycleOutput ? () => onOpenLifecycleOutput(script.id) : undefined} />)}</CardGroup>
          </div>;
        })}
      </section>

      {model.ledger ? <section className="flex flex-col gap-3" aria-label="Lifecycle history">
        <h3 className="text-caption font-medium text-muted-foreground">Run history · <span className="tabular-nums">{model.ledger.runs.length}</span></h3>
        {!model.ledger.runs.length ? <p className="text-caption text-muted-foreground">No runs recorded.</p> : model.ledger.runs.map((run) => <details key={run.id} className={`${shape.container} bg-surface-2 px-3 shadow-surface-1`}>
          <summary className="min-h-10 cursor-pointer py-3 text-caption"><span className="font-medium">{run.phase}</span> · {run.status} · <span className="tabular-nums">{new Date(run.startedAt).toLocaleString()}</span></summary>
          <div className="flex min-w-0 flex-col gap-2 pb-3">
            <p className="break-all text-caption text-muted-foreground">{run.profile} · {run.machineId} · <span className="tabular-nums">checkout {run.generation ?? 'not scoped'}{run.exitCode !== null ? ` · exit ${run.exitCode}` : ''}</span></p>
            <code className="break-all text-caption text-muted-foreground">{run.id}</code>
            {run.output ? <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-caption">{run.output}</pre> : <p className="text-caption text-muted-foreground">No output recorded.</p>}
            <div className="flex flex-wrap gap-2">{onOpenRunLog ? <Button variant="ghost" size="compact" className="min-h-10" onClick={() => onOpenRunLog(run.id)}>Read full log</Button> : null}{run.status === 'running' && onRecoverRun ? <Button variant="ghost" size="compact" className="min-h-10" disabled={busy} onClick={() => setRecovery(run.id)}>Recover abandoned run…</Button> : null}</div>
          </div>
        </details>)}
      </section> : null}

      <p className="text-caption text-muted-foreground">Machine compatibility and placement live under <strong className="font-medium text-foreground">Machines</strong>, not in this workspace editor.</p>
      <AddCheckDialog open={addCheckOpen} onOpenChange={setAddCheckOpen} onAdd={onAddCheck} />
      <AddValueDialog open={addValueOpen} onOpenChange={setAddValueOpen} onAdd={onAddValue} />
      <EditCheckDialog key={editingCheck ? `${editingCheck.id}-${editingCheck.probe ?? ''}` : 'none'} check={editingCheck} open={!!editingCheck} onOpenChange={(open) => { if (!open) setEditingCheck(null); }} onSave={(patch) => { if (editingCheck) onUpdateCheck(editingCheck.id, patch); }} />
      <Dialog open={!!removingCheck} onOpenChange={(open) => { if (!open) setRemovingCheck(null); }}>
        <DialogContent size="sm"><DialogHeader><DialogTitle>Remove {removingCheck?.label}?</DialogTitle><DialogDescription>This removes the check from the {model.workspace.profile} runtime profile.</DialogDescription></DialogHeader><DialogFooter><Button variant="secondary" onClick={() => setRemovingCheck(null)}>Cancel</Button><Button variant="primary" onClick={() => { if (removingCheck) onDeleteCheck(removingCheck.id); setRemovingCheck(null); }}>Remove</Button></DialogFooter></DialogContent>
      </Dialog>
      <Dialog open={confirmation !== null} onOpenChange={(open) => { if (!open) setConfirmation(null); }}>
        <DialogContent size="sm"><DialogHeader><DialogTitle>{confirmation?.phase === 'cloud/destroy' ? 'Retire this workspace’s cloud resources?' : 'Explicitly rerun this phase?'}</DialogTitle><DialogDescription>{confirmation?.phase === 'cloud/destroy' ? 'This authorizes the approved cloud/destroy scripts to delete the resources recorded for this workspace. It is not a close or move. Check the bindings and script content first; deletion may be irreversible.' : 'A previous attempt may already have changed external resources. Review its logs and bindings before running again. This does not replace the last successful provision record unless the new provision succeeds.'}</DialogDescription></DialogHeader><DialogFooter><Button variant="secondary" onClick={() => setConfirmation(null)}>Cancel</Button><Button variant="primary" disabled={busy} onClick={() => { if (confirmation) onRunLifecycle(confirmation.phase, { rerun: confirmation.rerun, retire: confirmation.phase === 'cloud/destroy' }); setConfirmation(null); }}>{confirmation?.phase === 'cloud/destroy' ? 'Approve retirement & run' : 'Rerun phase'}</Button></DialogFooter></DialogContent>
      </Dialog>
      <Dialog open={recovery !== null} onOpenChange={(open) => { if (!open) setRecovery(null); }}>
        <DialogContent size="sm"><DialogHeader><DialogTitle>Recover an abandoned run?</DialogTitle><DialogDescription>Recovery revokes this run’s claim without rerunning it. The cloud accepts recovery only when its owning machine is confirmed destroyed; an offline machine could still be executing. Inspect external resources and partial bindings before explicitly retrying.</DialogDescription></DialogHeader><DialogFooter><Button variant="secondary" onClick={() => setRecovery(null)}>Cancel</Button><Button variant="primary" disabled={busy} onClick={() => { if (recovery) onRecoverRun?.(recovery); setRecovery(null); }}>Mark run abandoned</Button></DialogFooter></DialogContent>
      </Dialog>
    </div>
  </ScrollArea>;
}
