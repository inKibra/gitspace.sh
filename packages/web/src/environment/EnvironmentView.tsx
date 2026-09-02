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
import type { CapabilityResult, EnvironmentCheckDefinition, EnvironmentProfileDefinition, EnvironmentViewProps, LifecycleRun, LifecycleScript, TrustState } from './types.js';

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
const RUN_COLOR: Record<LifecycleRun['status'], NonNullable<BadgeProps['color']>> = { succeeded: 'green', failed: 'red', never: 'gray' };
const PHASE_LABEL: Record<LifecycleScript['phase'], string> = { setup: 'Setup', select: 'Select', remove: 'Remove' };

function profileDefinition(profileName: string, profiles: Record<string, EnvironmentProfileDefinition>): EnvironmentProfileDefinition {
  const profile = profiles[profileName];
  if (!profile) return { checks: [], secrets: [], inputs: [], notes: '' };
  if (!profile.extends) return profile;
  const parent = profileDefinition(profile.extends, profiles);
  return {
    checks: [...parent.checks, ...profile.checks],
    secrets: [...parent.secrets, ...profile.secrets],
    inputs: [...parent.inputs, ...profile.inputs],
    notes: profile.notes,
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

function CheckCard({ check, result, onApprove, onRevoke, onFix, onEdit, onDelete, index }: { check: EnvironmentCheckDefinition; result: CapabilityResult; onApprove(): void; onRevoke(): void; onFix(): void; onEdit(): void; onDelete(): void; index?: number }) {
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
      {result.status === 'fail' ? <Button variant="secondary" size="compact" leadingIcon={ToolIcon} onClick={onFix}>Fix in terminal</Button> : null}
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
      onAdd({ id, label: label.trim(), source: 'custom', probe: probe.trim(), trust: { status: 'pending', commandHash: `sha256:mock-${id}` } });
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

function LifecycleCard({ script, onApprove, onRevoke, onOpenFile, onOpenOutput, index }: { script: LifecycleScript; onApprove(): void; onRevoke(): void; onOpenFile(): void; onOpenOutput(): void; index?: number }) {
  const run = script.lastRun;
  return <Card size="compact" index={index}>
    <CardHeader>
      <CardTitle><Button variant="ghost" size="compact" className="-ml-2 justify-start font-mono" leadingIcon={FileIcon} onClick={onOpenFile}>{script.path.replace(`${script.phase}/`, '')}</Button></CardTitle>
      <CardDescription><span className="flex flex-wrap items-center gap-1.5">{run.status === 'never' ? 'Never run' : <span className={run.status === 'failed' ? 'text-destructive' : undefined}>{run.status} · {run.relativeTime} · {run.duration}{run.output ? ` · ${run.output}` : ''}</span>}<Badge size="compact" color={script.profiles ? 'blue' : 'gray'}>{script.profiles ? `${script.profiles.join(', ')} only` : 'all profiles'}</Badge></span></CardDescription>
    </CardHeader>
    {script.trust.status === 'changed' ? <CardContent><CommandDiff trust={script.trust} /></CardContent> : null}
    <CardFooter className="flex-wrap gap-1.5">
      <Badge size="compact" color={RUN_COLOR[run.status]}>{run.status}</Badge>
      {trustBadge(script.trust)}
      <Button variant={script.trust.status === 'approved' ? 'ghost' : 'secondary'} size="compact" onClick={script.trust.status === 'approved' ? onRevoke : onApprove}>{script.trust.status === 'approved' ? 'Revoke' : 'Approve'}</Button>
      {run.status !== 'never' ? <Button variant="ghost" size="compact" leadingIcon={TerminalIcon} onClick={onOpenOutput}>Open terminal</Button> : null}
    </CardFooter>
  </Card>;
}

export function EnvironmentView({ model, onProfileChange, onApprove, onRevoke, onGrantSecret, onInputChange, onFixCheck, onUpdateCheck, onDeleteCheck, onAddCheck, onAddValue, onOpenSecrets, onOpenLifecycleFile, onOpenLifecycleOutput, onRunLifecycle }: EnvironmentViewProps) {
  const shape = useShape();
  const [addCheckOpen, setAddCheckOpen] = useState(false);
  const [addValueOpen, setAddValueOpen] = useState(false);
  const [editingCheck, setEditingCheck] = useState<EnvironmentCheckDefinition | null>(null);
  const [removingCheck, setRemovingCheck] = useState<EnvironmentCheckDefinition | null>(null);
  const selectedProfile = profileDefinition(model.workspace.profile, model.bundle.profiles);
  const machine = model.machines.find((candidate) => candidate.id === model.workspace.machineId) ?? model.machines[0];
  const checks = selectedProfile.checks.map((id) => model.bundle.checks[id]).filter((check): check is EnvironmentCheckDefinition => !!check);
  const visibleLifecycle = model.lifecycle.filter((script) => !script.profiles || script.profiles.includes(model.workspace.profile));
  const lifecycleNeedsApproval = visibleLifecycle.some((script) => script.trust.status !== 'approved');
  const lifecycleFailed = visibleLifecycle.some((script) => script.lastRun.status === 'failed');
  const setupSummary = lifecycleFailed ? 'needs attention' : lifecycleNeedsApproval ? 'needs approval' : 'ready';

  return <ScrollArea className="min-h-0 flex-1" viewportClassName="h-full">
    <div className="flex flex-col gap-5 p-4">
      <header className="flex flex-col gap-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <span className="text-caption text-muted-foreground">{model.project.name} · {model.workspace.name}</span>
            <h2 className="text-title font-semibold text-foreground">Workspace setup</h2>
            <p className="text-caption text-muted-foreground">Requirements declared by the project bundle</p>
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-caption font-medium text-muted-foreground">Runtime profile</span>
          <Select value={model.workspace.profile} onValueChange={onProfileChange}>
            <SelectTrigger aria-label="Runtime profile" />
            <SelectContent>{Object.keys(model.bundle.profiles).map((name, index) => <SelectItem key={name} value={name} index={index}>{name}{name === model.bundle.default ? ' · default' : ''}</SelectItem>)}</SelectContent>
          </Select>
          <p className="text-caption text-muted-foreground">Choose the kind of work this workspace needs to run.</p>
        </div>
        <div className="flex items-center gap-2 text-caption text-muted-foreground" role="status">
          <StatusDot color={lifecycleFailed ? 'red' : lifecycleNeedsApproval ? 'orange' : 'green'} />
          <span>On {machine?.label ?? 'unknown machine'} · <strong className={lifecycleFailed ? 'font-medium text-destructive' : 'font-medium text-foreground'}>{setupSummary}</strong></span>
        </div>
      </header>

      <Elevated offset={1} className={`${shape.container} flex items-start gap-3 p-3`}>
        <AlertIcon size={16} strokeWidth={1.5} className="mt-0.5 shrink-0 text-muted-foreground" />
        <div className="flex min-w-0 flex-col gap-1"><p className="text-body text-muted-foreground">{selectedProfile.notes}</p>{model.bundle.profiles[model.workspace.profile]?.extends ? <Badge size="compact" color="gray">extends {model.bundle.profiles[model.workspace.profile]?.extends}</Badge> : null}</div>
      </Elevated>

      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2"><h3 className="text-caption font-medium text-muted-foreground">Checks · <span className="tabular-nums">{checks.length}</span></h3><Button variant="secondary" size="compact" leadingIcon={PlusIcon} onClick={() => setAddCheckOpen(true)}>Add check</Button></div>
        <CardGroup border="outlined" separated proximityHover={false}>{checks.map((check, index) => <CheckCard key={check.id} index={index} check={check} result={machine?.capabilities[check.id] ?? { status: 'unprobed' }} onApprove={() => onApprove(check.id)} onRevoke={() => onRevoke(check.id)} onFix={() => onFixCheck(check.id)} onEdit={() => setEditingCheck(check)} onDelete={() => setRemovingCheck(check)} />)}</CardGroup>
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
        {selectedProfile.inputs.length ? <><InputGroup>{selectedProfile.inputs.map((name, index) => {
          const input = model.inputValues.find((candidate) => candidate.name === name);
          return <InputField key={name} index={index} label={name} value={input?.value ?? model.bundle.inputs[name]?.default ?? ''} onChange={(value) => onInputChange(name, value)} />;
        })}</InputGroup>
        <div className="flex flex-wrap gap-1">{selectedProfile.inputs.map((name) => { const input = model.inputValues.find((candidate) => candidate.name === name); return <Badge key={name} size="compact" color={input?.source === 'workspace' ? 'blue' : 'gray'}>{input?.source === 'workspace' ? 'set for this workspace' : 'inherited from project'}</Badge>; })}</div></> : <p className="text-caption text-muted-foreground">No values declared for this profile.</p>}
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex flex-col gap-1"><h3 className="text-caption font-medium text-muted-foreground">Lifecycle scripts</h3><p className="text-caption text-muted-foreground"><code className="font-mono">01-base.sh</code> runs for every profile. <code className="font-mono">01-base.ios.sh</code> runs only for ios.</p></div>
        {(['setup', 'select', 'remove'] as const).map((phase) => {
          const scripts = visibleLifecycle.filter((script) => script.phase === phase);
          return <div key={phase} className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2"><h4 className="text-caption font-medium text-foreground">{PHASE_LABEL[phase]}</h4><Button variant="ghost" size="compact" leadingIcon={PlayIcon} onClick={() => onRunLifecycle(phase)}>Run in terminal</Button></div>
            <CardGroup border="outlined" separated proximityHover={false}>{scripts.map((script, index) => <LifecycleCard key={script.id} index={index} script={script} onApprove={() => onApprove(script.id)} onRevoke={() => onRevoke(script.id)} onOpenFile={() => onOpenLifecycleFile(script.id)} onOpenOutput={() => onOpenLifecycleOutput(script.id)} />)}</CardGroup>
          </div>;
        })}
      </section>

      <p className="text-caption text-muted-foreground">Machine compatibility and placement live under <strong className="font-medium text-foreground">Machines</strong>, not in this workspace editor.</p>
      <AddCheckDialog open={addCheckOpen} onOpenChange={setAddCheckOpen} onAdd={onAddCheck} />
      <AddValueDialog open={addValueOpen} onOpenChange={setAddValueOpen} onAdd={onAddValue} />
      <EditCheckDialog key={editingCheck ? `${editingCheck.id}-${editingCheck.probe ?? ''}` : 'none'} check={editingCheck} open={!!editingCheck} onOpenChange={(open) => { if (!open) setEditingCheck(null); }} onSave={(patch) => { if (editingCheck) onUpdateCheck(editingCheck.id, patch); }} />
      <Dialog open={!!removingCheck} onOpenChange={(open) => { if (!open) setRemovingCheck(null); }}>
        <DialogContent size="sm"><DialogHeader><DialogTitle>Remove {removingCheck?.label}?</DialogTitle><DialogDescription>This removes the check from the {model.workspace.profile} runtime profile.</DialogDescription></DialogHeader><DialogFooter><Button variant="secondary" onClick={() => setRemovingCheck(null)}>Cancel</Button><Button variant="primary" onClick={() => { if (removingCheck) onDeleteCheck(removingCheck.id); setRemovingCheck(null); }}>Remove</Button></DialogFooter></DialogContent>
      </Dialog>
    </div>
  </ScrollArea>;
}
