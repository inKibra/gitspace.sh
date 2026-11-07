import { Button, useShape } from '@gitspace/ui';
import { XCircle } from '@untitledui/icons';
import { useState, type ReactElement } from 'react';
import { rpcErrorMessage } from '../rpc-error-message.js';
import { TextInput } from './automation-fields.js';
import { PlusGlyph } from './automation-formatters.js';

export function TrustList({ repository, trusted, onSave }: { repository: string | null; trusted: readonly string[]; onSave(trusted: string[]): Promise<void> }): ReactElement {
  const shape = useShape();
  const [login, setLogin] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async (next: string[]): Promise<boolean> => {
    setPending(true);
    setError(null);
    try {
      await onSave(next);
      return true;
    } catch (cause) {
      setError(rpcErrorMessage(cause, 'Save trusted authors'));
      return false;
    } finally {
      setPending(false);
    }
  };
  const trust = async (): Promise<void> => {
    const entry = login.trim().replace(/^@+/u, '');
    if (!entry || pending) return;
    if (trusted.some(known => known.toLowerCase() === entry.toLowerCase())) {
      setLogin('');
      return;
    }
    if (await save([...trusted, entry])) setLogin('');
  };
  return <div className={`${shape.container} flex flex-col gap-3 bg-surface-2 px-5 py-4 shadow-surface-1`}>
    <p className="text-body text-muted-foreground">An event runs only if its author has write access to {repository ? <span className="font-mono text-caption text-foreground">{repository}</span> : 'the project\'s repository'} (checked through the GitHub App when the event arrives) or is listed here. For a comment, the author is the commenter. Events from anyone else do not match any automation; they show as skipped in recent runs. Schedules and manual runs are always trusted.</p>
    {trusted.length ? <ul aria-label="Trusted logins" className="flex flex-wrap gap-2">{trusted.map(entry => <li key={entry} className={`${shape.input} flex min-w-0 items-center gap-1 border border-border bg-background py-0.5 pl-2 pr-0.5`}>
      <span className="font-mono text-caption [overflow-wrap:anywhere]">@{entry}</span>
      <Button variant="ghost" size="icon" type="button" aria-label={`Stop trusting @${entry}`} disabled={pending} onClick={() => void save(trusted.filter(other => other !== entry))}><XCircle width={14} height={14} strokeWidth={1.5} /></Button>
    </li>)}</ul> : <p className="text-caption text-muted-foreground">No one is listed.</p>}
    <form noValidate className="flex max-w-md items-center gap-2" onSubmit={event => { event.preventDefault(); void trust(); }}>
      <div className="min-w-0 flex-1"><TextInput label="GitHub login" value={login} onChange={setLogin} mono placeholder="GitHub login" /></div>
      <Button variant="secondary" type="submit" leadingIcon={PlusGlyph} loading={pending} disabled={pending}>Trust</Button>
    </form>
    {error ? <p role="alert" className="text-caption text-destructive [overflow-wrap:anywhere]">{error}</p> : null}
  </div>;
}
