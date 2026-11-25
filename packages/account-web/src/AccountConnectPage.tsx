import { installDomains } from './install-domains.js';
import { useState } from 'react';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, InputField, InputGroup } from '@gitspace/ui';
import { accountHandleFromUrl } from './browser-enrollment.js';
import type { BrowserDevice } from './device.js';
import { passkeysSupported, preparePasskeySignIn } from './passkeys.js';
import { stepUpErrorMessage, TAP, useRenewing } from './StepUpPrompt.js';
import { STANDALONE_PAGE } from './standalonePage.js';

/** Signs this browser in with a passkey: the sign-in is prepared ahead (and renewed before it expires) so the click runs
 * WebAuthn straight away, as Safari requires. */
function PasskeySignInCard({ onSignIn }: { onSignIn: (device: BrowserDevice) => void }) {
  const prepared = useRenewing('sign-in', () => preparePasskeySignIn(window.location.origin), signIn => signIn.expiresAt, 'GitSpace could not start passkey sign-in. Reload this page to try again.');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const signIn = () => {
    if (!prepared.value || busy) return;
    const pending = prepared.value.signIn();
    setBusy(true);
    setError(null);
    pending.then(onSignIn, (cause: unknown) => {
      setError(stepUpErrorMessage(cause, 'Passkey sign-in failed. Try again.'));
      prepared.renew();
    }).finally(() => setBusy(false));
  };
  return <Card>
    <CardHeader><CardTitle>Sign in with a passkey</CardTitle><CardDescription>Use a passkey you enrolled for this account. This browser gets its own revocable key.</CardDescription></CardHeader>
    <CardContent className="flex flex-col gap-3">
      <Button variant="primary" className={TAP} loading={busy} disabled={busy || !prepared.value} onClick={signIn}>Sign in with a passkey</Button>
      {prepared.error ?? error ? <p role="alert" className="text-caption text-destructive [overflow-wrap:anywhere]">{prepared.error ?? error}</p> : null}
    </CardContent>
  </Card>;
}

export function AccountConnectPage({ error, onRecover, onEnroll, onPasskeySignIn }: { error: string | null; onRecover: (handle: string, key: string) => void; onEnroll: (value: string) => void; onPasskeySignIn: (device: BrowserDevice) => void }) {
  const [inferredHandle] = useState(() => accountHandleFromUrl(new URL(window.location.href)));
  const [passkeys] = useState(() => inferredHandle !== null && passkeysSupported());
  const [handle, setHandle] = useState(inferredHandle ?? '');
  const [recoveryKey, setRecoveryKey] = useState('');
  const [pasted, setPasted] = useState('');
  return <main className={`${STANDALONE_PAGE} items-center p-6 pb-[max(1.5rem,env(safe-area-inset-bottom))]`}>
    <div className="my-auto flex w-full max-w-lg flex-col gap-6">
      <header className="flex flex-col gap-2">
        <p className="text-caption font-medium text-muted-foreground">{inferredHandle ? `${inferredHandle}.${installDomains().account}` : 'GitSpace account'}</p>
        <h1 className="text-title font-semibold [text-wrap:balance]">Connect this browser{inferredHandle ? ` to ${inferredHandle}` : ''}</h1>
        <p className="text-caption text-muted-foreground [text-wrap:pretty]">{passkeys ? 'Sign in with a passkey you enrolled, use' : 'Use'} your saved recovery key here, or open a single-use link from Account → Connections → Browsers in a connected browser.</p>
      </header>
      {error ? <p role="alert" className="text-caption text-destructive">{error}</p> : null}
      {passkeys ? <PasskeySignInCard onSignIn={onPasskeySignIn} /> : null}
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
