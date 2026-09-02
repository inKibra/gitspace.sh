import { Badge, Button, InputField, InputGroup, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Tooltip } from '@gitspace/ui';
import { Check, Key01, ShieldTick, Trash01, X } from '@untitledui/icons';
import { useEffect, useState } from 'react';
import { EmptyState, PageCanvas, PageHeader } from './GitSpaceShell.js';

export interface ProjectSecretMetadata {
  projectId: string;
  name: string;
  revision: number;
  updatedAt: string;
  updatedBy: string;
}

export interface ProjectSecretsProps {
  projectName: string;
  list(): Promise<readonly ProjectSecretMetadata[]>;
  put(name: string, value: string): Promise<ProjectSecretMetadata>;
  delete(name: string): Promise<void>;
}

export function ProjectSecretsPage(props: ProjectSecretsProps) {
  const { list, put, delete: deleteSecret } = props;
  const [secrets, setSecrets] = useState<readonly ProjectSecretMetadata[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async (): Promise<void> => {
    try {
      setSecrets(await list());
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  useEffect(() => { void refresh(); }, [list]);

  const reset = (): void => {
    setEditing(null);
    setName('');
    setValue('');
  };
  const save = async (): Promise<void> => {
    const secretName = (editing ?? name).trim().toUpperCase();
    if (!secretName || !value) return;
    setSaving(true);
    try {
      await put(secretName, value);
      reset();
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };
  const remove = async (secretName: string): Promise<void> => {
    if (!window.confirm(`Delete project secret ${secretName}?`)) return;
    try {
      await deleteSecret(secretName);
      if (editing === secretName) reset();
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return <PageCanvas>
    <PageHeader kicker="Project configuration" title="Secrets" description={`Write-only values available to authorized lifecycle runs for ${props.projectName}. Values are encrypted and never displayed again.`} />
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex flex-col gap-1">
            <h2 className="text-subtitle font-semibold text-foreground">{editing ? `Replace ${editing}` : 'Add project secret'}</h2>
            <p className="text-caption text-muted-foreground">Environment-variable names only</p>
          </div>
          {editing ? <Button variant="ghost" size="icon" aria-label="Cancel secret replacement" onClick={reset}><X width={16} height={16} strokeWidth={1.5} /></Button> : null}
        </div>
        <form className="flex flex-col items-start gap-4" onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <InputGroup>
            <InputField index={0} label="Name" value={editing ?? name} disabled={!!editing} onChange={(next) => setName(next.toUpperCase())} placeholder="DATABASE_URL" autoCapitalize="characters" />
            <InputField index={1} label="Value" type="password" value={value} onChange={setValue} placeholder={editing ? 'Enter replacement value' : 'Enter secret value'} autoComplete="new-password" />
          </InputGroup>
          <Button variant="primary" type="submit" disabled={saving || !(editing ?? name).trim() || !value}>{saving ? 'Saving' : editing ? 'Replace' : 'Save secret'}</Button>
        </form>
        <p className="flex items-center gap-1.5 text-caption text-muted-foreground"><ShieldTick width={14} height={14} strokeWidth={1.5} />The current value cannot be retrieved from this page. Saving the same name creates a new revision.</p>
      </section>

      {secrets.length
        ? <Table>
          <TableHeader><TableRow><TableHead>Secret</TableHead><TableHead>Revision</TableHead><TableHead>Updated</TableHead><TableHead><span className="sr-only">Actions</span></TableHead></TableRow></TableHeader>
          <TableBody>{secrets.map((secret, index) => <TableRow key={secret.name} index={index}>
            <TableCell><span className="flex items-center gap-2"><Key01 width={16} height={16} strokeWidth={1.5} className="shrink-0 text-muted-foreground" /><span className="font-mono font-medium text-foreground">{secret.name}</span><Badge variant="dot" size="compact" color="green"><Check width={12} height={12} strokeWidth={1.5} />Set</Badge></span></TableCell>
            <TableCell><span className="font-mono tabular-nums">r{secret.revision}</span></TableCell>
            <TableCell><span className="flex flex-col"><span className="tabular-nums text-foreground">{new Date(secret.updatedAt).toLocaleString()}</span><span className="text-caption">{secret.updatedBy}</span></span></TableCell>
            <TableCell className="text-right"><span className="inline-flex items-center justify-end gap-1">
              <Button variant="ghost" size="compact" onClick={() => { setEditing(secret.name); setValue(''); }}>Replace</Button>
              <Tooltip content="Delete secret" side="top"><Button variant="ghost" size="icon" aria-label={`Delete ${secret.name}`} onClick={() => void remove(secret.name)}><Trash01 width={16} height={16} strokeWidth={1.5} /></Button></Tooltip>
            </span></TableCell>
          </TableRow>)}</TableBody>
        </Table>
        : <EmptyState icon={<Key01 width={22} height={22} strokeWidth={1.5} />} title="No project secrets" description="Add a value before lifecycle scripts require it." />}
      {error ? <p role="alert" className="text-caption text-destructive">{error}</p> : null}
    </div>
  </PageCanvas>;
}
