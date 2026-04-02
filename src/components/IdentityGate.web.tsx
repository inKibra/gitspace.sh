/** @jsxImportSource react */
/**
 * Identity gate screen shown before relay connection.
 */

import type { ReactNode } from 'react';
import type { Identity } from '../types/identity';
import { useIdentityGate } from '../app/react/useIdentityGate.web.js';

interface IdentityGateProps {
  onIdentityReady: (identity: Identity) => void;
}

const FIELD = 'gs-field';
const PRIMARY = 'gs-button-primary';
const SECONDARY = 'gs-button-secondary';

function Section({ title, body, children, kicker = 'Secure access' }: { title: string; body?: ReactNode; children: ReactNode; kicker?: string }) {
  return (
    <div className="gs-shell-card gs-shell-card--auth">
      <div className="gs-shell-header gs-shell-header--spacious">
        <div className="gs-shell-title-stack">
          <div className="gs-shell-kicker">{kicker}</div>
          <h2 className="gs-shell-title">{title}</h2>
          {body ? <div className="gs-shell-subtitle">{body}</div> : null}
        </div>
      </div>
      <div className="gs-shell-body">
        <div className="gs-panel-block">{children}</div>
      </div>
    </div>
  );
}

export function IdentityGate({ onIdentityReady }: IdentityGateProps) {
  const {
    step,
    error,
    loading,
    pinValue,
    setPinValue,
    passwordValue,
    setPasswordValue,
    mnemonicValue,
    setMnemonicValue,
    newPinValue,
    setNewPinValue,
    confirmPinValue,
    setConfirmPinValue,
    startLogin,
    handleUnlockPin,
    handleResetBrowserIdentity,
    handleLegacyMigratePin,
    handleLegacyReset,
    handleBackupPassword,
    handleGoToMnemonicEntry,
    handleMnemonicEntry,
    handleMnemonicBack,
    handleCreatePin,
    handleRetry,
    handleKeyDown,
  } = useIdentityGate(onIdentityReady);

  return (
    <div className="min-h-screen w-screen bg-[var(--gs-bg)] px-3 py-6 sm:px-6 sm:py-10">
      <div className="mx-auto flex min-h-[calc(100dvh-3rem)] max-w-3xl flex-col justify-center gap-5 sm:min-h-[calc(100dvh-5rem)]">
        <div className="gs-panel-block">
          <div className="gs-shell-kicker">GitSpace</div>
          <h1 className="gs-auth-primary-title">Identity handshake</h1>
          <p className="gs-auth-primary-subtitle">Recover or unlock your browser-scoped device identity before opening the board.</p>
        </div>

        {step === 'checking' && (
          <Section title="Preparing browser identity" body="Inspecting local browser state and any stored device certificate.">
            <div className="gs-loading-indicator">Loading identity state…</div>
          </Section>
        )}

        {step === 'unlock-pin' && (
          <Section
            title="Unlock identity"
            body="Enter the browser PIN that protects your local device keys."
          >
            <input
              type="password"
              value={pinValue}
              onChange={(e) => setPinValue(e.target.value)}
              onKeyDown={handleKeyDown(handleUnlockPin)}
              placeholder="Enter PIN"
              autoFocus
              disabled={loading}
              className={FIELD}
            />
            {error ? <p className="gs-danger-text text-sm">{error}</p> : null}
            <div className="gs-auth-actions">
              <button onClick={handleUnlockPin} disabled={loading || !pinValue.trim()} className={PRIMARY}>
                {loading ? 'Unlocking…' : 'Unlock'}
              </button>
              <button onClick={handleResetBrowserIdentity} className={SECONDARY}>Reset browser identity</button>
            </div>
          </Section>
        )}

        {step === 'legacy-migrate-pin' && (
          <Section
            title="Migrate local identity"
            body="This browser has an older identity format. Enter the existing PIN once to migrate it."
            kicker="Migration"
          >
            <input
              type="password"
              value={pinValue}
              onChange={(e) => setPinValue(e.target.value)}
              onKeyDown={handleKeyDown(handleLegacyMigratePin)}
              placeholder="Enter existing PIN"
              autoFocus
              disabled={loading}
              className={FIELD}
            />
            {error ? <p className="gs-danger-text text-sm">{error}</p> : null}
            <div className="gs-auth-actions">
              <button onClick={handleLegacyMigratePin} disabled={loading || !pinValue.trim()} className={PRIMARY}>
                {loading ? 'Migrating…' : 'Continue'}
              </button>
              <button onClick={handleLegacyReset} className={SECONDARY}>Reset and start over</button>
            </div>
          </Section>
        )}

        {step === 'login' && (
          <Section
            title="Sign in"
            body="Recover your identity from cloud backup, or continue with a recovery phrase instead."
          >
            <div className="gs-auth-actions">
              <button onClick={startLogin} className={PRIMARY}>Sign in with GitHub</button>
              <div className="gs-auth-divider">or</div>
              <button onClick={handleGoToMnemonicEntry} className={SECONDARY}>Enter recovery phrase</button>
            </div>
          </Section>
        )}

        {step === 'fetching-backup' && (
          <Section title="Checking cloud backup" body="Looking for a recoverable identity backup tied to your account." kicker="Cloud recovery">
            <div className="gs-loading-indicator">Checking for cloud backup…</div>
            <p className="gs-auth-note">This may take a moment.</p>
          </Section>
        )}

        {step === 'backup-password' && (
          <Section
            title="Cloud backup found"
            body="Enter the backup password used to encrypt your identity snapshot."
            kicker="Cloud recovery"
          >
            <input
              type="password"
              value={passwordValue}
              onChange={(e) => setPasswordValue(e.target.value)}
              onKeyDown={handleKeyDown(handleBackupPassword)}
              placeholder="Backup password"
              autoFocus
              disabled={loading}
              className={FIELD}
            />
            {error ? <p className="gs-danger-text text-sm">{error}</p> : null}
            <div className="gs-auth-actions">
              <button onClick={handleBackupPassword} disabled={loading || !passwordValue.trim()} className={PRIMARY}>
                {loading ? 'Decrypting…' : 'Decrypt'}
              </button>
              <button onClick={handleGoToMnemonicEntry} className={SECONDARY}>Enter recovery phrase instead</button>
            </div>
          </Section>
        )}

        {step === 'no-backup' && (
          <Section
            title="No cloud backup found"
            body="No encrypted identity backup is registered for this account. Continue with a recovery phrase."
            kicker="Cloud recovery"
          >
            <p className="gs-auth-note">
              To enable backup from the CLI, run <span className="gs-inline-code">gssh user identity backup enable</span>.
            </p>
            <button onClick={handleGoToMnemonicEntry} className={PRIMARY}>Enter recovery phrase</button>
          </Section>
        )}

        {step === 'mnemonic-entry' && (
          <Section
            title="Recovery phrase"
            body="Paste the 24-word recovery phrase exactly as issued when the identity was created."
            kicker="Manual recovery"
          >
            <textarea
              value={mnemonicValue}
              onChange={(e) => setMnemonicValue(e.target.value)}
              placeholder="word1 word2 word3 ..."
              rows={4}
              autoFocus
              className={`${FIELD} min-h-[132px] resize-none`}
            />
            {error ? <p className="gs-danger-text text-sm">{error}</p> : null}
            <div className="gs-auth-actions">
              <button onClick={handleMnemonicEntry} disabled={!mnemonicValue.trim()} className={PRIMARY}>Continue</button>
              <button onClick={handleMnemonicBack} className={SECONDARY}>Back</button>
            </div>
          </Section>
        )}

        {step === 'create-pin' && (
          <Section
            title="Create browser PIN"
            body="This PIN protects the device keys stored in this browser. You will use it each time you return."
            kicker="Device protection"
          >
            <input
              type="password"
              value={newPinValue}
              onChange={(e) => setNewPinValue(e.target.value)}
              placeholder="Create PIN"
              autoFocus
              disabled={loading}
              className={FIELD}
            />
            <input
              type="password"
              value={confirmPinValue}
              onChange={(e) => setConfirmPinValue(e.target.value)}
              onKeyDown={handleKeyDown(handleCreatePin)}
              placeholder="Confirm PIN"
              disabled={loading}
              className={FIELD}
            />
            {error ? <p className="gs-danger-text text-sm">{error}</p> : null}
            <button
              onClick={handleCreatePin}
              disabled={loading || !newPinValue.trim() || !confirmPinValue.trim()}
              className={PRIMARY}
            >
              {loading ? 'Saving…' : 'Save & Continue'}
            </button>
          </Section>
        )}

        {step === 'error' && (
          <Section title="Recovery error" body={error ?? 'Something went wrong while preparing your identity.'} kicker="Error">
            <button onClick={handleRetry} className={SECONDARY}>Try again</button>
          </Section>
        )}

        <div className="gs-auth-footer">E2E encrypted terminal access</div>
      </div>
    </div>
  );
}
