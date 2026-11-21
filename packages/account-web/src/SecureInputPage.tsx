import { useEffect, useState, type FormEvent } from 'react';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, CheckboxGroup, CheckboxItem, InputField, InputGroup } from '@gitspace/ui';
import { RuntimeSecureInputOutcomeSchema, RuntimeSecureInputViewSchema, SECURE_INPUT_API_PATH, SECURE_INPUT_VALUE_MAX, type RuntimeSecureInputKind, type RuntimeSecureInputOutcome, type RuntimeSecureInputPageRequest, type RuntimeSecureInputView } from '@gitspace/protocol-runtime/secure-input';
import { STEP_UP_HEADER } from '@gitspace/protocol/device-grant';
import { z } from 'zod';
import { createDeviceSignedFetch, DeviceRejectedError, loadDevice } from './device.js';
import type { StepUp } from './passkeys.js';
import { StepUpPrompt, stepUpErrorMessage, TAP, useStepUp } from './StepUpPrompt.js';
import { SECURE_INPUT_KIND_LABEL } from './SecureInputCard.js';
import { STANDALONE_PAGE } from './standalonePage.js';

const signedFetch = createDeviceSignedFetch(loadDevice, code => { throw new DeviceRejectedError(code); });
const ErrorSchema = z.object({ status: z.literal('error'), error: z.object({ code: z.string().optional(), message: z.string() }) });

/** A refusal from the page's API, with the account's error code (`STEP_UP_*` when the step-up was refused). */
class SecureInputError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'SecureInputError';
  }
}
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

/** Posts one request to the page's API (`RuntimeSecureInputPageRequestSchema`) with `headers` (the step-up, when one is
 * due) and reads the account's answer: its value, or the error it gave. */
