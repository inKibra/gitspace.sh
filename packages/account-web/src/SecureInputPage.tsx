import { useEffect, useState, type FormEvent } from 'react';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, CheckboxGroup, CheckboxItem, InputField, InputGroup } from '@gitspace/ui';
import { RuntimeSecureInputOutcomeSchema, RuntimeSecureInputViewSchema, SECURE_INPUT_API_PATH, SECURE_INPUT_VALUE_MAX, type RuntimeSecureInputKind, type RuntimeSecureInputOutcome, type RuntimeSecureInputPageRequest, type RuntimeSecureInputView } from '@gitspace/protocol-runtime/secure-input';
import { z } from 'zod';
import { createDeviceSignedFetch, DeviceRejectedError, loadDevice } from './device.js';
import { SECURE_INPUT_KIND_LABEL } from './SecureInputCard.js';

const signedFetch = createDeviceSignedFetch(loadDevice, code => { throw new DeviceRejectedError(code); });
const ErrorSchema = z.object({ status: z.literal('error'), error: z.object({ message: z.string() }) });
const SAVED_AT = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
/** Why a request that is not open takes no answer. */
const NOT_OPEN: Readonly<Record<Exclude<RuntimeSecureInputView['state'], 'open'>, string>> = {
  used: 'This request was already answered.',
  expired: 'This request expired before anyone answered it.',
  closed: 'This request was closed: it was declined on its card, its conversation was stopped, or someone replied in chat instead.',
};
/** How the field offers what it asks for: a one-time code from the phone's keyboard and messages; nothing remembered else. */
const FIELD: Readonly<Record<RuntimeSecureInputKind, { autoComplete: string; inputMode?: 'numeric' }>> = {
  password: { autoComplete: 'off' }, otp: { autoComplete: 'one-time-code', inputMode: 'numeric' }, text: { autoComplete: 'off' },
};
const TAP = 'h-11 w-full sm:h-9 sm:w-auto';

/** Posts one request to the page's API (`RuntimeSecureInputPageRequestSchema`) and reads the account's answer: its value,
 * or the error message it gave. */
async function post<T>(request: RuntimeSecureInputPageRequest, schema: z.ZodType<T>): Promise<T> {
  const response = await signedFetch(SECURE_INPUT_API_PATH, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) });
  const body: unknown = await response.json().catch(() => null);
  const failure = ErrorSchema.safeParse(body);
  if (failure.success) throw new Error(failure.data.error.message);
  const answer = z.object({ status: z.literal('ok'), value: schema }).safeParse(body);
  if (!response.ok || !answer.success) throw new Error(`GitSpace could not read this request (HTTP ${response.status}).`);
  return answer.data.value;
}

/**
 * The secure-input page (docs/APERTURE-DESIGN.md §10.1), `/secure-input/<id>` on a signed-in GitSpace browser: the
 * request an agent made (its workspace, what the secret is for, the exact origin it is filled into, what it asks for,
 * the browser and tab, the time left), a masked field, Save for the origin (off until ticked), Submit and Decline, and
 * each value saved for the origin. The typed value leaves this page's state the moment it is sent, and when the page is
 * left; it is never put in the address, storage or a message. A request that is not open says why and takes nothing.
 */
