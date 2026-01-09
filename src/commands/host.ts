/**
 * Host commands for gitspace.sh hosting
 *
 * Handles subdomain management: reserve, release, list, set-primary, status
 */

import { existsSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { getSecret, setSecret, deleteSecret } from '../utils/secrets.js';
import { getSpacesDir } from '../core/config.js';
import { getPublicKeyWithoutPassword } from '../core/identity.js';
import { logger } from '../utils/logger.js';
import { SpacesError } from '../types/errors.js';

// API Configuration
const API_BASE = process.env.GITSPACE_API_URL || 'https://api.gitspace.sh';

// ============================================================================
// Types
// ============================================================================

/**
 * Host configuration stored in ~/.gitspace/host.json
 * Non-sensitive data only - tunnel tokens are in keychain
 */
export interface HostConfig {
  subdomain: string;
  subdomains?: string[];
  createdAt: number;
}

interface SubdomainInfo {
  id: string;
  subdomain: string;
  status: string;
  is_primary: number;
  created_at: number;
  updated_at: number;
}

interface SubdomainCreateResponse {
  id: string;
  subdomain: string;
  hosts: string[];
  isPrimary: boolean;
}

// ============================================================================
// Host Config Management
// ============================================================================

/**
 * Get the host config file path
 */
function getHostConfigPath(): string {
  return join(getSpacesDir(), 'host.json');
}

/**
 * Read host config from disk
 */
export function readHostConfig(): HostConfig | null {
  const configPath = getHostConfigPath();
  if (!existsSync(configPath)) {
    return null;
  }

  try {
    const content = readFileSync(configPath, 'utf-8');
    return JSON.parse(content) as HostConfig;
  } catch {
    return null;
  }
}

/**
 * Write host config to disk
 */
function writeHostConfig(config: HostConfig): void {
  const configPath = getHostConfigPath();
  writeFileSync(configPath, JSON.stringify(config, null, 2), {
    encoding: 'utf-8',
    mode: 0o600,
  });
}

/**
 * Sync host config from gitspace.sh API
 * Called after login and subdomain changes to keep local config in sync
 * @param interactive - If true, prompt user to select primary if needed
 */
export async function syncHostConfig(interactive: boolean = false): Promise<void> {
  const token = await getSecret('GITSPACE_TOKEN');
  if (!token) return;

  try {
    const headers = await getAuthHeaders();
    const res = await fetch(`${API_BASE}/subdomains`, { headers });

    if (!res.ok) return;

    const subdomains: SubdomainInfo[] = await res.json();
    const activeSubdomains = subdomains.filter((s) => s.status === 'active');

    // No subdomains - tell user to reserve one
    if (activeSubdomains.length === 0) {
      if (interactive) {
        logger.log('');
        logger.dim('No subdomains reserved yet.');
        logger.dim('To enable remote access, reserve a subdomain:');
        logger.command('  gssh host reserve <name>');
      }
      return;
    }

    // Check for primary
    let primary = activeSubdomains.find((s) => s.is_primary);

    // If no primary set and interactive, ask user to pick one
    if (!primary && interactive && activeSubdomains.length > 0) {
      logger.log('');
      logger.log('Your subdomains:');
      activeSubdomains.forEach((s, i) => {
        logger.log(`  ${i + 1}. ${s.subdomain}.gitspace.sh`);
      });

      if (activeSubdomains.length === 1) {
        // Auto-set the only one as primary
        primary = activeSubdomains[0];
        logger.dim(`Setting ${primary.subdomain}.gitspace.sh as primary...`);
        await hostSetPrimary(primary.subdomain);
      } else {
        logger.log('');
        logger.dim('Select a primary subdomain for this machine:');
        logger.command('  gssh host set-primary <name>');
      }
    }

    if (primary) {
      writeHostConfig({
        subdomain: primary.subdomain,
        subdomains: activeSubdomains.map((s) => s.subdomain),
        createdAt: primary.created_at,
      });

      // Sync tunnel token if not present (e.g., new machine with existing account)
      const existingToken = await getSecret(`TUNNEL_TOKEN_${primary.subdomain}`);
      if (!existingToken) {
        if (interactive) {
          logger.dim(`Fetching tunnel credentials for ${primary.subdomain}.gitspace.sh...`);
        }
        try {
          const tokenRes = await fetch(`${API_BASE}/subdomains/${primary.subdomain}/token`, { headers });
          if (tokenRes.ok) {
            const { tunnelToken } = await tokenRes.json();
            await setSecret(`TUNNEL_TOKEN_${primary.subdomain}`, tunnelToken);
            if (interactive) {
              logger.success('Tunnel credentials saved');
            }
          }
        } catch {
          // Ignore token fetch errors
        }
      }
    }
  } catch {
    // Ignore sync errors
  }
}

// ============================================================================
// Helper: Get Auth Token
// ============================================================================

async function getAuthToken(): Promise<string> {
  const token = await getSecret('GITSPACE_TOKEN');
  if (!token) {
    throw new SpacesError(
      'Not logged in.\n\nRun: gssh auth login',
      'USER_ERROR'
    );
  }
  return token;
}

async function getAuthHeaders(
  extra: Record<string, string> = {}
): Promise<Record<string, string>> {
  const token = await getAuthToken();
  const identity = getPublicKeyWithoutPassword();
  if (!identity) {
    throw new SpacesError(
      'Identity not found.\n\nRun: gssh identity init',
      'USER_ERROR',
      1
    );
  }
  return {
    Authorization: `Bearer ${token}`,
    'X-Device-Fingerprint': identity.signingPublicKey,
    ...extra,
  };
}

// ============================================================================
// Reserve Subdomain
// ============================================================================

/**
 * Reserve a subdomain on gitspace.sh
 */
export async function hostReserve(subdomain: string): Promise<void> {
  const headers = await getAuthHeaders();
  const jsonHeaders = { ...headers, 'Content-Type': 'application/json' };

  // Normalize subdomain
  subdomain = subdomain.toLowerCase().trim();

  // Check availability
  logger.info('Checking availability...');
  const checkRes = await fetch(
    `${API_BASE}/subdomains/check?name=${encodeURIComponent(subdomain)}`,
    {
      headers,
    }
  );

  if (!checkRes.ok) {
    throw new SpacesError(
      `Failed to check availability: ${checkRes.statusText}`,
      'SYSTEM_ERROR'
    );
  }

  const { available, reason } = await checkRes.json();
  if (!available) {
    throw new SpacesError(
      `Subdomain "${subdomain}" is not available: ${reason}`,
      'USER_ERROR'
    );
  }

  // Reserve
  logger.info('Creating tunnel...');
  const res = await fetch(`${API_BASE}/subdomains`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ subdomain }),
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: res.statusText }));
    throw new SpacesError(`Failed to reserve: ${error.error}`, 'USER_ERROR');
  }

  const data: SubdomainCreateResponse = await res.json();

  logger.info('Configuring DNS...');

  // Fetch and store tunnel token in keychain
  logger.info('Saving credentials...');
  const tokenRes = await fetch(
    `${API_BASE}/subdomains/${subdomain}/token`,
    {
      headers,
    }
  );

  if (!tokenRes.ok) {
    throw new SpacesError('Failed to get tunnel token', 'SYSTEM_ERROR');
  }

  const { tunnelToken } = await tokenRes.json();
  await setSecret(`TUNNEL_TOKEN_${subdomain}`, tunnelToken);

  // Update local host config
  await syncHostConfig();

  logger.log('');
  logger.success(`Reserved: ${data.subdomain}.gitspace.sh`);
  logger.log(`  Wildcard: *.${data.subdomain}.gitspace.sh`);
  if (data.isPrimary) {
    logger.dim('  (set as primary)');
  }

  logger.log('');
  logger.log("Run 'spaces' to start hosting.");
}

