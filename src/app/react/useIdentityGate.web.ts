import { useState, useEffect, useCallback, useRef } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useAuth } from '../../hooks/useAuth.web';
import {
  fetchCloudBackup,
  decryptBackupEnvelope,
  type CloudBackup,
} from '../../lib/identity-backup.web';
import {
  hasStoredDeviceIdentity,
  unlockDeviceIdentity,
  generateAndStoreDeviceIdentity,
  clearStoredDeviceIdentity,
  hasLegacyMnemonicStorage,
  decryptLegacyMnemonic,
  clearLegacyMnemonicStorage,
  deriveRootIdentityFromMnemonic,
  loadEnrolledBrowserIdentity,
  storeEnrolledBrowserIdentity,
} from '../../lib/storage/identity-store.web';
import {
  isValidMnemonic,
  normalizeMnemonic,
} from '../../session/crypto/identity.web';
import type { Identity } from '../../types/identity';

export type GateStep =
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

export interface UseIdentityGateReturn {
  step: GateStep;
  error: string | null;
  loading: boolean;
  // Controlled form values
  pinValue: string;
  setPinValue: (v: string) => void;
  passwordValue: string;
  setPasswordValue: (v: string) => void;
  mnemonicValue: string;
  setMnemonicValue: (v: string) => void;
  newPinValue: string;
  setNewPinValue: (v: string) => void;
  confirmPinValue: string;
  setConfirmPinValue: (v: string) => void;
  // Auth passthrough
  startLogin: () => void;
  // Named action handlers
  handleUnlockPin: () => void;
  /** Clear device identity, logout, and restart from login. */
  handleResetBrowserIdentity: () => void;
  handleLegacyMigratePin: () => void;
  /** Clear legacy storage, logout, and restart from login. */
  handleLegacyReset: () => void;
  handleBackupPassword: () => void;
  /** Navigate to the mnemonic-entry step (clears error and password field). */
  handleGoToMnemonicEntry: () => void;
  handleMnemonicEntry: () => void;
  handleMnemonicBack: () => void;
  handleCreatePin: () => void;
  /** Return to login step and clear the fatal error. */
  handleRetry: () => void;
  handleKeyDown: (handler: () => void) => (e: ReactKeyboardEvent) => void;
}

/**
 * Owns the full identity bootstrap / auth state machine for the identity gate
 * UI. All low-level auth, storage, and crypto operations live here; the
 * component renders from the returned state and calls the returned handlers.
 */
export function useIdentityGate(
  onIdentityReady: (identity: Identity) => void,
): UseIdentityGateReturn {
  const auth = useAuth();
  const [step, setStep] = useState<GateStep>('checking');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const [pinValue, setPinValue] = useState('');
  const [passwordValue, setPasswordValue] = useState('');
  const [mnemonicValue, setMnemonicValue] = useState('');
  const [newPinValue, setNewPinValue] = useState('');
  const [confirmPinValue, setConfirmPinValue] = useState('');

  // Cloud backup data fetched during the fetching-backup step.
  const backupRef = useRef<CloudBackup | null>(null);
  // Validated mnemonic waiting for a PIN to be set.
  const pendingMnemonicRef = useRef<string | null>(null);

  // ================================================================
  // Initial check
  // ================================================================
  useEffect(() => {
    if (step !== 'checking') return;
    let cancelled = false;

    async function check() {
      // Dev mode: check for auto-provisioned identity from bun run dev:web
      const devIdentity = loadEnrolledBrowserIdentity();
      if (devIdentity) {
        if (!cancelled) onIdentityReady(devIdentity.identity);
        return;
      }

      // Try fetching enrolled identity from dev server using enrollment token from URL.
      // The token is a one-time secret passed via ?enroll=TOKEN in the dev URL.
      const enrollToken = new URLSearchParams(window.location.search).get('enroll');
      if (enrollToken) {
        try {
          const res = await fetch(`/__enroll?token=${encodeURIComponent(enrollToken)}`);
          if (res.ok) {
            const data = await res.json();
            if (data?.identity && data?.deviceCert) {
              storeEnrolledBrowserIdentity(data);
              const loaded = loadEnrolledBrowserIdentity();
              if (loaded && !cancelled) {
                // Clean the enrollment token from the URL so it isn't leaked
                // in bookmarks, history, or referrer headers.
                const cleanUrl = new URL(window.location.href);
                cleanUrl.searchParams.delete('enroll');
                window.history.replaceState({}, '', cleanUrl.toString());
                onIdentityReady(loaded.identity);
                return;
              }
            }
          }
        } catch {
          // Dev endpoint not available
        }
      }

      if (cancelled) return;

      // Normal flow
      if (hasStoredDeviceIdentity()) {
        setStep('unlock-pin');
        return;
      }

      if (hasLegacyMnemonicStorage()) {
        setStep('legacy-migrate-pin');
        return;
      }

      if (auth.isLoggedIn) {
        setStep('fetching-backup');
        return;
      }

      setStep('login');
    }

    check();
    return () => { cancelled = true; };
  }, [auth.isLoggedIn, step]); // eslint-disable-line react-hooks/exhaustive-deps

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
   * Given a confirmed mnemonic, generate a device identity and signal ready.
   * Must only be called after the PIN has been confirmed.
   */
  const createDeviceIdentityFromMnemonic = useCallback(
    async (mnemonic: string, pin: string) => {
      const rootIdentity = deriveRootIdentityFromMnemonic(mnemonic);
      const deviceIdentity = await generateAndStoreDeviceIdentity(rootIdentity, pin);
      onIdentityReady(deviceIdentity);
    },
    [onIdentityReady],
  );

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

  const handleResetBrowserIdentity = useCallback(() => {
    clearStoredDeviceIdentity();
    auth.logout();
    setStep('login');
    setError(null);
    setPinValue('');
  }, [auth]);

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
      // Migrate only after the new device identity is durably stored.
      await createDeviceIdentityFromMnemonic(mnemonic, pinValue);
      clearLegacyMnemonicStorage();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Migration failed');
      setPinValue('');
    } finally {
      setLoading(false);
    }
  }, [pinValue, createDeviceIdentityFromMnemonic]);

  const handleLegacyReset = useCallback(() => {
    clearLegacyMnemonicStorage();
    auth.logout();
    setStep('login');
    setError(null);
    setPinValue('');
  }, [auth]);

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

  const handleGoToMnemonicEntry = useCallback(() => {
    setStep('mnemonic-entry');
    setError(null);
    setPasswordValue('');
  }, []);

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

  const handleRetry = useCallback(() => {
    setStep('login');
    setError(null);
  }, []);

  const handleKeyDown = useCallback(
    (handler: () => void) => (e: ReactKeyboardEvent) => {
      if (e.key === 'Enter' && !loading) {
        handler();
      }
    },
    [loading],
  );

  return {
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
    startLogin: auth.startLogin,
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
  };
}
