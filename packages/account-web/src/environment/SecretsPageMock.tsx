import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownContent,
  DropdownMenu,
  DropdownSeparator,
  DropdownTrigger,
  Elevated,
  InputField,
  InputGroup,
  MenuItem,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  useShape,
} from '@gitspace/ui';
import { AlertTriangle, ChevronDown, Key01, Plus, ShieldTick, X } from '@untitledui/icons';
import { useState } from 'react';
import { PageCanvas, PageHeader } from '../GitSpaceShell.js';
import { glyph } from '../glyph.js';
import type { SecretsPageViewModel, TrustState } from './types.js';

const AlertIcon = glyph(AlertTriangle);
const ChevronIcon = glyph(ChevronDown);
const KeyIcon = glyph(Key01);
const PlusIcon = glyph(Plus);
const ShieldIcon = glyph(ShieldTick);

type SecretScope = 'global' | 'project';

export interface SecretsPageMockProps {
  model: SecretsPageViewModel;
  onProjectChange(project: string): void;
  onGrant(secretName: string, project: string): void;
  onRevoke(secretName: string, project: string): void;
  onAddSecret(name: string, scope: SecretScope, project?: string): void;
  onUpdateValue(name: string, value: string, project: string): void;
  onAddValue(name: string, value: string, project: string): void;
}

function GrantMenu({ name, projects, onGrant }: { name: string; projects: readonly string[]; onGrant(project: string): void }) {
  return <DropdownMenu>
    <DropdownTrigger render={<Button variant="secondary" size="compact" trailingIcon={ChevronIcon} aria-label={`Grant ${name} to a project`}>Grant to project</Button>} />
    <DropdownContent align="end">
      {projects.map((project, index) => <MenuItem key={project} index={index} label={project} onSelect={() => onGrant(project)} />)}
      <DropdownSeparator />
      <MenuItem index={projects.length} icon={PlusIcon} label="New project…" onSelect={() => undefined} />
    </DropdownContent>
  </DropdownMenu>;
}

function AddSecretDialog({ open, initialName, initialScope, selectedProject, projects, onOpenChange, onAdd }: { open: boolean; initialName: string; initialScope: SecretScope; selectedProject: string; projects: readonly string[]; onOpenChange(open: boolean): void; onAdd(name: string, scope: SecretScope, project?: string): void }) {
  const [name, setName] = useState(initialName);
  const [value, setValue] = useState('');
  const [scope, setScope] = useState<SecretScope>(initialScope);
  const [project, setProject] = useState(selectedProject);
  const save = (): void => {
    const secretName = name.trim().toUpperCase();
    if (!secretName || !value) return;
    onAdd(secretName, scope, scope === 'project' ? project : undefined);
    setValue('');
    onOpenChange(false);
  };
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent size="sm">
      <DialogHeader><DialogTitle>Add secret</DialogTitle><DialogDescription>Store the value globally for selective project grants, or only on one project.</DialogDescription></DialogHeader>
      <InputGroup>
        <InputField index={0} label="Name" value={name} onChange={(next) => setName(next.toUpperCase())} placeholder="DATABASE_URL" />
        <InputField index={1} label="Value" type="password" value={value} onChange={setValue} placeholder="Secret value" autoComplete="new-password" />
      </InputGroup>
      <div className="mt-3 flex flex-col gap-2">
        <span className="text-caption font-medium text-muted-foreground">Store in</span>
        <Select value={scope} onValueChange={(next) => setScope(next as SecretScope)}>
          <SelectTrigger aria-label="Secret scope" />
          <SelectContent><SelectItem value="global" index={0}>Global secrets</SelectItem><SelectItem value="project" index={1}>Project secrets</SelectItem></SelectContent>
        </Select>
        {scope === 'project' ? <Select value={project} onValueChange={setProject}><SelectTrigger aria-label="Secret project" /><SelectContent>{projects.map((candidate, index) => <SelectItem key={candidate} value={candidate} index={index}>{candidate}</SelectItem>)}</SelectContent></Select> : <p className="text-caption text-muted-foreground">You can grant it to projects after saving. The value stays hidden.</p>}
      </div>
      <DialogFooter><Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button><Button variant="primary" leadingIcon={PlusIcon} disabled={!name.trim() || !value} onClick={save}>Save secret</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}

