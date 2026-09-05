import { Badge, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, InputField, InputGroup, Select, SelectContent, SelectItem, SelectTrigger, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Tooltip } from '@gitspace/ui';
import { Check, Key01, Plus, ShieldTick, Trash01 } from '@untitledui/icons';
import { useEffect, useState } from 'react';
import { EmptyState, PageCanvas, PageHeader } from './GitSpaceShell.js';

export interface ProjectSecretMetadata {
  projectId: string;
  name: string;
  revision: number;
  updatedAt: string;
  updatedBy: string;
}
export interface ProjectEnvironmentValues {
  global: Readonly<Record<string, string>>;
  project: Readonly<Record<string, string>>;
}

export interface ProjectSecretsProps {
  projectName: string;
  list(): Promise<readonly ProjectSecretMetadata[]>;
  put(name: string, value: string): Promise<ProjectSecretMetadata>;
  delete(name: string): Promise<void>;
  listValues(): Promise<ProjectEnvironmentValues>;
  putValue(scope: 'global' | 'project', name: string, value: string): Promise<void>;
  deleteValue(scope: 'global' | 'project', name: string): Promise<void>;
}

export function ProjectSecretsPage(props: ProjectSecretsProps) {
  const { list, put, delete: deleteSecret } = props;
  const [secrets, setSecrets] = useState<readonly ProjectSecretMetadata[]>([]);
  const [environmentValues, setEnvironmentValues] = useState<ProjectEnvironmentValues>({ global: {}, project: {} });
  const [secretOpen, setSecretOpen] = useState(false);
  const [variableOpen, setVariableOpen] = useState(false);
  const [editingSecret, setEditingSecret] = useState<string | null>(null);
  const [editingVariable, setEditingVariable] = useState<{ scope: 'global' | 'project'; name: string } | null>(null);
  const [valueScope, setValueScope] = useState<'global' | 'project'>('project');
  const [valueName, setValueName] = useState('');
  const [environmentValue, setEnvironmentValue] = useState('');
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async (): Promise<void> => {
    try {
      const [nextSecrets, nextValues] = await Promise.all([list(), props.listValues()]);
      setSecrets(nextSecrets);
      setEnvironmentValues(nextValues);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  useEffect(() => { void refresh(); }, [list]);

  const closeSecret = (): void => {
    setSecretOpen(false);
    setEditingSecret(null);
    setName('');
    setValue('');
  };
  const openSecret = (secretName?: string): void => {
    setEditingSecret(secretName ?? null);
    setName(secretName ?? '');
    setValue('');
    setSecretOpen(true);
  };
  const saveSecret = async (): Promise<void> => {
    const secretName = (editingSecret ?? name).trim().toUpperCase();
    if (!secretName || !value) return;
    setSaving(true);
    try {
      await put(secretName, value);
      closeSecret();
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };
  const removeSecret = async (secretName: string): Promise<void> => {
    if (!window.confirm(`Delete project secret ${secretName}?`)) return;
    try {
      await deleteSecret(secretName);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const closeVariable = (): void => {
    setEditingVariable(null);
    setVariableOpen(false);
    setValueScope('project');
    setValueName('');
    setEnvironmentValue('');
  };
  const openVariable = (scope: 'global' | 'project' = 'project', variableName = '', variableValue = ''): void => {
    setEditingVariable(variableName ? { scope, name: variableName } : null);
    setValueScope(scope);
    setValueName(variableName);
    setEnvironmentValue(variableValue);
    setVariableOpen(true);
  };
  const saveEnvironmentVariable = async (): Promise<void> => {
    const nextName = valueName.trim().toUpperCase();
    if (!nextName) return;
    setSaving(true);
    try {
      await props.putValue(valueScope, nextName, environmentValue);
      closeVariable();
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };
  const removeEnvironmentVariable = async (scope: 'global' | 'project', environmentName: string): Promise<void> => {
    if (!window.confirm(`Delete ${scope} environment variable ${environmentName}?`)) return;
    try {
      await props.deleteValue(scope, environmentName);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return <PageCanvas>
    <PageHeader
      kicker={`Configuration · ${props.projectName}`}
      title="Secrets"
      description="Credentials and environment variables used by plugins and workspaces."
      actions={<Button variant="primary" leadingIcon={Plus} onClick={() => openSecret()}>Add secret</Button>}
    />
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-3" aria-labelledby="project-secrets-heading">
        <div className="flex items-end justify-between gap-4">
          <div className="flex flex-col gap-1">
            <h2 id="project-secrets-heading" className="text-subtitle font-semibold text-foreground">Project secrets</h2>
            <p className="text-body text-muted-foreground">Write-only credentials available to approved plugins and workspace setup.</p>
          </div>
        </div>
        {secrets.length
          ? <Table>
            <TableHeader><TableRow><TableHead>Secret</TableHead><TableHead>Status</TableHead><TableHead>Updated</TableHead><TableHead><span className="sr-only">Actions</span></TableHead></TableRow></TableHeader>
            <TableBody>{secrets.map((secret, index) => <TableRow key={secret.name} index={index}>
              <TableCell><span className="flex items-center gap-2"><Key01 width={16} height={16} strokeWidth={1.5} className="shrink-0 text-muted-foreground" /><span className="font-mono font-medium text-foreground">{secret.name}</span></span></TableCell>
              <TableCell><Badge variant="dot" size="compact" color="green"><Check width={12} height={12} strokeWidth={1.5} />Configured</Badge></TableCell>
              <TableCell><span className="flex flex-col"><span className="tabular-nums text-foreground">{new Date(secret.updatedAt).toLocaleString()}</span><span className="text-caption text-muted-foreground">Revision {secret.revision} · {secret.updatedBy}</span></span></TableCell>
              <TableCell className="text-right"><span className="inline-flex items-center justify-end gap-1">
                <Button variant="ghost" size="compact" onClick={() => openSecret(secret.name)}>Replace</Button>
                <Tooltip content="Delete secret" side="top"><Button variant="ghost" size="icon" aria-label={`Delete ${secret.name}`} onClick={() => void removeSecret(secret.name)}><Trash01 width={16} height={16} strokeWidth={1.5} /></Button></Tooltip>
              </span></TableCell>
            </TableRow>)}</TableBody>
          </Table>
          : <EmptyState icon={<Key01 width={22} height={22} strokeWidth={1.5} />} title="No project secrets" description="Store credentials when a plugin or workspace setup requires one." action={<Button variant="secondary" leadingIcon={Plus} onClick={() => openSecret()}>Add secret</Button>} />}
      </section>

      <section className="flex flex-col gap-3 border-t border-border pt-6" aria-labelledby="environment-variables-heading">
        <div className="flex items-end justify-between gap-4">
          <div className="flex flex-col gap-1">
            <h2 id="environment-variables-heading" className="text-subtitle font-semibold text-foreground">Environment variables</h2>
            <p className="text-body text-muted-foreground">Non-sensitive configuration inherited by this project and its workspaces.</p>
          </div>
          <Button variant="secondary" leadingIcon={Plus} onClick={() => openVariable()}>Add variable</Button>
        </div>
        {(['global', 'project'] as const).map((scope) => {
          const variables = Object.entries(environmentValues[scope]);
          if (variables.length === 0) return null;
          return <div className="flex flex-col gap-2" key={scope}>
            <h3 className="text-caption font-medium text-muted-foreground">{scope === 'global' ? 'Account defaults' : props.projectName}</h3>
            <Table>
              <TableHeader><TableRow><TableHead>Name</TableHead><TableHead>Value</TableHead><TableHead>Scope</TableHead><TableHead><span className="sr-only">Actions</span></TableHead></TableRow></TableHeader>
              <TableBody>{variables.map(([environmentName, currentValue], index) => <TableRow key={environmentName} index={index}>
                <TableCell><code className="font-mono font-medium text-foreground">{environmentName}</code></TableCell>
                <TableCell><code className="font-mono text-foreground">{currentValue}</code></TableCell>
                <TableCell><Badge size="compact" color="gray">{scope === 'global' ? 'Account' : 'Project'}</Badge></TableCell>
                <TableCell className="text-right"><span className="inline-flex items-center justify-end gap-1">
                  <Button variant="ghost" size="compact" onClick={() => openVariable(scope, environmentName, currentValue)}>Edit</Button>
                  <Tooltip content="Delete variable" side="top"><Button variant="ghost" size="icon" aria-label={`Delete ${scope} environment variable ${environmentName}`} onClick={() => void removeEnvironmentVariable(scope, environmentName)}><Trash01 width={16} height={16} strokeWidth={1.5} /></Button></Tooltip>
                </span></TableCell>
              </TableRow>)}</TableBody>
            </Table>
          </div>;
        })}
        {Object.keys(environmentValues.global).length === 0 && Object.keys(environmentValues.project).length === 0
          ? <EmptyState title="No environment variables" description="Add non-sensitive configuration such as service URLs or feature flags." />
          : null}
      </section>
      {error ? <p role="alert" className="text-body text-destructive">{error}</p> : null}
    </div>

    <Dialog open={secretOpen} onOpenChange={(open) => { if (!open) closeSecret(); }}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{editingSecret ? `Replace ${editingSecret}` : 'Add secret'}</DialogTitle>
          <DialogDescription>Store a write-only credential for {props.projectName}. Its value cannot be viewed after saving.</DialogDescription>
        </DialogHeader>
        <form id="project-secret-form" className="flex flex-col gap-4" onSubmit={(event) => { event.preventDefault(); void saveSecret(); }}>
          <InputGroup>
            <InputField index={0} label="Name" value={editingSecret ?? name} disabled={editingSecret !== null} onChange={(next) => setName(next.toUpperCase())} placeholder="DATABASE_URL" autoCapitalize="characters" />
            <InputField index={1} label={editingSecret ? 'Replacement value' : 'Secret value'} type="password" value={value} onChange={setValue} placeholder="Enter secret value" autoComplete="new-password" />
          </InputGroup>
          <p className="flex items-center gap-1.5 text-caption text-muted-foreground"><ShieldTick width={14} height={14} strokeWidth={1.5} />Saving an existing name creates a new revision.</p>
        </form>
        <DialogFooter><Button variant="secondary" onClick={closeSecret}>Cancel</Button><Button variant="primary" type="submit" form="project-secret-form" loading={saving} disabled={saving || !(editingSecret ?? name).trim() || !value}>{editingSecret ? 'Replace secret' : 'Save secret'}</Button></DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog open={variableOpen} onOpenChange={(open) => { if (!open) closeVariable(); }}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{editingVariable ? `Edit ${editingVariable.name}` : 'Add environment variable'}</DialogTitle>
          <DialogDescription>Environment variables are visible to workspace processes. Use a secret for credentials.</DialogDescription>
        </DialogHeader>
        <form id="environment-variable-form" className="flex flex-col gap-4" onSubmit={(event) => { event.preventDefault(); void saveEnvironmentVariable(); }}>
          <Select value={valueScope} disabled={editingVariable !== null} onValueChange={(next) => setValueScope(next as 'global' | 'project')}><SelectTrigger aria-label="Variable scope" /><SelectContent><SelectItem value="global" index={0}>Account default</SelectItem><SelectItem value="project" index={1}>{props.projectName}</SelectItem></SelectContent></Select>
          <InputGroup><InputField index={0} label="Name" disabled={editingVariable !== null} value={valueName} onChange={(next) => setValueName(next.toUpperCase())} placeholder="API_ORIGIN" /><InputField index={1} label="Value" value={environmentValue} onChange={setEnvironmentValue} placeholder="https://api.example.com" /></InputGroup>
        </form>
        <DialogFooter><Button variant="secondary" onClick={closeVariable}>Cancel</Button><Button variant="primary" type="submit" form="environment-variable-form" loading={saving} disabled={saving || !valueName.trim()}>Save variable</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </PageCanvas>;
}
