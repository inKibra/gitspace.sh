import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, InputField, InputGroup } from '@gitspace/ui';
import type { StepUpAction } from '@gitspace/protocol/device-grant';
import { requestStepUp, type StepUp } from './passkeys.js';

/** Phone-sized tap target: full width and 44px tall on small screens, inline from `sm` up. */
export const TAP = 'h-11 w-full sm:h-9 sm:w-auto';

/** A prepared value is renewed this long before it expires, so a stale challenge is never offered. */
const RENEW_BEFORE_MS = 10_000;

/** What each step-up refusal from the account means for the person confirming. */
const STEP_UP_MESSAGES: Readonly<Record<string, string>> = {
  STEP_UP_REQUIRED: 'This action needs a confirmation with your passkey or recovery key.',
  STEP_UP_ENROLL_REQUIRED: 'This account has no passkey yet. Enroll one under Settings → Connections → Passkeys first, or confirm with your recovery key.',
  STEP_UP_INVALID: 'GitSpace could not verify that confirmation. Try again.',
  STEP_UP_EXPIRED: 'That confirmation expired. Confirm again.',
  STEP_UP_USED: 'That confirmation was already used. Confirm again.',
};

/** The message for a failed passkey, step-up or account request: step-up codes read as `STEP_UP_MESSAGES`, other errors
 * as their own message. */
export function stepUpErrorMessage(cause: unknown, fallback: string): string {
  if (!(cause instanceof Error)) return fallback;
  const code = 'code' in cause && typeof cause.code === 'string' ? cause.code : '';
  return STEP_UP_MESSAGES[code] ?? (cause.message || fallback);
}

export interface Renewing<T> {
  /** Null while preparing, after a failure, and while `key` is null. */
  value: T | null;
  error: string | null;
  /** Prepares a fresh value now, as after a challenge was spent. */
  renew: () => void;
}

/**
 * Runs `prepare` while `key` is non-null (again whenever `key` changes) and once more shortly before the value's
 * `expiresAt`, so a challenge shown to the person is always current.
 */
export function useRenewing<T>(key: string | null, prepare: (() => Promise<T>) | null, expiresAt: (value: T) => number | null, failure: string): Renewing<T> {
  const [state, setState] = useState<{ value: T | null; error: string | null }>({ value: null, error: null });
  const [round, setRound] = useState(0);
  const latest = useRef({ prepare, expiresAt, failure });
  latest.current = { prepare, expiresAt, failure };
  useEffect(() => {
    setState({ value: null, error: null });
    const run = latest.current.prepare;
    if (key === null || !run) return;
    let live = true;
    let timer: number | undefined;
    run().then(value => {
      if (!live) return;
      setState({ value, error: null });
      const at = latest.current.expiresAt(value);
      if (at !== null) timer = window.setTimeout(() => setRound(current => current + 1), Math.max(0, at - Date.now() - RENEW_BEFORE_MS));
    }, (cause: unknown) => {
      if (live) setState({ value: null, error: stepUpErrorMessage(cause, latest.current.failure) });
    });
    return () => { live = false; window.clearTimeout(timer); };
  }, [key, round]);
  const renew = useCallback(() => setRound(current => current + 1), []);
  return { ...state, renew };
}

/** A current step-up challenge for `action` while it is non-null. */
export function useStepUp(action: StepUpAction | null): Renewing<StepUp> {
  return useRenewing(action ? JSON.stringify(action) : null, action ? () => requestStepUp(action) : null, stepUp => stepUp.expiresAt, 'GitSpace could not start the confirmation. Try again.');
}

/**
 * Confirms one action with a passkey, or with the recovery key instead. The passkey button runs `withPasskey()` as the
 * first thing in its click (Safari runs WebAuthn only inside a gesture); the recovery key is cleared from the field as
 * soon as it is used. `onProof` receives the `x-gitspace-step-up` value and reports its own failures; a challenge it
 * spent must be renewed by the caller. `recoveryOnly` leaves the passkey to the caller's own action buttons.
 */
export function StepUpPrompt({ stepUp, onProof, recoveryOnly = false }: { stepUp: StepUp | null; onProof: (proof: string | null) => void | Promise<void>; recoveryOnly?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recoveryKey, setRecoveryKey] = useState('');
  const run = async (proof: Promise<string | null>) => {
    setBusy(true);
    setError(null);
    try { await onProof(await proof); }
    catch (cause) { setError(stepUpErrorMessage(cause, 'The confirmation failed. Try again.')); }
    finally { setBusy(false); }
  };
  const passkey = stepUp?.passkeyAvailable ?? true;
  const recovery = <form className="flex flex-col gap-3" autoComplete="off" onSubmit={event => {
    event.preventDefault();
    if (!stepUp || busy) return;
    const key = recoveryKey;
    setRecoveryKey('');
    void run(stepUp.withRecoveryKey(key));
  }}>
    <InputGroup className="w-full"><InputField index={0} label="Recovery key" type="password" value={recoveryKey} onChange={setRecoveryKey} placeholder="gsr_…" autoComplete="off" autoCapitalize="none" spellCheck={false} disabled={busy} required /></InputGroup>
    <Button type="submit" variant="secondary" className={TAP} disabled={!stepUp || busy || !recoveryKey.trim()}>Confirm with recovery key</Button>
    <p className="text-caption text-muted-foreground">Your recovery key stays in this page. It is never saved or sent.</p>
  </form>;
  return <div className="flex flex-col gap-3" data-step-up>
    {passkey ? null : <p className="text-caption text-muted-foreground [text-wrap:pretty]">No passkey is enrolled on this account yet. Enroll one under Settings → Connections → Passkeys, or confirm with your recovery key.</p>}
    {passkey && !recoveryOnly ? <Button type="button" variant="primary" className={TAP} loading={busy} disabled={!stepUp || busy} onClick={() => { if (stepUp) void run(stepUp.withPasskey()); }}>Confirm with passkey</Button> : null}
    {error ? <p role="alert" className="text-caption text-destructive [overflow-wrap:anywhere]">{error}</p> : null}
    {passkey
      ? <details className="text-caption">
        <summary className="flex min-h-11 cursor-pointer items-center font-medium sm:min-h-9">Use your recovery key instead</summary>
        <div className="mt-3">{recovery}</div>
      </details>
      : recovery}
  </div>;
}