export function SecretsPageMock({ model, onProjectChange, onGrant, onRevoke, onAddSecret, onUpdateValue, onAddValue }: SecretsPageMockProps) {
  const shape = useShape();
  const [addState, setAddState] = useState<{ open: boolean; name: string; scope: SecretScope }>({ open: false, name: '', scope: 'global' });
  const [addingValue, setAddingValue] = useState(false);
  const [valueName, setValueName] = useState('');
  const [valueValue, setValueValue] = useState('');
  const visibleProjectSecrets = model.projectSecrets.filter((secret) => secret.project === model.selectedProject);
  const visibleProjectValues = model.projectValues.filter((value) => value.project === model.selectedProject);
  const openAdd = (name = '', scope: SecretScope = 'global'): void => setAddState({ open: true, name, scope });
  return <PageCanvas>
    <PageHeader kicker="Account & project configuration" title="Secrets & values" description="Store sensitive values as write-only secrets and ordinary configuration as visible values." actions={<Button variant="primary" leadingIcon={PlusIcon} onClick={() => openAdd()}>Add secret</Button>} />
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-3">
        <div className="flex flex-col gap-1"><h2 className="text-subtitle font-semibold text-foreground">Global secrets</h2><p className="text-caption text-muted-foreground">Stored once in your account. Each project needs an explicit grant.</p></div>
        <Table>
          <TableHeader><TableRow><TableHead>Name</TableHead><TableHead>Updated</TableHead><TableHead>Project grants</TableHead><TableHead><span className="sr-only">Actions</span></TableHead></TableRow></TableHeader>
          <TableBody>{model.userSecrets.map((secret, index) => <TableRow key={secret.name} index={index}>
            <TableCell><span className="flex items-center gap-2"><KeyIcon size={16} strokeWidth={1.5} className="shrink-0 text-muted-foreground" /><code className="font-mono font-medium text-foreground">{secret.name}</code>{secret.unused ? <Badge size="compact" color="gray">unused</Badge> : null}</span></TableCell>
            <TableCell><span className="tabular-nums text-muted-foreground">{secret.updated}</span></TableCell>
            <TableCell><span className="flex flex-wrap gap-1">{secret.projects.length ? secret.projects.map((project) => <span key={project} className="inline-flex items-center rounded-full bg-accent px-2 text-caption text-accent-foreground"><span>{project}</span><Button variant="ghost" size="icon-compact" aria-label={`Revoke ${secret.name} from ${project}`} className="-mr-1 ml-0.5" onClick={() => onRevoke(secret.name, project)}><X width={12} height={12} strokeWidth={1.5} /></Button></span>) : <span className="text-caption text-muted-foreground">No grants</span>}</span></TableCell>
            <TableCell className="text-right"><GrantMenu name={secret.name} projects={model.projects.filter((project) => !secret.projects.includes(project))} onGrant={(project) => onGrant(secret.name, project)} /></TableCell>
          </TableRow>)}</TableBody>
        </Table>
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex items-end justify-between gap-4">
          <div className="flex flex-col gap-1"><h2 className="text-subtitle font-semibold text-foreground">Project secrets</h2><p className="text-caption text-muted-foreground">Stored only on the selected project. A project value overrides a global grant with the same name.</p></div>
          <Select value={model.selectedProject} onValueChange={onProjectChange}>
            <SelectTrigger aria-label="Project" />
            <SelectContent>{model.projects.map((project, index) => <SelectItem key={project} value={project} index={index}>{project}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <Table>
          <TableHeader><TableRow><TableHead>Name</TableHead><TableHead>Updated</TableHead><TableHead>Needed by profiles</TableHead><TableHead>Resolution</TableHead></TableRow></TableHeader>
          <TableBody>{visibleProjectSecrets.map((secret, index) => <TableRow key={secret.name} index={index}>
            <TableCell><code className="font-mono font-medium text-foreground">{secret.name}</code></TableCell>
            <TableCell><span className="tabular-nums text-muted-foreground">{secret.updated}</span></TableCell>
            <TableCell><span className="flex flex-wrap gap-1">{secret.requiredBy.map((profile) => <Badge key={profile} size="compact" color="gray">{profile}</Badge>)}</span></TableCell>
            <TableCell><Badge size="compact" color="green">project override</Badge></TableCell>
          </TableRow>)}</TableBody>
        </Table>
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex items-end justify-between gap-4"><div className="flex flex-col gap-1"><h2 className="text-subtitle font-semibold text-foreground">Project values</h2><p className="text-caption text-muted-foreground">Visible, non-sensitive values inherited by workspaces in {model.selectedProject}.</p></div><Button variant="secondary" size="compact" leadingIcon={PlusIcon} onClick={() => setAddingValue(true)}>Add value</Button></div>
        <Table>
          <TableHeader><TableRow><TableHead>Name</TableHead><TableHead>Value</TableHead><TableHead>Needed by profiles</TableHead><TableHead>Updated</TableHead></TableRow></TableHeader>
          <TableBody>{visibleProjectValues.map((value, index) => <TableRow key={value.name} index={index}>
            <TableCell><code className="font-mono font-medium text-foreground">{value.name}</code></TableCell>
            <TableCell><InputGroup><InputField index={0} label={`Value for ${value.name}`} value={value.value} onChange={(next) => onUpdateValue(value.name, next, value.project)} /></InputGroup></TableCell>
            <TableCell><span className="flex flex-wrap gap-1">{value.requiredBy.map((profile) => <Badge key={profile} size="compact" color="gray">{profile}</Badge>)}</span></TableCell>
            <TableCell><span className="tabular-nums text-muted-foreground">{value.updated}</span></TableCell>
          </TableRow>)}</TableBody>
        </Table>
        {addingValue ? <Elevated offset={1} className={`${shape.container} flex flex-col gap-3 p-3`}><InputGroup><InputField index={0} label="Name" value={valueName} onChange={(next) => setValueName(next.toUpperCase())} placeholder="API_ORIGIN" /><InputField index={1} label="Value" value={valueValue} onChange={setValueValue} placeholder="https://api.example.com" /></InputGroup><span className="flex justify-end gap-1"><Button variant="ghost" size="compact" onClick={() => setAddingValue(false)}>Cancel</Button><Button variant="primary" size="compact" disabled={!valueName.trim() || !valueValue.trim()} onClick={() => { onAddValue(valueName.trim(), valueValue, model.selectedProject); setValueName(''); setValueValue(''); setAddingValue(false); }}>Save value</Button></span></Elevated> : null}
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex items-center gap-2"><AlertIcon size={18} strokeWidth={1.5} className="text-destructive" /><div><h2 className="text-subtitle font-semibold text-foreground">Needed by bundles</h2><p className="text-caption text-muted-foreground">Missing from {model.selectedProject}. Add each globally or directly to this project.</p></div></div>
        <Elevated offset={1} className={`${shape.container} overflow-hidden`}>
          <ul>{model.missing.map((secret, index) => <li key={secret.name} className={`flex flex-wrap items-center justify-between gap-3 px-4 py-3 ${index ? 'border-t border-border' : ''}`}>
            <span className="flex min-w-0 flex-col gap-1"><span className="flex items-center gap-2"><code className="font-mono text-body font-medium text-foreground">{secret.name}</code><Badge size="compact" color="red">missing</Badge></span><span className="text-caption text-muted-foreground">Required by {secret.requiredBy.join(', ')}</span></span>
            <span className="flex items-center gap-1"><Button variant="secondary" size="compact" onClick={() => openAdd(secret.name, 'global')}>Add global</Button><Button variant="primary" size="compact" onClick={() => openAdd(secret.name, 'project')}>Add to {model.selectedProject}</Button></span>
          </li>)}</ul>
        </Elevated>
      </section>
    </div>
    <AddSecretDialog key={`${addState.open}-${addState.name}-${addState.scope}`} open={addState.open} initialName={addState.name} initialScope={addState.scope} selectedProject={model.selectedProject} projects={model.projects} onOpenChange={(open) => setAddState((current) => ({ ...current, open }))} onAdd={onAddSecret} />
  </PageCanvas>;
}

export interface ApproveCheckDialogMockProps {
  open: boolean;
  trust: Extract<TrustState, { status: 'changed' }>;
  onOpenChange(open: boolean): void;
  onApprove(): void;
}

export function ApproveCheckDialogMock({ open, trust, onOpenChange, onApprove }: ApproveCheckDialogMockProps) {
  const shape = useShape();
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent size="sm">
      <DialogHeader>
        <DialogTitle><span className="flex items-center gap-2"><ShieldIcon size={18} strokeWidth={1.5} className="text-muted-foreground" />Approve changed check</span></DialogTitle>
        <DialogDescription>The command for <code className="font-mono">db-migrated</code> no longer matches the project approval. Review exactly what changed before this runs.</DialogDescription>
      </DialogHeader>
      <div className={`${shape.container} overflow-hidden bg-surface-3 font-mono text-caption shadow-surface-1`} aria-label="Command approval diff">
        <div className="flex gap-2 px-3 py-2 text-destructive"><span aria-hidden>−</span><code className="break-all">{trust.approvedCommand}</code></div>
        <div className="flex gap-2 bg-surface-4 px-3 py-2 text-foreground"><span aria-hidden>+</span><code className="break-all">{trust.currentCommand}</code></div>
      </div>
      <p className="mt-3 text-caption text-muted-foreground">The approval is scoped to GitSpace and this exact command hash. Catalog checks never require approval.</p>
      <DialogFooter><Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button><Button variant="primary" leadingIcon={ShieldIcon} onClick={onApprove}>Approve on all machines</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}
