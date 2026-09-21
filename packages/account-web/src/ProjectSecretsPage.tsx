import type { AccountSecretMetadata, ConfigurationValuesView } from '@gitspace/protocol/rpc-contract';
import { Badge, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, InputField, InputGroup, Select, SelectContent, SelectItem, SelectTrigger, Switch, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@gitspace/ui';
import { useEffect, useRef, useState } from 'react';
import { EmptyState, PageCanvas, PageHeader } from './GitSpaceShell.js';
import { invalidatesRead } from './useRetainedRead.js';

export interface ProjectSecretMetadata {
  projectId: string;
  name: string;
  revision: number;
  updatedAt: string;
  updatedBy: string;
}

type WriteTarget = { scope: 'global' } | { scope: 'project'; projectId: string };
type EntryDraft = { kind: 'secret' | 'value'; target: WriteTarget; name: string; value: string; replacing: boolean };
export interface ProjectSecretsProps {
  projects: readonly { id: string; name: string }[];
  listAccount(): Promise<readonly AccountSecretMetadata[]>;
  putAccount(name: string, value: string): Promise<AccountSecretMetadata>;
  deleteAccount(name: string): Promise<void>;
  grant(name: string, projectId: string, projectSpaceEnabled: boolean, workspacesEnabled: boolean): Promise<AccountSecretMetadata>;
  revoke(name: string, projectId: string): Promise<AccountSecretMetadata>;
  list(projectId: string): Promise<readonly ProjectSecretMetadata[]>;
  put(projectId: string, name: string, value: string): Promise<ProjectSecretMetadata>;
  delete(projectId: string, name: string): Promise<void>;
  listValues(projectId?: string): Promise<ConfigurationValuesView>;
  putValue(target: WriteTarget, name: string, value: string): Promise<void>;
  deleteValue(target: WriteTarget, name: string): Promise<void>;
}

export function ProjectSecretsPage(props: ProjectSecretsProps) {
  const [projectId, setProjectId] = useState('');
  const [accountSecrets, setAccountSecrets] = useState<readonly AccountSecretMetadata[]>([]);
  const [projectSecrets, setProjectSecrets] = useState<readonly ProjectSecretMetadata[]>([]);
  const [values, setValues] = useState<ConfigurationValuesView>({ global: {}, project: {} });
  const [draft, setDraft] = useState<EntryDraft | null>(null);
  const [grantName, setGrantName] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const refreshVersion = useRef(0);
  const project = props.projects.find((candidate) => candidate.id === projectId);
  const targetLabel = (target: WriteTarget): string => target.scope === 'global' ? 'Account' : props.projects.find((candidate) => candidate.id === target.projectId)?.name ?? target.projectId;
  const refresh = async (): Promise<void> => {
    const version = ++refreshVersion.current;
    setLoading(true);
    const [account, secrets, nextValues] = await Promise.allSettled([props.listAccount(), projectId ? props.list(projectId) : Promise.resolve([]), props.listValues(projectId || undefined)]);
    if (version !== refreshVersion.current) return;
    if (account.status === 'fulfilled') setAccountSecrets(account.value);
    else if (invalidatesRead(account.reason)) { setAccountSecrets([]); setGrantName(null); setDraft(null); }
    if (secrets.status === 'fulfilled') setProjectSecrets(secrets.value);
    else if (invalidatesRead(secrets.reason)) { setProjectSecrets([]); setDraft(null); }
    if (nextValues.status === 'fulfilled') setValues(nextValues.value);
    else if (invalidatesRead(nextValues.reason)) { setValues({ global: {}, project: {} }); setDraft(null); }
    const failures = [account, secrets, nextValues].flatMap((result) => result.status === 'rejected' ? [result.reason instanceof Error ? result.reason.message : String(result.reason)] : []);
    setError(failures.join(' · ') || null);
    setLoading(false);
  };
  useEffect(() => {
    setError(null);
    setProjectSecrets([]);
    setValues((current) => ({ global: current.global, project: {} }));
    void refresh();
    return () => { refreshVersion.current += 1; };
  }, [projectId, props.listAccount, props.list, props.listValues]);
  const mutate = async (action: () => Promise<void>): Promise<void> => {
    if (busy.current) return;
    busy.current = true;
    setSaving(true);
    setError(null);
    try { await action(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { busy.current = false; setSaving(false); }
  };
  const openEditor = (kind: EntryDraft['kind'], target: WriteTarget, name = '', value = ''): void => {
    setError(null);
    setDraft({ kind, target, name, value, replacing: name.length > 0 });
  };
  const save = async (): Promise<void> => {
    if (!draft || !draft.name.trim() || (draft.kind === 'secret' && !draft.value)) return;
    const entry = draft;
    await mutate(async () => {
      const name = entry.name.trim();
      if (entry.kind === 'value') await props.putValue(entry.target, name, entry.value);
      else if (entry.target.scope === 'global') await props.putAccount(name, entry.value);
      else await props.put(entry.target.projectId, name, entry.value);
      setDraft(null);
      await refresh();
    });
  };
  const remove = (kind: EntryDraft['kind'], target: WriteTarget, name: string): void => {
    if (!window.confirm(`Delete ${kind} ${name} from ${targetLabel(target)}?`)) return;
    void mutate(async () => {
      if (kind === 'value') await props.deleteValue(target, name);
      else if (target.scope === 'global') await props.deleteAccount(name);
      else await props.delete(target.projectId, name);
      await refresh();
    });
  };
  const grantSecret = accountSecrets.find((secret) => secret.name === grantName);
  const updateGrant = (id: string, projectSpaceEnabled: boolean, workspacesEnabled: boolean): void => {
    if (!grantSecret) return;
    void mutate(async () => {
      const updated = await props.grant(grantSecret.name, id, projectSpaceEnabled, workspacesEnabled);
      setAccountSecrets((current) => current.map((secret) => secret.name === updated.name ? updated : secret));
    });
  };
  const secretTable = (secrets: readonly (ProjectSecretMetadata | AccountSecretMetadata)[], target: WriteTarget) => <Table>
    <TableHeader><TableRow><TableHead>Secret</TableHead><TableHead>Access</TableHead><TableHead>Updated</TableHead><TableHead><span className="sr-only">Actions</span></TableHead></TableRow></TableHeader>
    <TableBody>{secrets.map((secret, index) => <TableRow key={secret.name} index={index}>
      <TableCell><code className="font-mono font-medium">{secret.name}</code></TableCell>
      <TableCell>{'grants' in secret ? <Badge color={secret.grants.length ? 'blue' : 'gray'}>{secret.grants.length} project grants</Badge> : <Badge color="green">Project override</Badge>}</TableCell>
      <TableCell><span className="tabular-nums text-caption">{new Date(secret.updatedAt).toLocaleString()} · revision {secret.revision}</span></TableCell>
      <TableCell><div className="flex justify-end gap-1">{'grants' in secret ? <Button variant="ghost" disabled={saving} onClick={() => { setError(null); setGrantName(secret.name); }}>Manage grants</Button> : null}<Button variant="ghost" disabled={saving} onClick={() => openEditor('secret', target, secret.name)}>Replace</Button><Button variant="ghost" disabled={saving} aria-label={`Delete ${target.scope} secret ${secret.name}`} onClick={() => remove('secret', target, secret.name)}>Delete</Button></div></TableCell>
    </TableRow>)}</TableBody>
  </Table>;
  const valuesSection = (target: WriteTarget) => {
    const entries = Object.entries(values[target.scope]);
    return <section className="flex flex-col gap-3" aria-label={`${targetLabel(target)} values`}>
      <div className="flex items-center justify-between gap-3"><h2 className="text-subtitle font-semibold">{target.scope === 'global' ? 'Account values' : 'Project values'}</h2><Button variant="secondary" disabled={saving} onClick={() => openEditor('value', target)}>Add {target.scope === 'global' ? 'account' : 'project'} value</Button></div>
      <p className="text-body text-muted-foreground">{target.scope === 'global' ? 'Visible, non-sensitive defaults inherited by every project.' : 'Visible overrides inherited by this project’s workspaces. Workspace overrides take precedence.'}</p>
      {entries.length ? <Table><TableHeader><TableRow><TableHead>Name</TableHead><TableHead>Value</TableHead><TableHead><span className="sr-only">Actions</span></TableHead></TableRow></TableHeader><TableBody>{entries.map(([name, value], index) => <TableRow key={name} index={index}><TableCell><code>{name}</code></TableCell><TableCell><code className="break-all">{value}</code>{target.scope === 'project' && name in values.global ? <Badge color="blue">Overrides account value</Badge> : null}</TableCell><TableCell><div className="flex justify-end gap-1"><Button variant="ghost" disabled={saving} onClick={() => openEditor('value', target, name, value)}>Edit</Button><Button variant="ghost" disabled={saving} aria-label={`Delete ${target.scope} value ${name}`} onClick={() => remove('value', target, name)}>Delete</Button></div></TableCell></TableRow>)}</TableBody></Table> : <p className="text-caption text-muted-foreground">{loading ? 'Loading values…' : 'No values stored at this scope.'}</p>}
    </section>;
  };
  return <PageCanvas>
    <PageHeader kicker="Account configuration" title="Secrets & values" description="Store credentials once, grant access explicitly, and keep non-sensitive values visible. No running workspace is required." actions={<Button variant="ghost" disabled={saving || loading} onClick={() => { setError(null); void refresh(); }}>Refresh configuration</Button>} />
    {error ? <p role="alert" className="mb-4 text-body text-destructive">{error}</p> : null}
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-3" aria-label="Account secrets">
        <div className="flex items-center justify-between gap-3"><h2 className="text-subtitle font-semibold">Account secrets</h2><Button variant="primary" disabled={saving} onClick={() => openEditor('secret', { scope: 'global' })}>Add account secret</Button></div>
        <p className="text-body text-muted-foreground">Write-only credentials. Saving creates no grants. Each project needs explicit access for its project space, workspaces, or both.</p>
        {accountSecrets.length ? secretTable(accountSecrets, { scope: 'global' }) : <EmptyState title={loading ? 'Loading account secrets…' : 'No account secrets'} />}
      </section>
      {valuesSection({ scope: 'global' })}
      <section className="flex flex-col gap-4 border-t border-border pt-6" aria-label="Project configuration">
        <div className="flex flex-col gap-2"><h2 className="text-subtitle font-semibold">Project overrides</h2><Select value={projectId} disabled={saving || draft !== null} onValueChange={(id) => { setProjectId(id); setProjectSecrets([]); setValues((current) => ({ global: current.global, project: {} })); setLoading(true); }}><SelectTrigger aria-label="Project for overrides" placeholder="Choose a project" /><SelectContent>{props.projects.map((candidate, index) => <SelectItem key={candidate.id} value={candidate.id} index={index}>{candidate.name}</SelectItem>)}</SelectContent></Select></div>
        {project ? <><div className="flex items-center justify-between gap-3"><h3 className="text-body font-semibold">{project.name} · project secrets</h3><Button variant="secondary" disabled={saving} onClick={() => openEditor('secret', { scope: 'project', projectId })}>Add project secret</Button></div><p className="text-body text-muted-foreground">Project secrets override granted account secrets with the same name. Account writes above never follow this selection.</p>
          {projectSecrets.length ? secretTable(projectSecrets, { scope: 'project', projectId }) : <p className="text-caption text-muted-foreground">{loading ? 'Loading project secrets…' : 'No project secret overrides.'}</p>}
          {accountSecrets.filter((secret) => secret.grants.some((grant) => grant.projectId === projectId)).map((secret) => { const grant = secret.grants.find((candidate) => candidate.projectId === projectId)!; return <p key={secret.name} className="text-caption text-muted-foreground"><code>{secret.name}</code> · {projectSecrets.some((override) => override.name === secret.name) ? 'Overridden by project secret' : `Account grant · project space ${grant.projectSpaceEnabled ? 'on' : 'off'} · workspaces ${grant.workspacesEnabled ? 'on' : 'off'}`}</p>; })}
          {valuesSection({ scope: 'project', projectId })}</> : <p className="text-body text-muted-foreground">Choose an explicit project to read or write its overrides. Account secrets and values work without a project.</p>}
      </section>
    </div>
    <Dialog open={draft !== null} onOpenChange={(open) => { if (!open && !saving) setDraft(null); }}>{draft ? <DialogContent size="sm"><DialogHeader><DialogTitle>{draft.replacing ? 'Replace' : 'Add'} {draft.kind}</DialogTitle><DialogDescription>Write target: {targetLabel(draft.target)}. {draft.kind === 'secret' ? 'The credential cannot be viewed after saving.' : 'This value is visible. Use a secret for credentials.'}</DialogDescription></DialogHeader>
      <form id="configuration-entry" className="flex flex-col gap-3" onSubmit={(event) => { event.preventDefault(); void save(); }}><InputGroup><InputField index={0} label="Name" disabled={draft.replacing || saving} value={draft.name} onChange={(name) => setDraft({ ...draft, name })} required autoFocus /><InputField index={1} label={draft.kind === 'secret' ? 'Secret value' : 'Value'} type={draft.kind === 'secret' ? 'password' : 'text'} autoComplete={draft.kind === 'secret' ? 'new-password' : 'off'} value={draft.value} onChange={(value) => setDraft({ ...draft, value })} disabled={saving} /></InputGroup>{error ? <p role="alert" className="text-caption text-destructive">{error}</p> : null}</form>
      <DialogFooter><Button variant="secondary" disabled={saving} onClick={() => setDraft(null)}>Cancel</Button><Button variant="primary" type="submit" form="configuration-entry" loading={saving} disabled={saving || !draft.name.trim() || (draft.kind === 'secret' && !draft.value)}>Save to {targetLabel(draft.target)}</Button></DialogFooter></DialogContent> : null}</Dialog>
    <Dialog open={grantSecret !== undefined} onOpenChange={(open) => { if (!open && !saving) setGrantName(null); }}>{grantSecret ? <DialogContent size="lg"><DialogHeader><DialogTitle>{grantSecret.name} · project grants</DialogTitle><DialogDescription>New grants enable both kinds of agent. Turn either off, or revoke the entire project grant.</DialogDescription></DialogHeader>
      <Table><TableHeader><TableRow><TableHead>Project</TableHead><TableHead>Project space</TableHead><TableHead>Workspaces</TableHead><TableHead>Grant</TableHead></TableRow></TableHeader><TableBody>{props.projects.map((candidate, index) => { const grant = grantSecret.grants.find((item) => item.projectId === candidate.id); return <TableRow key={candidate.id} index={index}><TableCell>{candidate.name}</TableCell><TableCell>{grant ? <Switch checked={grant.projectSpaceEnabled} label="Project space" disabled={saving} onToggle={() => updateGrant(candidate.id, !grant.projectSpaceEnabled, grant.workspacesEnabled)} /> : 'Not granted'}</TableCell><TableCell>{grant ? <Switch checked={grant.workspacesEnabled} label="Workspaces" disabled={saving} onToggle={() => updateGrant(candidate.id, grant.projectSpaceEnabled, !grant.workspacesEnabled)} /> : 'Not granted'}</TableCell><TableCell>{grant ? <Button variant="ghost" disabled={saving} onClick={() => void mutate(async () => { const updated = await props.revoke(grantSecret.name, candidate.id); setAccountSecrets((current) => current.map((secret) => secret.name === updated.name ? updated : secret)); })}>Revoke</Button> : <Button variant="secondary" disabled={saving} onClick={() => updateGrant(candidate.id, true, true)}>Grant access</Button>}</TableCell></TableRow>; })}</TableBody></Table>
      {!props.projects.length ? <p className="text-caption text-muted-foreground">Create a project before granting access.</p> : null}{error ? <p role="alert" className="text-caption text-destructive">{error}</p> : null}<DialogFooter><Button variant="secondary" disabled={saving} onClick={() => setGrantName(null)}>Done</Button></DialogFooter></DialogContent> : null}</Dialog>
  </PageCanvas>;
}
