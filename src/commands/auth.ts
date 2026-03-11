/**
 * Authentication commands for gitspace.sh
 *
 * Handles 'gssh user auth login', 'gssh user auth logout', 'gssh user auth status'
 */

import open from 'open';
import os from 'os';
import { getSecret, setSecret, deleteSecret } from '../utils/secrets.js';
import {
  loadKeypair,
  keypairExists,
  getPublicKeyWithoutPassword,
  generateAndSaveKeypair,
} from '../core/identity.js';
import { sign, serializeIdentity } from '../lib/tmux-lite/crypto/identity.js';
import { promptConfirm, promptPassword } from '../utils/prompts.js';
import { logger } from '../utils/logger.js';
import { NoIdentityError, SpacesError } from '../types/errors.js';
import { printHostSyncReport, syncHostConfig } from './host.js';

// API Configuration
const API_BASE = process.env.GITSPACE_API_URL || 'https://api.gitspace.sh';

/**
 * Fetch GitHub Client ID from the API
 */
async function getGitHubClientId(): Promise<string> {
  const res = await fetch(`${API_BASE}/config`);
  if (!res.ok) {
    throw new SpacesError('Failed to fetch config from API', 'SYSTEM_ERROR');
  }
  const config = await res.json() as { github_client_id: string };
  if (!config.github_client_id) {
    throw new SpacesError('GitHub Client ID not configured on server', 'SYSTEM_ERROR');
  }
  return config.github_client_id;
}

// ============================================================================
// Types
// ============================================================================

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

interface GitHubTokenResponse {
  access_token?: string;
  token_type?: string;
  scope?: string;
  error?: string;
  error_description?: string;
}

interface GitspaceAuthResponse {
  token: string;
  user: {
    id: string;
    github_username: string;
    email: string | null;
    name: string | null;
    avatar_url: string | null;
  };
}

// ============================================================================
// Login Command
// ============================================================================

/**
 * Login to gitspace.sh using GitHub Device Flow
 */
export async function authLogin(
  options: {
    yes?: boolean;
    interactiveHostSync?: boolean;
    showHostSyncSummary?: boolean;
  } = {},
): Promise<void> {
  let passwordForIdentity: string | null = null;

  const requireIdentityPassword = (context: string): never => {
    throw new SpacesError(
      `A local identity password is required for ${context} and could not be collected non-interactively.`,
      'USER_ERROR',
      1,
    );
  };

  const requireCollectedPassword = (value: string | null, context: string): string => {
    if (value === null || value.length === 0) {
      requireIdentityPassword(context);
    }

    return value as string;
  };

  if (!keypairExists()) {
    const shouldCreate = options.yes || await promptConfirm(
      'No local device identity found. Create one now?',
      true,
    );

    if (!shouldCreate) {
      throw new NoIdentityError();
    }

    const resolvedCreatePassword = requireCollectedPassword(
      await promptPassword('Create password for local device identity:'),
      'device identity creation',
    );

    const resolvedConfirmPassword = requireCollectedPassword(
      await promptPassword('Confirm local identity password:'),
      'device identity confirmation',
    );

    if (resolvedCreatePassword !== resolvedConfirmPassword) {
      throw new SpacesError('Password confirmation does not match.', 'USER_ERROR', 1);
    }

    await generateAndSaveKeypair(resolvedCreatePassword, os.hostname());
    passwordForIdentity = resolvedCreatePassword;
    logger.success('Created local device identity');
  }

  // Load identity (requires password for signing)
  logger.info('Loading identity...');
  if (!passwordForIdentity) {
    passwordForIdentity = requireCollectedPassword(
      await promptPassword('Enter identity password:'),
      'identity unlock',
    );
  }

  const resolvedPasswordForIdentity = passwordForIdentity;

  let identity;
  try {
    identity = await loadKeypair(resolvedPasswordForIdentity);
  } catch (error) {
    if (error instanceof SpacesError) {
      throw error;
    }
    throw new SpacesError('Failed to load identity', 'USER_ERROR');
  }

  // Step 1: Get GitHub Client ID from API
  logger.info('Starting GitHub authentication...');
  const githubClientId = await getGitHubClientId();

  // Step 2: Request device code from GitHub
  const deviceRes = await fetch('https://github.com/login/device/code', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      client_id: githubClientId,
      scope: 'read:user user:email',
    }),
  });

  if (!deviceRes.ok) {
    throw new SpacesError(
      `GitHub device flow failed: ${await deviceRes.text()}`,
      'SYSTEM_ERROR'
    );
  }

  const deviceData: DeviceCodeResponse = await deviceRes.json();
  const { device_code, user_code, verification_uri, interval } = deviceData;

  // Step 2: Display code and open browser
  logger.log('');
  logger.bold(`! First, copy your one-time code: ${user_code}`);
  logger.log('');

  // Try to open browser, with fallback for headless/SSH environments
  const canOpenBrowser = process.stdout.isTTY && !process.env.SSH_CLIENT;

  if (canOpenBrowser) {
    logger.log(`Press Enter to open ${verification_uri} in your browser...`);
    await waitForEnter();

    try {
      await open(verification_uri);
      logger.info('Browser opened. Waiting for authorization...');
    } catch {
      // Browser open failed (WSL, headless, etc.)
      logger.log('');
      logger.log(`Could not open browser automatically.`);
      logger.log(`Please open this URL manually: ${verification_uri}`);
      logger.log('');
      logger.info('Waiting for authorization...');
    }
  } else {
    // Headless environment (SSH, CI, etc.)
    logger.log(`Open this URL in your browser: ${verification_uri}`);
    logger.log(`Enter the code: ${user_code}`);
    logger.log('');
    logger.info('Waiting for authorization...');
  }

  // Step 3: Poll GitHub for access token
  const githubToken = await pollForGitHubToken(device_code, interval, githubClientId);

  // Step 4: Exchange GitHub token for gitspace.sh token with signature
  logger.info('Completing authentication...');

  const authTimestamp = Date.now();
  const authMessage = `gitspace-device-auth:${authTimestamp}`;
  const messageBytes = new TextEncoder().encode(authMessage);
  const signatureBytes = sign(messageBytes, identity.signing.secretKey);
  const authSignature = Buffer.from(signatureBytes).toString('base64');

  const serialized = serializeIdentity(identity);

  const response = await fetch(`${API_BASE}/auth/github/device`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      github_token: githubToken,
      machine_pubkey: serialized.signingPublicKey,
      device_name: os.hostname(),
      auth_timestamp: authTimestamp,
      auth_signature: authSignature,
    }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Unknown error' }));
    throw new SpacesError(
      `Authentication failed: ${error.error || response.statusText}`,
      'USER_ERROR'
    );
  }

  const { token, user }: GitspaceAuthResponse = await response.json();

  // Step 5: Save token to keychain
  await setSecret('GITSPACE_TOKEN', token);

  logger.log('');
  logger.success('Authentication complete');
  logger.success(`Logged in as ${user.github_username}`);
  logger.success('Token saved to keychain');

  // Step 6: Sync host config (fetches existing subdomains from API)
  // Interactive mode will prompt user to select primary or reserve a subdomain
  const hostSyncReport = await syncHostConfig(options.interactiveHostSync ?? true);
  if (options.showHostSyncSummary ?? true) {
    logger.log('');
    printHostSyncReport(hostSyncReport, 'Hosted relay readiness');
  }
}