async function post<T>(request: RuntimeSecureInputPageRequest, schema: z.ZodType<T>, headers: Readonly<Record<string, string>> = {}): Promise<T> {
  const response = await signedFetch(SECURE_INPUT_API_PATH, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(request) });
  const body: unknown = await response.json().catch(() => null);
  const failure = ErrorSchema.safeParse(body);
  if (failure.success) throw new SecureInputError(failure.data.error.code ?? '', failure.data.error.message);
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
 * Opening the request takes a `secure-input.open` step-up; Submit and Use saved value take a `secure-input.answer`
 * step-up, prefetched while the request is open so the click runs the passkey straight away; Decline takes none.
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
  const opening = useStepUp(view === null ? { purpose: 'secure-input.open', targets: [id] } : null);
  const [loading, setLoading] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const answering = useStepUp(open ? { purpose: 'secure-input.answer', targets: [id] } : null);
  // A recovery-key proof answers the one challenge it signed: a renewed challenge needs a new one.
  const [recovery, setRecovery] = useState<{ stepUp: StepUp; proof: string | null } | null>(null);
  const challenge = answering.value;
  const recovered = recovery && recovery.stepUp === challenge ? recovery : null;
  const canAnswer = challenge !== null && (recovered !== null || challenge.passkeyAvailable);
  async function openRequest(proof: string | null) {
    setLoading(true); setOpenError(null);
    try { setView({ request: await post({ op: 'view', id }, RuntimeSecureInputViewSchema, proof ? { [STEP_UP_HEADER]: proof } : {}) }); }
    catch (failure) {
      if (failure instanceof SecureInputError && failure.code.startsWith('STEP_UP_')) {
        setOpenError(stepUpErrorMessage(failure, 'GitSpace could not open this request.'));
        opening.renew();
      } else setView({ error: failure instanceof Error ? failure.message : 'GitSpace could not load this request.' });
    } finally { setLoading(false); }
  }
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
  /** Sends an answer; `proof` is the pending step-up for Submit and Use saved value, null for Decline. */
  async function send(answer: RuntimeSecureInputPageRequest, proof: Promise<string | null> | null) {
    setBusy(true); setError(null);
    try {
      const header = proof ? await proof : null;
      setOutcome(await post(answer, RuntimeSecureInputOutcomeSchema, header ? { [STEP_UP_HEADER]: header } : {}));
    } catch (failure) {
      setError(stepUpErrorMessage(failure, 'GitSpace could not answer this request.'));
    } finally {
      setBusy(false);
      if (proof) { setRecovery(null); answering.renew(); }
    }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !value || !challenge || !canAnswer) return;
    const proof = recovered ? Promise.resolve(recovered.proof) : challenge.withPasskey();
    const typed = value;
    setValue('');
    void send({ op: 'submit', id, value: typed, save }, proof);
  }
  const seconds = Math.max(0, Math.ceil(left / 1000));
  return <main className={`${STANDALONE_PAGE} items-center p-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:p-6`}>
    <Card className="w-full max-w-lg shrink-0 sm:my-auto">
      <CardHeader>
        <CardTitle>Enter a secret for an agent</CardTitle>
        <CardDescription>{request ? `Workspace ${request.workspace}` : 'GitSpace secure input'}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {view === null ? loading ? <p role="status" className="text-body text-muted-foreground">Loading the request…</p>
          : <div className="flex flex-col gap-3">
            <p className="text-body text-foreground">Confirm with your passkey to open this request.</p>
            {opening.error ?? openError ? <p role="alert" className="text-caption text-destructive [overflow-wrap:anywhere]">{opening.error ?? openError}</p> : null}
            <StepUpPrompt stepUp={opening.value} onProof={openRequest} />
          </div>
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
                  : <><form className="flex flex-col gap-4" autoComplete="off" onSubmit={submit}>
                    <InputGroup className="w-full">
                      <InputField index={0} label={SECURE_INPUT_KIND_LABEL[request.kind]} type="password" value={value} onChange={setValue} autoComplete={FIELD[request.kind].autoComplete} inputMode={FIELD[request.kind].inputMode} autoCapitalize="none" autoCorrect="off" spellCheck={false} maxLength={SECURE_INPUT_VALUE_MAX} disabled={busy} autoFocus />
                    </InputGroup>
                    <CheckboxGroup checkedIndices={new Set(save ? [0] : [])}>
                      <CheckboxItem index={0} label={`Save for ${request.origin}`} checked={save} onToggle={() => { if (!busy) setSave(!save); }} />
                    </CheckboxGroup>
                    {request.saved.map(entry => <Button key={entry.credentialId} type="button" variant="secondary" className="h-11 w-full sm:h-9" disabled={busy || !canAnswer} onClick={() => {
                      if (!challenge) return;
                      const proof = recovered ? Promise.resolve(recovered.proof) : challenge.withPasskey();
                      void send({ op: 'useSaved', id, credentialId: entry.credentialId }, proof);
                    }}>Use saved value (saved {SAVED_AT.format(new Date(entry.savedAt))})</Button>)}
                    {challenge?.passkeyAvailable && !recovered ? <p className="text-caption text-muted-foreground">Submit and Use saved value ask for your passkey.</p> : null}
                    {error ? <p role="alert" className="text-caption text-destructive [overflow-wrap:anywhere]">{error}</p> : null}
                    <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
                      <Button type="button" variant="secondary" className={TAP} disabled={busy} onClick={() => { setValue(''); void send({ op: 'decline', id }, null); }}>Decline</Button>
                      <Button type="submit" className={TAP} disabled={busy || !value || !canAnswer} loading={busy}>Submit</Button>
                    </div>
                  </form>
                  {answering.error ? <p role="alert" className="text-caption text-destructive [overflow-wrap:anywhere]">{answering.error}</p> : null}
                  {recovered ? <p role="status" className="text-caption text-foreground">Recovery key accepted. Submit or use a saved value to finish.</p> : null}
                  {challenge && !recovered ? <StepUpPrompt stepUp={challenge} recoveryOnly onProof={proof => setRecovery({ stepUp: challenge, proof })} /> : null}
                  </>}
            </>}
      </CardContent>
    </Card>
  </main>;
}