export function SecureInputPage({ id }: { id: string }) {
  const [view, setView] = useState<{ request: RuntimeSecureInputView } | { error: string } | null>(null);
  const [value, setValue] = useState('');
  const [save, setSave] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<RuntimeSecureInputOutcome | null>(null);
  const [now, setNow] = useState(Date.now);
  const request = view && 'request' in view ? view.request : null;
  const left = request ? Date.parse(request.expiresAt) - now : 0;
  const open = request?.state === 'open' && left > 0 && outcome === null;
  useEffect(() => {
    let live = true;
    post({ op: 'view', id }, RuntimeSecureInputViewSchema).then(
      loaded => { if (live) setView({ request: loaded }); },
      (failure: unknown) => { if (live) setView({ error: failure instanceof Error ? failure.message : 'GitSpace could not load this request.' }); },
    );
    return () => { live = false; };
  }, [id]);
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [open]);
  // A page left for another keeps no typed value: the back-forward cache would bring it back.
  useEffect(() => {
    const clear = () => setValue('');
    window.addEventListener('pagehide', clear);
    return () => window.removeEventListener('pagehide', clear);
  }, []);
  async function send(answer: RuntimeSecureInputPageRequest) {
    setBusy(true); setError(null);
    try { setOutcome(await post(answer, RuntimeSecureInputOutcomeSchema)); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'GitSpace could not answer this request.'); }
    finally { setBusy(false); }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !value) return;
    const typed = value;
    setValue('');
    void send({ op: 'submit', id, value: typed, save });
  }
  const seconds = Math.max(0, Math.ceil(left / 1000));
  return <main className="flex min-h-dvh justify-center bg-background p-4 text-foreground antialiased sm:items-center sm:p-6">
    <Card className="w-full max-w-lg">
      <CardHeader>
        <CardTitle>Enter a secret for an agent</CardTitle>
        <CardDescription>{request ? `Workspace ${request.workspace}` : 'GitSpace secure input'}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {view === null ? <p role="status" className="text-body text-muted-foreground">Loading the request…</p>
          : request === null ? <p role="alert" className="text-body text-destructive [overflow-wrap:anywhere]">{'error' in view ? view.error : null}</p>
            : <>
              <p className="text-body text-foreground [overflow-wrap:anywhere]">{request.purpose}</p>
              <div className="flex flex-col gap-1">
                <span className="text-caption text-muted-foreground">It is filled only into a page of</span>
                <p className="break-all font-mono text-[20px] font-semibold leading-snug text-foreground sm:text-[22px]" data-secure-input-origin>{request.origin}</p>
              </div>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-caption">
                <dt className="text-muted-foreground">Asks for</dt><dd className="text-foreground">{SECURE_INPUT_KIND_LABEL[request.kind]}</dd>
                <dt className="text-muted-foreground">Browser</dt><dd className="text-foreground [overflow-wrap:anywhere]">{request.browser}</dd>
                <dt className="text-muted-foreground">Tab</dt><dd className="text-foreground [overflow-wrap:anywhere]">{request.title || 'Untitled'}</dd>
                <dt className="text-muted-foreground">Expires</dt><dd className="tabular-nums text-foreground">{open ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} left` : new Date(request.expiresAt).toLocaleString()}</dd>
              </dl>
              {outcome ? <div role="status" className="flex flex-col gap-1 text-body text-foreground [overflow-wrap:anywhere]" data-secure-input-outcome={outcome.outcome}>
                {outcome.outcome === 'provided'
                  ? <><p>Filled into <span className="font-mono">{request.origin}</span></p>{outcome.saved ? <p>Saved for <span className="font-mono">{request.origin}</span></p> : null}</>
                  : <p>Not filled: {outcome.reason}</p>}
              </div>
                : !open ? <p role="status" className="text-body text-muted-foreground">{request.state === 'open' ? NOT_OPEN.expired : NOT_OPEN[request.state]}</p>
                  : <form className="flex flex-col gap-4" autoComplete="off" onSubmit={submit}>
                    <InputGroup className="w-full">
                      <InputField index={0} label={SECURE_INPUT_KIND_LABEL[request.kind]} type="password" value={value} onChange={setValue} autoComplete={FIELD[request.kind].autoComplete} inputMode={FIELD[request.kind].inputMode} autoCapitalize="none" autoCorrect="off" spellCheck={false} maxLength={SECURE_INPUT_VALUE_MAX} disabled={busy} autoFocus />
                    </InputGroup>
                    <CheckboxGroup checkedIndices={new Set(save ? [0] : [])}>
                      <CheckboxItem index={0} label={`Save for ${request.origin}`} checked={save} onToggle={() => { if (!busy) setSave(!save); }} />
                    </CheckboxGroup>
                    {request.saved.map(entry => <Button key={entry.credentialId} type="button" variant="secondary" className="h-11 w-full sm:h-9" disabled={busy} onClick={() => void send({ op: 'useSaved', id, credentialId: entry.credentialId })}>Use saved value (saved {SAVED_AT.format(new Date(entry.savedAt))})</Button>)}
                    {error ? <p role="alert" className="text-caption text-destructive [overflow-wrap:anywhere]">{error}</p> : null}
                    <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
                      <Button type="button" variant="secondary" className={TAP} disabled={busy} onClick={() => { setValue(''); void send({ op: 'decline', id }); }}>Decline</Button>
                      <Button type="submit" className={TAP} disabled={busy || !value} loading={busy}>Submit</Button>
                    </div>
                  </form>}
            </>}
      </CardContent>
    </Card>
  </main>;
}