// ============================================================================
// Release Subdomain
// ============================================================================

/**
 * Release a subdomain
 */
export async function hostRelease(subdomain?: string): Promise<void> {
  const headers = await getAuthHeaders();

  // If no subdomain specified, show list and exit
  if (!subdomain) {
    logger.log('Please specify a subdomain to release:');
    logger.command('  gssh host release <subdomain>');
    logger.log('');
    logger.log('To see your subdomains:');
    logger.command('  gssh host list');
    return;
  }

  subdomain = subdomain.toLowerCase().trim();

  const res = await fetch(`${API_BASE}/subdomains/${subdomain}`, {
    method: 'DELETE',
    headers,
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: res.statusText }));
    throw new SpacesError(`Failed to release: ${error.error}`, 'USER_ERROR');
  }

  // Clear local tunnel token
  await deleteSecret(`TUNNEL_TOKEN_${subdomain}`);

  // Update local host config
  await syncHostConfig();

  logger.success(`Released: ${subdomain}.gitspace.sh`);
}

// ============================================================================
// List Subdomains
// ============================================================================

/**
 * List user's subdomains
 */
export async function hostList(): Promise<void> {
  const headers = await getAuthHeaders();

  const res = await fetch(`${API_BASE}/subdomains`, { headers });

  if (!res.ok) {
    throw new SpacesError(
      `Failed to list subdomains: ${res.statusText}`,
      'SYSTEM_ERROR'
    );
  }

  const subdomains: SubdomainInfo[] = await res.json();

  if (subdomains.length === 0) {
    logger.log('No subdomains reserved.');
    logger.log('');
    logger.log('Reserve one with:');
    logger.command('  gssh host reserve <name>');
    return;
  }

  logger.log('Your subdomains:\n');
  for (const sub of subdomains) {
    const primary = sub.is_primary ? ' (primary)' : '';
    const status = sub.status === 'active' ? '\u2713' : '\u2717';
    logger.log(`  ${status} ${sub.subdomain}.gitspace.sh${primary}`);
    logger.dim(`    Created: ${new Date(sub.created_at).toLocaleDateString()}`);
  }

  logger.log(`\n${subdomains.length}/3 subdomains used (free tier)`);
}

