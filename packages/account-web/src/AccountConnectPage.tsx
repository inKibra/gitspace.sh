import { useState } from 'react';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, InputField, InputGroup } from '@gitspace/ui';
import { accountHandleFromUrl } from './browser-enrollment.js';

export function AccountConnectPage({ error, onRecover, onEnroll }: { error: string | null; onRecover: (handle: string, key: string) => void; onEnroll: (value: string) => void }) {
  const [inferredHandle] = useState(() => accountHandleFromUrl(new URL(window.location.href)));
  const [handle, setHandle] = useState(inferredHandle ?? '');
  const [recoveryKey, setRecoveryKey] = useState('');
  const [pasted, setPasted] = useState('');
  return <main className="flex min-h-dvh items-center justify-center bg-background p-6 text-foreground antialiased">
    <div className="flex w-full max-w-lg flex-col gap-6">
      <header className="flex flex-col gap-2">
        <p className="text-caption font-medium text-muted-foreground">{inferredHandle ? `${inferredHandle}.gitspace.sh` : 'GitSpace account'}</p>
        <h1 className="text-title font-semibold [text-wrap:balance]">Connect this browser{inferredHandle ? ` to ${inferredHandle}` : ''}</h1>
        <p className="text-caption text-muted-foreground [text-wrap:pretty]">Use your saved recovery key here, or open a single-use link from Account → Connections → Browsers in a connected browser.</p>
      </header>
      {error ? <p role="alert" className="text-caption text-destructive">{error}</p> : null}
      <Card>
        <CardHeader><CardTitle>Use your recovery key</CardTitle><CardDescription>This browser gets its own revocable key. Your recovery key stays in this browser during recovery and is never saved or sent to the server.</CardDescription></CardHeader>
        <CardContent>
          <form className="flex flex-col gap-4" onSubmit={event => {
            event.preventDefault();
            let key = recoveryKey;
            setRecoveryKey('');
            onRecover(handle, key);
            key = '';
          }}>
            <InputGroup className="w-full">
              <InputField index={0} label="Account handle" value={handle} onChange={setHandle} readOnly={inferredHandle !== null} autoComplete="username" autoCapitalize="none" spellCheck={false} required />
              <InputField index={1} label="Recovery key" type="password" value={recoveryKey} onChange={setRecoveryKey} placeholder="gsr_…" autoComplete="off" autoCapitalize="none" spellCheck={false} required />
            </InputGroup>
            <Button variant="primary" type="submit" disabled={!handle.trim() || !recoveryKey.trim()}>Connect with recovery key</Button>
            <p className="text-caption text-muted-foreground">Recovery connects directly to your existing account. It does not create an account or depend on another browser staying connected.</p>
          </form>
        </CardContent>
      </Card>
      <details className="text-caption">
        <summary className="flex min-h-10 cursor-pointer items-center font-medium">Already have an enrollment link?</summary>
        <form className="mt-3 flex flex-col gap-3" onSubmit={event => { event.preventDefault(); const value = pasted; setPasted(''); onEnroll(value); }}>
          <InputGroup className="w-full"><InputField index={0} label="Enrollment link" value={pasted} onChange={setPasted} placeholder="Paste the single-use link" autoComplete="off" autoCapitalize="none" spellCheck={false} required /></InputGroup>
          <Button variant="secondary" type="submit" disabled={!pasted.trim()}>Connect with link</Button>
        </form>
      </details>
    </div>
  </main>;
}