// ============================================================================
// Logout Command
// ============================================================================

/**
 * Logout from gitspace.sh (clear local credentials)
 */
export async function authLogout(): Promise<void> {
  const token = await getSecret('GITSPACE_TOKEN');

  if (!token) {
    logger.log('Not logged in');
    return;
  }

  await deleteSecret('GITSPACE_TOKEN');
  logger.success('Logged out');
}

// ============================================================================
// Status Command
// ============================================================================

/**
 * Show current authentication status
 */
export async function authStatus(): Promise<void> {
  const token = await getSecret('GITSPACE_TOKEN');

  if (!token) {
    logger.log('Not logged in');
    logger.dim('Run: gssh user auth login');
    return;
  }

  // Verify token with API
  try {
    const deviceFingerprint = getDeviceFingerprint();
    if (!deviceFingerprint) {
      logger.log('Identity not found. Run: gssh user identity init');
      return;
    }

    const res = await fetch(`${API_BASE}/me`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Device-Fingerprint': deviceFingerprint,
      },
    });

    if (!res.ok) {
      logger.log('Session expired or invalid');
      logger.dim('Run: gssh user auth login');
      return;
    }

    const user = await res.json();
    logger.log(`Logged in as: ${user.github_username}`);
    logger.log(`Email: ${user.email || '(not set)'}`);
    if (user.name) {
      logger.log(`Name: ${user.name}`);
    }
  } catch {
    logger.log('Could not verify session (API unreachable)');
    logger.dim('Token is saved locally');
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

function getDeviceFingerprint(): string | null {
  try {
    const identity = getPublicKeyWithoutPassword();
    return identity?.signingPublicKey ?? null;
  } catch {
    return null;
  }
}

/**
 * Wait for Enter key press
 */
function waitForEnter(): Promise<void> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.once('data', () => {
        process.stdin.setRawMode(false);
        process.stdin.pause(); // Release the event loop
        resolve();
      });
    } else {
      resolve();
    }
  });
}

/**
 * Poll GitHub for access token (Device Flow)
 */
async function pollForGitHubToken(
  deviceCode: string,
  interval: number,
  clientId: string
): Promise<string> {
  const maxAttempts = 60; // ~5 minutes with default 5s interval
  let currentInterval = interval;

  for (let i = 0; i < maxAttempts; i++) {
    await Bun.sleep(currentInterval * 1000);

    // Show polling indicator
    process.stdout.write('.');

    const res = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        client_id: clientId,
        device_code: deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    });

    const data: GitHubTokenResponse = await res.json();

    if (data.access_token) {
      return data.access_token;
    }

    if (data.error === 'authorization_pending') {
      // User hasn't authorized yet, keep polling
      continue;
    }

    if (data.error === 'slow_down') {
      // Rate limited, increase interval
      currentInterval += 5;
      continue;
    }

    if (data.error === 'expired_token') {
      throw new SpacesError(
        'Authorization expired. Please try again.',
        'USER_ERROR'
      );
    }

    if (data.error === 'access_denied') {
      throw new SpacesError('Authorization denied by user.', 'USER_ERROR');
    }

    throw new SpacesError(
      `GitHub auth error: ${data.error_description || data.error}`,
      'SYSTEM_ERROR'
    );
  }

  throw new SpacesError('Authorization timeout. Please try again.', 'USER_ERROR');
}