// ============================================================================
// Set Primary
// ============================================================================

/**
 * Set a subdomain as primary for `gssh serve`
 */
export async function hostSetPrimary(subdomain: string): Promise<void> {
  const headers = await getAuthHeaders();
  subdomain = subdomain.toLowerCase().trim();

  const res = await fetch(`${API_BASE}/subdomains/${subdomain}/set-primary`, {
    method: 'POST',
    headers,
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: res.statusText }));
    throw new SpacesError(`Failed: ${error.error}`, 'USER_ERROR');
  }

  // Update local host config
  await syncHostConfig();

  logger.success(`${subdomain}.gitspace.sh is now your primary subdomain`);
}

// ============================================================================
// Status
// ============================================================================

/**
 * Show hosting status
 */
export async function hostStatus(): Promise<void> {
  let headers: Record<string, string>;
  try {
    headers = await getAuthHeaders();
  } catch {
    logger.log('Not logged in or identity not found');
    logger.dim('Run: gssh auth login');
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/subdomains`, { headers });

    if (!res.ok) {
      logger.log('Could not fetch subdomains');
      return;
    }

    const subdomains: SubdomainInfo[] = await res.json();
    const primary = subdomains.find((s) => s.is_primary && s.status === 'active');

    if (!primary) {
      logger.log('No primary subdomain set.');
      logger.dim('Run: gssh host reserve <name>');
      return;
    }

    logger.log(`Primary: ${primary.subdomain}.gitspace.sh`);
    logger.log(`Status: ${primary.status}`);

    // Check if tunnel token exists locally
    let tunnelToken = await getSecret(`TUNNEL_TOKEN_${primary.subdomain}`);

    // Auto-fetch token if missing
    if (!tunnelToken) {
      logger.dim('Tunnel credentials missing, fetching...');
      try {
        const tokenRes = await fetch(`${API_BASE}/subdomains/${primary.subdomain}/token`, { headers });
        if (tokenRes.ok) {
          const { tunnelToken: newToken } = await tokenRes.json();
          await setSecret(`TUNNEL_TOKEN_${primary.subdomain}`, newToken);
          tunnelToken = newToken;
          logger.success('Tunnel credentials synced');
        }
      } catch {
        // Ignore
      }
    }

    logger.log(`Tunnel token: ${tunnelToken ? 'configured' : 'missing'}`);

    if (!tunnelToken) {
      logger.warning('Could not fetch tunnel credentials');
    }
  } catch {
    logger.log('Could not verify status (API unreachable)');

    // Show local config
    const hostConfig = readHostConfig();
    if (hostConfig) {
      logger.log(`Local config: ${hostConfig.subdomain}.gitspace.sh`);
    }
  }
}
