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
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '../hooks/useAuth.web';
import {
  fetchCloudBackup,
  decryptBackupEnvelope,
  type CloudBackup,
} from '../lib/identity-backup.web';
import {
  hasStoredDeviceIdentity,
  unlockDeviceIdentity,
  generateAndStoreDeviceIdentity,
  clearStoredDeviceIdentity,
  hasLegacyMnemonicStorage,
  decryptLegacyMnemonic,
  clearLegacyMnemonicStorage,
  deriveRootIdentityFromMnemonic,
} from '../lib/storage/identity-store.web';
import {
  isValidMnemonic,
  normalizeMnemonic,
} from '../session/crypto/identity.web';
import type { Identity } from '../types/identity';

type GateStep =
  | 'checking'
  | 'unlock-pin'
  | 'legacy-migrate-pin'
  | 'login'
  | 'fetching-backup'
  | 'backup-password'
  | 'no-backup'
  | 'mnemonic-entry'
  | 'create-pin'
  | 'error';

interface IdentityGateProps {
  onIdentityReady: (identity: Identity) => void;
}

export function IdentityGate({ onIdentityReady }: IdentityGateProps) {
  const auth = useAuth();
  const [step, setStep] = useState<GateStep>('checking');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Form values
  const [pinValue, setPinValue] = useState('');
  const [passwordValue, setPasswordValue] = useState('');
  const [mnemonicValue, setMnemonicValue] = useState('');
  const [newPinValue, setNewPinValue] = useState('');
  const [confirmPinValue, setConfirmPinValue] = useState('');

  // Backup data from cloud
  const backupRef = useRef<CloudBackup | null>(null);
  // Mnemonic ready to be used for device identity creation
  const pendingMnemonicRef = useRef<string | null>(null);

  // ================================================================
  // Initial check
  // ================================================================
  useEffect(() => {
    if (step !== 'checking') return;

    if (hasStoredDeviceIdentity()) {
      setStep('unlock-pin');
      return;
    }

    // Legacy: old-format mnemonic storage needs migration
    if (hasLegacyMnemonicStorage()) {
      setStep('legacy-migrate-pin');
      return;
    }

    if (auth.isLoggedIn) {
      setStep('fetching-backup');
      return;
    }

    setStep('login');
  }, [auth.isLoggedIn, step]);

  // ================================================================
  // Auto-fetch cloud backup
  // ================================================================
  useEffect(() => {
    if (step !== 'fetching-backup' || !auth.token) return;

    let cancelled = false;
    (async () => {
      try {
        const backup = await fetchCloudBackup(auth.token!);
        if (cancelled) return;

        if (backup) {
          backupRef.current = backup;
          setStep('backup-password');
        } else {
          setStep('no-backup');
        }
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to fetch backup');
        setStep('error');
      }
    })();

    return () => { cancelled = true; };
  }, [step, auth.token]);

  // ================================================================
  // Handlers
  // ================================================================

  /**
   * Given a confirmed mnemonic, generate a device identity and call
   * onIdentityReady. Must be called after the PIN has been confirmed.
   */
  const createDeviceIdentityFromMnemonic = useCallback(async (mnemonic: string, pin: string) => {
    const rootIdentity = deriveRootIdentityFromMnemonic(mnemonic);
    const deviceIdentity = await generateAndStoreDeviceIdentity(rootIdentity, pin);
    onIdentityReady(deviceIdentity);
  }, [onIdentityReady]);

  /** Unlock with PIN (new device format). */
  const handleUnlockPin = useCallback(async () => {
    if (!pinValue.trim()) return;
    setLoading(true);
    setError(null);

    try {
      const identity = await unlockDeviceIdentity(pinValue);
      onIdentityReady(identity);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unlock failed');
      setPinValue('');
    } finally {
      setLoading(false);
    }
  }, [pinValue, onIdentityReady]);

  /**
   * Legacy migration: user has old mnemonic storage.
   * Decrypt with their PIN, re-derive root identity, create new device identity.
   */
  const handleLegacyMigratePin = useCallback(async () => {
    if (!pinValue.trim()) return;
    setLoading(true);
    setError(null);

    try {
      const mnemonic = await decryptLegacyMnemonic(pinValue);
      clearLegacyMnemonicStorage();
      // Migrate: create device identity using the recovered mnemonic
      await createDeviceIdentityFromMnemonic(mnemonic, pinValue);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Migration failed');
      setPinValue('');
    } finally {
      setLoading(false);
    }
  }, [pinValue, createDeviceIdentityFromMnemonic]);

  const handleBackupPassword = useCallback(async () => {
    if (!passwordValue.trim() || !backupRef.current) return;
    setLoading(true);
    setError(null);

    try {
      const mnemonic = await decryptBackupEnvelope(backupRef.current.envelope, passwordValue);
      const normalized = normalizeMnemonic(mnemonic);
      if (!isValidMnemonic(normalized)) {
        throw new Error('Decrypted data is not a valid mnemonic.');
      }
      pendingMnemonicRef.current = normalized;
      setPasswordValue('');
      setMnemonicValue('');
      setStep('create-pin');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Decryption failed');
      setPasswordValue('');
    } finally {
      setLoading(false);
    }
  }, [passwordValue]);

  const handleMnemonicEntry = useCallback(() => {
    if (!mnemonicValue.trim()) return;
    setError(null);

    const normalized = normalizeMnemonic(mnemonicValue);
    if (!isValidMnemonic(normalized)) {
      setError('Invalid 24-word recovery phrase.');
      return;
    }

    pendingMnemonicRef.current = normalized;
    setMnemonicValue('');
    setPasswordValue('');
    setStep('create-pin');
  }, [mnemonicValue]);

  const handleMnemonicBack = useCallback(() => {
    setError(null);
    setMnemonicValue('');

    if (!auth.isLoggedIn) {
      setStep('login');
      return;
    }

    setStep(backupRef.current ? 'backup-password' : 'no-backup');
  }, [auth.isLoggedIn]);

  const handleCreatePin = useCallback(async () => {
    if (!newPinValue.trim()) {
      setError('PIN is required.');
      return;
    }
    if (newPinValue.length < 4) {
      setError('PIN must be at least 4 characters.');
      return;
    }
    if (newPinValue !== confirmPinValue) {
      setError('PINs do not match.');
      return;
    }
    if (!pendingMnemonicRef.current) {
      setError('No mnemonic available.');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      await createDeviceIdentityFromMnemonic(pendingMnemonicRef.current, newPinValue);
      // Clear sensitive data from memory
      pendingMnemonicRef.current = null;
      setPasswordValue('');
      setMnemonicValue('');
      setNewPinValue('');
      setConfirmPinValue('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create device identity');
    } finally {
      setLoading(false);
    }
  }, [newPinValue, confirmPinValue, createDeviceIdentityFromMnemonic]);

  const handleKeyDown = useCallback((handler: () => void) => {
    return (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !loading) {
        handler();
      }
    };
  }, [loading]);

  // ================================================================
  // Render
  // ================================================================

  return (
    <div className="h-screen w-screen flex items-center justify-center bg-[#0d1117]">
      <div className="w-full max-w-md mx-4">
        {/* Header */}
        <div className="text-center mb-8">
          <h1 className="text-2xl font-bold text-[#e6edf3] mb-2">GitSpace</h1>
          <p className="text-sm text-[#8b949e]">Secure terminal access</p>
        </div>

        {/* Card */}
        <div className="bg-[#161b22] border border-[#30363d] rounded-lg p-6">
          {step === 'checking' && (
            <div className="text-center py-4">
              <div className="text-[#8b949e]">Loading...</div>
            </div>
          )}

          {step === 'unlock-pin' && (
            <>
              <h2 className="text-lg font-medium text-[#e6edf3] mb-4">Unlock Identity</h2>
              <p className="text-sm text-[#8b949e] mb-4">
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
                className="w-full p-3 text-base bg-[#0d1117] border border-[#30363d] rounded-lg text-[#e6edf3] placeholder:text-[#6e7681] focus:border-[#22c55e] focus:outline-none focus:shadow-glow transition-all disabled:opacity-50"
              />
              {error && (
                <p className="mt-2 text-sm text-[#f85149]">{error}</p>
              )}
              <button
                onClick={handleUnlockPin}
                disabled={loading || !pinValue.trim()}
                className="w-full mt-4 px-5 py-3 bg-[#22c55e] hover:bg-[#16a34a] active:bg-[#16a34a] text-[#0d1117] font-medium rounded-lg min-h-[48px] shadow-glow transition-all disabled:bg-[#21262d] disabled:border-[#30363d] disabled:text-[#6e7681] disabled:cursor-not-allowed disabled:shadow-none"
              >
                {loading ? 'Unlocking...' : 'Unlock'}
              </button>
              <button
                onClick={() => {
                  clearStoredDeviceIdentity();
                  auth.logout();
                  setStep('login');
                  setError(null);
                  setPinValue('');
                }}
                className="w-full mt-2 px-5 py-2 text-sm text-[#8b949e] hover:text-[#e6edf3] transition-all"
              >
                Reset browser identity
              </button>
            </>
          )}

          {step === 'legacy-migrate-pin' && (
            <>
              <h2 className="text-lg font-medium text-[#e6edf3] mb-4">Migrate Identity</h2>
              <p className="text-sm text-[#8b949e] mb-4">
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
                className="w-full p-3 text-base bg-[#0d1117] border border-[#30363d] rounded-lg text-[#e6edf3] placeholder:text-[#6e7681] focus:border-[#22c55e] focus:outline-none focus:shadow-glow transition-all disabled:opacity-50"
              />
              {error && (
                <p className="mt-2 text-sm text-[#f85149]">{error}</p>
              )}
              <button
                onClick={handleLegacyMigratePin}
                disabled={loading || !pinValue.trim()}
                className="w-full mt-4 px-5 py-3 bg-[#22c55e] hover:bg-[#16a34a] active:bg-[#16a34a] text-[#0d1117] font-medium rounded-lg min-h-[48px] shadow-glow transition-all disabled:bg-[#21262d] disabled:border-[#30363d] disabled:text-[#6e7681] disabled:cursor-not-allowed disabled:shadow-none"
              >
                {loading ? 'Migrating...' : 'Continue'}
              </button>
              <button
                onClick={() => {
                  clearLegacyMnemonicStorage();
                  auth.logout();
                  setStep('login');
                  setError(null);
                  setPinValue('');
                }}
                className="w-full mt-2 px-5 py-2 text-sm text-[#8b949e] hover:text-[#e6edf3] transition-all"
              >
                Reset and start over
              </button>
            </>
          )}

          {step === 'login' && (
            <>
              <h2 className="text-lg font-medium text-[#e6edf3] mb-4">Sign In</h2>
              <p className="text-sm text-[#8b949e] mb-6">
                Sign in with GitHub to recover your identity from the cloud, or enter your recovery phrase manually.
              </p>
              <button
                onClick={auth.startLogin}
                className="w-full px-5 py-3 bg-[#22c55e] hover:bg-[#16a34a] active:bg-[#16a34a] text-[#0d1117] font-medium rounded-lg min-h-[48px] shadow-glow transition-all"
              >
                Sign in with GitHub
              </button>
              <div className="flex items-center my-4">
                <div className="flex-1 border-t border-[#30363d]" />
                <span className="px-3 text-xs text-[#6e7681]">or</span>
                <div className="flex-1 border-t border-[#30363d]" />
              </div>
              <button
                onClick={() => { setStep('mnemonic-entry'); setError(null); }}
                className="w-full px-5 py-3 bg-[#21262d] hover:bg-[#30363d] active:bg-[#161b22] text-[#e6edf3] border border-[#30363d] rounded-lg min-h-[48px] transition-all"
              >
                Enter recovery phrase
              </button>
            </>
          )}

          {step === 'fetching-backup' && (
            <div className="text-center py-8">
              <div className="text-[#8b949e] mb-2">Checking for cloud backup...</div>
              <div className="text-xs text-[#6e7681]">This may take a moment</div>
            </div>
          )}

          {step === 'backup-password' && (
            <>
              <h2 className="text-lg font-medium text-[#e6edf3] mb-2">Cloud Backup Found</h2>
              <p className="text-sm text-[#8b949e] mb-4">
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
                className="w-full p-3 text-base bg-[#0d1117] border border-[#30363d] rounded-lg text-[#e6edf3] placeholder:text-[#6e7681] focus:border-[#22c55e] focus:outline-none focus:shadow-glow transition-all disabled:opacity-50"
              />
              {error && (
                <p className="mt-2 text-sm text-[#f85149]">{error}</p>
              )}
              <button
                onClick={handleBackupPassword}
                disabled={loading || !passwordValue.trim()}
                className="w-full mt-4 px-5 py-3 bg-[#22c55e] hover:bg-[#16a34a] active:bg-[#16a34a] text-[#0d1117] font-medium rounded-lg min-h-[48px] shadow-glow transition-all disabled:bg-[#21262d] disabled:border-[#30363d] disabled:text-[#6e7681] disabled:cursor-not-allowed disabled:shadow-none"
              >
                {loading ? 'Decrypting...' : 'Decrypt'}
              </button>
              <button
                onClick={() => { setStep('mnemonic-entry'); setError(null); setPasswordValue(''); }}
                className="w-full mt-2 px-5 py-2 text-sm text-[#8b949e] hover:text-[#e6edf3] transition-all"
              >
                Enter recovery phrase instead
              </button>
            </>
          )}

          {step === 'no-backup' && (
            <>
              <h2 className="text-lg font-medium text-[#e6edf3] mb-2">No Cloud Backup</h2>
              <p className="text-sm text-[#8b949e] mb-4">
                No identity backup found for your account. You can enter your 24-word recovery phrase to set up this browser.
              </p>
              <p className="text-xs text-[#6e7681] mb-4">
                To enable cloud backup, run <code className="text-[#3fb950] bg-[#0d1117] px-1 rounded">gssh user identity backup enable</code> from the CLI.
              </p>
              <button
                onClick={() => { setStep('mnemonic-entry'); setError(null); }}
                className="w-full px-5 py-3 bg-[#22c55e] hover:bg-[#16a34a] active:bg-[#16a34a] text-[#0d1117] font-medium rounded-lg min-h-[48px] shadow-glow transition-all"
              >
                Enter recovery phrase
              </button>
            </>
          )}

          {step === 'mnemonic-entry' && (
            <>
              <h2 className="text-lg font-medium text-[#e6edf3] mb-2">Recovery Phrase</h2>
              <p className="text-sm text-[#8b949e] mb-4">
                Enter your 24-word recovery phrase.
              </p>
              <textarea
                value={mnemonicValue}
                onChange={(e) => setMnemonicValue(e.target.value)}
                placeholder="word1 word2 word3 ..."
                rows={4}
                autoFocus
                className="w-full p-3 text-base bg-[#0d1117] border border-[#30363d] rounded-lg text-[#e6edf3] placeholder:text-[#6e7681] focus:border-[#22c55e] focus:outline-none focus:shadow-glow transition-all resize-none"
              />
              {error && (
                <p className="mt-2 text-sm text-[#f85149]">{error}</p>
              )}
              <button
                onClick={handleMnemonicEntry}
                disabled={!mnemonicValue.trim()}
                className="w-full mt-4 px-5 py-3 bg-[#22c55e] hover:bg-[#16a34a] active:bg-[#16a34a] text-[#0d1117] font-medium rounded-lg min-h-[48px] shadow-glow transition-all disabled:bg-[#21262d] disabled:border-[#30363d] disabled:text-[#6e7681] disabled:cursor-not-allowed disabled:shadow-none"
              >
                Continue
              </button>
              <button
                onClick={handleMnemonicBack}
                className="w-full mt-2 px-5 py-2 text-sm text-[#8b949e] hover:text-[#e6edf3] transition-all"
              >
                Back
              </button>
            </>
          )}

          {step === 'create-pin' && (
            <>
              <h2 className="text-lg font-medium text-[#e6edf3] mb-2">Create Browser PIN</h2>
              <p className="text-sm text-[#8b949e] mb-4">
                Create a PIN to unlock your identity on this browser. This protects your device keys at rest.
              </p>
              <input
                type="password"
                value={newPinValue}
                onChange={(e) => setNewPinValue(e.target.value)}
                placeholder="Create PIN"
                autoFocus
                disabled={loading}
                className="w-full p-3 text-base bg-[#0d1117] border border-[#30363d] rounded-lg text-[#e6edf3] placeholder:text-[#6e7681] focus:border-[#22c55e] focus:outline-none focus:shadow-glow transition-all disabled:opacity-50 mb-3"
              />
              <input
                type="password"
                value={confirmPinValue}
                onChange={(e) => setConfirmPinValue(e.target.value)}
                onKeyDown={handleKeyDown(handleCreatePin)}
                placeholder="Confirm PIN"
                disabled={loading}
                className="w-full p-3 text-base bg-[#0d1117] border border-[#30363d] rounded-lg text-[#e6edf3] placeholder:text-[#6e7681] focus:border-[#22c55e] focus:outline-none focus:shadow-glow transition-all disabled:opacity-50"
              />
              {error && (
                <p className="mt-2 text-sm text-[#f85149]">{error}</p>
              )}
              <button
                onClick={handleCreatePin}
                disabled={loading || !newPinValue.trim() || !confirmPinValue.trim()}
                className="w-full mt-4 px-5 py-3 bg-[#22c55e] hover:bg-[#16a34a] active:bg-[#16a34a] text-[#0d1117] font-medium rounded-lg min-h-[48px] shadow-glow transition-all disabled:bg-[#21262d] disabled:border-[#30363d] disabled:text-[#6e7681] disabled:cursor-not-allowed disabled:shadow-none"
              >
                {loading ? 'Saving...' : 'Save & Continue'}
              </button>
            </>
          )}

          {step === 'error' && (
            <>
              <h2 className="text-lg font-medium text-[#f85149] mb-2">Error</h2>
              <p className="text-sm text-[#8b949e] mb-4">{error}</p>
              <button
                onClick={() => { setStep('login'); setError(null); }}
                className="w-full px-5 py-3 bg-[#21262d] hover:bg-[#30363d] active:bg-[#161b22] text-[#e6edf3] border border-[#30363d] rounded-lg min-h-[48px] transition-all"
              >
                Try again
              </button>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="text-center mt-6 text-xs text-[#6e7681]">
          E2E encrypted terminal access
        </div>
      </div>
    </div>
  );
}
