/** @jsxImportSource react */
/**
 * Identity gate screen shown before relay connection.
 *
 * Handles the full identity bootstrap flow:
 *
 * New device (no stored device identity):
 *   1. GitHub OAuth → cloud backup → decrypt mnemonic → create device identity
 *   2. Or: manual mnemonic entry → create device identity
 *   In both cases: root identity (from mnemonic) signs a device cert, then
 *   the device keypair is encrypted with a PIN and stored in localStorage.
 *   The mnemonic is never persisted.
 *
 * Returning device (device identity already stored):
 *   PIN unlock → decrypt device keypair → load device cert → ready
 *
 * What gets stored in localStorage:
 *   - Encrypted device keypair (PIN-protected)
 *   - Plaintext root-signed device certificate (public data, not sensitive)
 *
 * Legacy migration:
 *   If old-format mnemonic storage is detected, the user is prompted to
 *   re-enter their PIN to migrate to the new device keypair format.
 *
 * All state machine logic lives in useIdentityGate (src/app/react).
 */

import type { Identity } from '../types/identity';
import { useIdentityGate } from '../app/react';

interface IdentityGateProps {
  onIdentityReady: (identity: Identity) => void;
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

  // ================================================================
  // Render
  // ================================================================

  return (
    <div className="h-screen w-screen flex items-center justify-center bg-[var(--gs-bg)]">
      <div className="w-full max-w-md mx-4">
        {/* Header */}
        <div className="text-center mb-8">
          <h1 className="text-2xl font-bold text-[var(--gs-text)] mb-2">GitSpace</h1>
          <p className="text-sm text-[var(--gs-text-muted)]">Secure terminal access</p>
        </div>

        {/* Card */}
        <div className="bg-[var(--gs-bg-elevated)] border border-[var(--gs-border)] rounded-lg p-6">
          {step === 'checking' && (
            <div className="text-center py-4">
              <div className="text-[var(--gs-text-muted)]">Loading...</div>
            </div>
          )}

          {step === 'unlock-pin' && (
            <>
              <h2 className="text-lg font-medium text-[var(--gs-text)] mb-4">Unlock Identity</h2>
              <p className="text-sm text-[var(--gs-text-muted)] mb-4">
                Enter your browser unlock PIN to continue.
              </p>
              <input
                type="password"
                value={pinValue}
                onChange={(e) => setPinValue(e.target.value)}
                onKeyDown={handleKeyDown(handleUnlockPin)}
                placeholder="Enter PIN"
                autoFocus
                disabled={loading}
                className="w-full p-3 text-base bg-[var(--gs-bg)] border border-[var(--gs-border)] rounded-lg text-[var(--gs-text)] placeholder:text-[var(--gs-text-dim)] focus:border-[var(--gs-input-focus-border)] focus:outline-none focus:shadow-glow transition-all disabled:opacity-50"
              />
              {error && (
                <p className="mt-2 text-sm text-[var(--gs-danger)]">{error}</p>
              )}
              <button
                onClick={handleUnlockPin}
                disabled={loading || !pinValue.trim()}
                className="w-full mt-4 px-5 py-3 bg-[var(--gs-accent)] hover:bg-[var(--gs-accent-hover)] active:bg-[var(--gs-accent-hover)] text-[var(--gs-text-on-accent)] font-medium rounded-lg min-h-[48px] shadow-glow transition-all disabled:bg-[var(--gs-btn-secondary-bg)] disabled:border-[var(--gs-border)] disabled:text-[var(--gs-text-dim)] disabled:cursor-not-allowed disabled:shadow-none"
              >
                {loading ? 'Unlocking...' : 'Unlock'}
              </button>
              <button
                onClick={handleResetBrowserIdentity}
                className="w-full mt-2 px-5 py-2 text-sm text-[var(--gs-text-muted)] hover:text-[var(--gs-text)] transition-all"
              >
                Reset browser identity
              </button>
            </>
          )}

          {step === 'legacy-migrate-pin' && (
            <>
              <h2 className="text-lg font-medium text-[var(--gs-text)] mb-4">Migrate Identity</h2>
              <p className="text-sm text-[var(--gs-text-muted)] mb-4">
                Your browser identity is being upgraded to the new secure format.
                Enter your existing PIN to continue.
              </p>
              <input
                type="password"
                value={pinValue}
                onChange={(e) => setPinValue(e.target.value)}
                onKeyDown={handleKeyDown(handleLegacyMigratePin)}
                placeholder="Enter existing PIN"
                autoFocus
                disabled={loading}
                className="w-full p-3 text-base bg-[var(--gs-bg)] border border-[var(--gs-border)] rounded-lg text-[var(--gs-text)] placeholder:text-[var(--gs-text-dim)] focus:border-[var(--gs-input-focus-border)] focus:outline-none focus:shadow-glow transition-all disabled:opacity-50"
              />
              {error && (
                <p className="mt-2 text-sm text-[var(--gs-danger)]">{error}</p>
              )}
              <button
                onClick={handleLegacyMigratePin}
                disabled={loading || !pinValue.trim()}
                className="w-full mt-4 px-5 py-3 bg-[var(--gs-accent)] hover:bg-[var(--gs-accent-hover)] active:bg-[var(--gs-accent-hover)] text-[var(--gs-text-on-accent)] font-medium rounded-lg min-h-[48px] shadow-glow transition-all disabled:bg-[var(--gs-btn-secondary-bg)] disabled:border-[var(--gs-border)] disabled:text-[var(--gs-text-dim)] disabled:cursor-not-allowed disabled:shadow-none"
              >
                {loading ? 'Migrating...' : 'Continue'}
              </button>
              <button
                onClick={handleLegacyReset}
                className="w-full mt-2 px-5 py-2 text-sm text-[var(--gs-text-muted)] hover:text-[var(--gs-text)] transition-all"
              >
                Reset and start over
              </button>
            </>
          )}

          {step === 'login' && (
            <>
              <h2 className="text-lg font-medium text-[var(--gs-text)] mb-4">Sign In</h2>
              <p className="text-sm text-[var(--gs-text-muted)] mb-6">
                Sign in with GitHub to recover your identity from the cloud, or enter your recovery phrase manually.
              </p>
              <button
                onClick={startLogin}
                className="w-full px-5 py-3 bg-[var(--gs-accent)] hover:bg-[var(--gs-accent-hover)] active:bg-[var(--gs-accent-hover)] text-[var(--gs-text-on-accent)] font-medium rounded-lg min-h-[48px] shadow-glow transition-all"
              >
                Sign in with GitHub
              </button>
              <div className="flex items-center my-4">
                <div className="flex-1 border-t border-[var(--gs-border)]" />
                <span className="px-3 text-xs text-[var(--gs-text-dim)]">or</span>
                <div className="flex-1 border-t border-[var(--gs-border)]" />
              </div>
              <button
                onClick={handleGoToMnemonicEntry}
                className="w-full px-5 py-3 bg-[var(--gs-btn-secondary-bg)] hover:bg-[var(--gs-border)] active:bg-[var(--gs-bg-elevated)] text-[var(--gs-text)] border border-[var(--gs-border)] rounded-lg min-h-[48px] transition-all"
              >
                Enter recovery phrase
              </button>
            </>
          )}

          {step === 'fetching-backup' && (
            <div className="text-center py-8">
              <div className="text-[var(--gs-text-muted)] mb-2">Checking for cloud backup...</div>
              <div className="text-xs text-[var(--gs-text-dim)]">This may take a moment</div>
            </div>
          )}

          {step === 'backup-password' && (
            <>
              <h2 className="text-lg font-medium text-[var(--gs-text)] mb-2">Cloud Backup Found</h2>
              <p className="text-sm text-[var(--gs-text-muted)] mb-4">
                Enter your identity backup password to decrypt.
              </p>
              <input
                type="password"
                value={passwordValue}
                onChange={(e) => setPasswordValue(e.target.value)}
                onKeyDown={handleKeyDown(handleBackupPassword)}
                placeholder="Backup password"
                autoFocus
                disabled={loading}
                className="w-full p-3 text-base bg-[var(--gs-bg)] border border-[var(--gs-border)] rounded-lg text-[var(--gs-text)] placeholder:text-[var(--gs-text-dim)] focus:border-[var(--gs-input-focus-border)] focus:outline-none focus:shadow-glow transition-all disabled:opacity-50"
              />
              {error && (
                <p className="mt-2 text-sm text-[var(--gs-danger)]">{error}</p>
              )}
              <button
                onClick={handleBackupPassword}
                disabled={loading || !passwordValue.trim()}
                className="w-full mt-4 px-5 py-3 bg-[var(--gs-accent)] hover:bg-[var(--gs-accent-hover)] active:bg-[var(--gs-accent-hover)] text-[var(--gs-text-on-accent)] font-medium rounded-lg min-h-[48px] shadow-glow transition-all disabled:bg-[var(--gs-btn-secondary-bg)] disabled:border-[var(--gs-border)] disabled:text-[var(--gs-text-dim)] disabled:cursor-not-allowed disabled:shadow-none"
              >
                {loading ? 'Decrypting...' : 'Decrypt'}
              </button>
              <button
                onClick={handleGoToMnemonicEntry}
                className="w-full mt-2 px-5 py-2 text-sm text-[var(--gs-text-muted)] hover:text-[var(--gs-text)] transition-all"
              >
                Enter recovery phrase instead
              </button>
            </>
          )}

          {step === 'no-backup' && (
            <>
              <h2 className="text-lg font-medium text-[var(--gs-text)] mb-2">No Cloud Backup</h2>
              <p className="text-sm text-[var(--gs-text-muted)] mb-4">
                No identity backup found for your account. You can enter your 24-word recovery phrase to set up this browser.
              </p>
              <p className="text-xs text-[var(--gs-text-dim)] mb-4">
                To enable cloud backup, run <code className="text-[var(--gs-success)] bg-[var(--gs-bg)] px-1 rounded">gssh user identity backup enable</code> from the CLI.
              </p>
              <button
                onClick={handleGoToMnemonicEntry}
                className="w-full px-5 py-3 bg-[var(--gs-accent)] hover:bg-[var(--gs-accent-hover)] active:bg-[var(--gs-accent-hover)] text-[var(--gs-text-on-accent)] font-medium rounded-lg min-h-[48px] shadow-glow transition-all"
              >
                Enter recovery phrase
              </button>
            </>
          )}

          {step === 'mnemonic-entry' && (
            <>
              <h2 className="text-lg font-medium text-[var(--gs-text)] mb-2">Recovery Phrase</h2>
              <p className="text-sm text-[var(--gs-text-muted)] mb-4">
                Enter your 24-word recovery phrase.
              </p>
              <textarea
                value={mnemonicValue}
                onChange={(e) => setMnemonicValue(e.target.value)}
                placeholder="word1 word2 word3 ..."
                rows={4}
                autoFocus
                className="w-full p-3 text-base bg-[var(--gs-bg)] border border-[var(--gs-border)] rounded-lg text-[var(--gs-text)] placeholder:text-[var(--gs-text-dim)] focus:border-[var(--gs-input-focus-border)] focus:outline-none focus:shadow-glow transition-all resize-none"
              />
              {error && (
                <p className="mt-2 text-sm text-[var(--gs-danger)]">{error}</p>
              )}
              <button
                onClick={handleMnemonicEntry}
                disabled={!mnemonicValue.trim()}
                className="w-full mt-4 px-5 py-3 bg-[var(--gs-accent)] hover:bg-[var(--gs-accent-hover)] active:bg-[var(--gs-accent-hover)] text-[var(--gs-text-on-accent)] font-medium rounded-lg min-h-[48px] shadow-glow transition-all disabled:bg-[var(--gs-btn-secondary-bg)] disabled:border-[var(--gs-border)] disabled:text-[var(--gs-text-dim)] disabled:cursor-not-allowed disabled:shadow-none"
              >
                Continue
              </button>
              <button
                onClick={handleMnemonicBack}
                className="w-full mt-2 px-5 py-2 text-sm text-[var(--gs-text-muted)] hover:text-[var(--gs-text)] transition-all"
              >
                Back
              </button>
            </>
          )}

          {step === 'create-pin' && (
            <>
              <h2 className="text-lg font-medium text-[var(--gs-text)] mb-2">Create Browser PIN</h2>
              <p className="text-sm text-[var(--gs-text-muted)] mb-4">
                Create a PIN to unlock your identity on this browser. This protects your device keys at rest.
              </p>
              <input
                type="password"
                value={newPinValue}
                onChange={(e) => setNewPinValue(e.target.value)}
                placeholder="Create PIN"
                autoFocus
                disabled={loading}
                className="w-full p-3 text-base bg-[var(--gs-bg)] border border-[var(--gs-border)] rounded-lg text-[var(--gs-text)] placeholder:text-[var(--gs-text-dim)] focus:border-[var(--gs-input-focus-border)] focus:outline-none focus:shadow-glow transition-all disabled:opacity-50 mb-3"
              />
              <input
                type="password"
                value={confirmPinValue}
                onChange={(e) => setConfirmPinValue(e.target.value)}
                onKeyDown={handleKeyDown(handleCreatePin)}
                placeholder="Confirm PIN"
                disabled={loading}
                className="w-full p-3 text-base bg-[var(--gs-bg)] border border-[var(--gs-border)] rounded-lg text-[var(--gs-text)] placeholder:text-[var(--gs-text-dim)] focus:border-[var(--gs-input-focus-border)] focus:outline-none focus:shadow-glow transition-all disabled:opacity-50"
              />
              {error && (
                <p className="mt-2 text-sm text-[var(--gs-danger)]">{error}</p>
              )}
              <button
                onClick={handleCreatePin}
                disabled={loading || !newPinValue.trim() || !confirmPinValue.trim()}
                className="w-full mt-4 px-5 py-3 bg-[var(--gs-accent)] hover:bg-[var(--gs-accent-hover)] active:bg-[var(--gs-accent-hover)] text-[var(--gs-text-on-accent)] font-medium rounded-lg min-h-[48px] shadow-glow transition-all disabled:bg-[var(--gs-btn-secondary-bg)] disabled:border-[var(--gs-border)] disabled:text-[var(--gs-text-dim)] disabled:cursor-not-allowed disabled:shadow-none"
              >
                {loading ? 'Saving...' : 'Save & Continue'}
              </button>
            </>
          )}

          {step === 'error' && (
            <>
              <h2 className="text-lg font-medium text-[var(--gs-danger)] mb-2">Error</h2>
              <p className="text-sm text-[var(--gs-text-muted)] mb-4">{error}</p>
              <button
                onClick={handleRetry}
                className="w-full px-5 py-3 bg-[var(--gs-btn-secondary-bg)] hover:bg-[var(--gs-border)] active:bg-[var(--gs-bg-elevated)] text-[var(--gs-text)] border border-[var(--gs-border)] rounded-lg min-h-[48px] transition-all"
              >
                Try again
              </button>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="text-center mt-6 text-xs text-[var(--gs-text-dim)]">
          E2E encrypted terminal access
        </div>
      </div>
    </div>
  );
}
