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
import {
  GITSPACE_API_BASE as API_BASE,
  fetchWorkerPublicConfig,
  getWorkerCompatibilityWarnings,
  supportsServeCompanionMetadata,
} from '../core/gitspace-api.js';
import { logger } from '../utils/logger.js';
import { SpacesError } from '../types/errors.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Host configuration stored in ~/.gitspace/host.json
 * Non-sensitive data only - tunnel tokens are in keychain
 */
export interface HostConfig {
  subdomain: string;
  serveSubdomain?: string;
  subdomains?: string[];
  createdAt: number;
}

interface SubdomainInfo {
  id: string;
  subdomain: string;
  status: string;
  is_primary: number;
  relay?: boolean | number | null;
  serveSubdomain?: string | null;
  serveStatus?: string | null;
  created_at: number;
  updated_at: number;
}

export interface AccountSubdomain {
  subdomain: string;
  isPrimary: boolean;
  status: string;
}

interface SubdomainCreateResponse {
  id: string;
  subdomain: string;
  tunnelToken?: string;
  serveSubdomain?: string;
  serveTunnelToken?: string;
  hosts: string[];
  isPrimary: boolean;
}

export type HostReadinessStatus = 'configured' | 'missing' | 'error';

export interface HostReadinessCheck {
  status: HostReadinessStatus;
  detail: string;
  fix?: string;
}

export interface HostSyncReport {
  ready: boolean;
  primarySubdomain: string | null;
  serveSubdomain: string | null;
  subdomain: HostReadinessCheck;
  tunnelToken: HostReadinessCheck;
  serveTunnelToken: HostReadinessCheck;
  warnings: string[];
}

function normalizeSubdomain(subdomain: string): string {
  return subdomain.toLowerCase().trim();
}

function configuredCheck(detail: string): HostReadinessCheck {
  return { status: 'configured', detail };
}

function missingCheck(detail: string, fix?: string): HostReadinessCheck {
  return { status: 'missing', detail, fix };
}

function errorCheck(detail: string, fix?: string): HostReadinessCheck {
  return { status: 'error', detail, fix };
}

function createInitialHostSyncReport(): HostSyncReport {
  return {
    ready: false,
    primarySubdomain: null,
    serveSubdomain: null,
    subdomain: missingCheck('Not checked yet.'),
    tunnelToken: missingCheck('Not checked yet.'),
    serveTunnelToken: missingCheck('Not checked yet.'),
    warnings: [],
  };
}

function isConfigured(check: HostReadinessCheck): boolean {
  return check.status === 'configured';
}

interface SubdomainListingSnapshot {
  subdomains: SubdomainInfo[];
  warnings: string[];
  serveMetadataSupported: boolean;
}

function describeCompatibilityFetchError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolveServeCompanion(args: {
  primary: SubdomainInfo;
  serveMetadataSupported: boolean;
}): { serveSubdomain: string | null; missingMetadataWarning?: string } {
  const { primary, serveMetadataSupported } = args;
  if (!serveMetadataSupported) {
    return { serveSubdomain: null };
  }

  if (!Object.hasOwn(primary, 'serveSubdomain') || !Object.hasOwn(primary, 'serveStatus')) {
    return {
      serveSubdomain: null,
      missingMetadataWarning: `gitspace.sh listed ${primary.subdomain}.gitspace.sh without serve companion metadata. Hosted serve readiness cannot be verified safely.`,
    };
  }

  if (primary.serveSubdomain && primary.serveStatus === 'active') {
    return { serveSubdomain: primary.serveSubdomain };
  }

  return { serveSubdomain: null };
}

async function fetchSubdomainListing(headers: Record<string, string>): Promise<SubdomainListingSnapshot> {
  let warnings: string[] = [];
  let serveMetadataSupported = false;

  try {
    const config = await fetchWorkerPublicConfig();
    warnings = getWorkerCompatibilityWarnings(config);
    serveMetadataSupported = supportsServeCompanionMetadata(config);
  } catch (error) {
    warnings = [
      `Could not verify gitspace.sh API compatibility (${describeCompatibilityFetchError(error)}). Hosted serve readiness may be incomplete.`,
    ];
  }

  const res = await fetch(`${API_BASE}/subdomains`, { headers });
  if (!res.ok) {
    await throwIfInvalidDeviceFingerprint(res);
    throw new SpacesError(`Failed to list subdomains: ${res.statusText}`, 'SYSTEM_ERROR', 2);
  }

  const subdomains: SubdomainInfo[] = await res.json();
  return { subdomains, warnings, serveMetadataSupported };
}


async function setPrimarySubdomainViaSync(headers: Record<string, string>, subdomain: string): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}/subdomains/${normalizeSubdomain(subdomain)}/set-primary`, {
      method: 'POST',
      headers,
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureTokenFromApi(args: {
  headers: Record<string, string>;
  apiSubdomain: string;
  secretKey: string;
  description: string;
}): Promise<HostReadinessCheck> {
  const existingToken = await getSecret(args.secretKey);
  if (existingToken) {
    return configuredCheck('Configured in keychain.');
  }

  try {
    const tokenRes = await fetch(`${API_BASE}/subdomains/${args.apiSubdomain}/token`, {
      headers: args.headers,
    });

    if (!tokenRes.ok) {
      return errorCheck(
        `Could not fetch ${args.description} (${tokenRes.status} ${tokenRes.statusText}).`,
        'gssh user host status',
      );
    }

    const tokenData = await tokenRes.json() as { tunnelToken?: string };
    const token = tokenData.tunnelToken;
    if (!token) {
      return errorCheck(
        `${args.description} response missing tunnelToken.`,
        'gssh user host status',
      );
    }

    await setSecret(args.secretKey, token);
    return configuredCheck('Fetched from API and saved to keychain.');
  } catch (error) {
    return errorCheck(
      `Could not fetch ${args.description} (${error instanceof Error ? error.message : String(error)}).`,
      'gssh user host status',
    );
  }
}

function checkStatusLabel(check: HostReadinessCheck): string {
  if (check.status === 'configured') {
    return 'configured';
  }
  if (check.status === 'missing') {
    return 'missing';
  }
  return 'error';
}

function collectRecommendedCommands(report: HostSyncReport): string[] {
  const commands = [report.subdomain.fix, report.tunnelToken.fix, report.serveTunnelToken.fix]
    .filter((value): value is string => Boolean(value));
  return [...new Set(commands)];
}

export function printHostSyncReport(report: HostSyncReport, title: string = 'Hosted relay readiness'): void {
  logger.bold(title);
  logger.log('');

  logger.log(`  Subdomain:         ${checkStatusLabel(report.subdomain)}`);
  logger.dim(`    ${report.subdomain.detail}`);

  logger.log(`  Tunnel token:      ${checkStatusLabel(report.tunnelToken)}`);
  logger.dim(`    ${report.tunnelToken.detail}`);

  logger.log(`  Serve token:       ${checkStatusLabel(report.serveTunnelToken)}`);
  logger.dim(`    ${report.serveTunnelToken.detail}`);

  if (report.primarySubdomain) {
    logger.log(`  Primary host:      ${report.primarySubdomain}.gitspace.sh`);
  }
  if (report.serveSubdomain) {
    logger.log(`  Serve host:        ${report.serveSubdomain}.gitspace.sh`);
  }

  for (const warning of report.warnings) {
    logger.warning(warning);
  }

  logger.log('');
  if (report.ready) {
    logger.success('Hosted relay is ready.');
  } else {
    logger.warning('Hosted relay is not ready yet.');
  }

  const commands = collectRecommendedCommands(report);
  if (commands.length > 0) {
    logger.log('');
    logger.dim('Recommended next steps:');
    for (const cmd of commands) {
      logger.log(`  ${logger.command(cmd)}`);
    }
  }
}

async function logApiFailure(context: string, response: Response): Promise<void> {
  const body = (await response.text().catch(() => '')).trim();
  const bodyPreview = body ? ` body=${JSON.stringify(body.slice(0, 500))}` : '';
  logger.error(`${context}: ${response.status} ${response.statusText}${bodyPreview}`);
}

async function throwIfInvalidDeviceFingerprint(response: Response): Promise<void> {
  if (response.status !== 401) {
    return;
  }

  const body = (await response.clone().text().catch(() => '')).trim();
  if (!body.includes('Invalid device fingerprint')) {
    return;
  }

  throw new SpacesError(
    [
      'Authentication is bound to a different machine identity.',
      '',
      'Run `gssh user auth login` again to register the current device fingerprint with gitspace.sh.',
    ].join('\n'),
    'USER_ERROR',
    1,
  );
}

export function getTunnelTokenKey(subdomain: string): string {
  return `TUNNEL_TOKEN_${normalizeSubdomain(subdomain)}`;
}

export function getServeTokenKey(subdomain: string): string {
  return `${getTunnelTokenKey(subdomain)}_serve`;
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
export async function syncHostConfig(interactive: boolean = false): Promise<HostSyncReport> {
  const report = createInitialHostSyncReport();

  const token = await getSecret('GITSPACE_TOKEN');
  if (!token) {
    report.subdomain = missingCheck('Not logged in to gitspace.sh.', 'gssh user auth login');
    report.tunnelToken = missingCheck('Unavailable until login is complete.', 'gssh user auth login');
    report.serveTunnelToken = missingCheck('Unavailable until login is complete.', 'gssh user auth login');
    return report;
  }

  let headers: Record<string, string>;
  try {
    headers = await getAuthHeaders();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    report.subdomain = errorCheck(detail, 'gssh user identity init');
    report.tunnelToken = missingCheck('Unavailable until identity is configured.', 'gssh user identity init');
    report.serveTunnelToken = missingCheck('Unavailable until identity is configured.', 'gssh user identity init');
    return report;
  }

  let activeSubdomains: SubdomainInfo[] = [];
  let serveMetadataSupported = false;
  try {
    const listing = await fetchSubdomainListing(headers);
    activeSubdomains = listing.subdomains.filter((entry) => entry.status === 'active');
    serveMetadataSupported = listing.serveMetadataSupported;
    report.warnings.push(...listing.warnings);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (error instanceof SpacesError && detail.startsWith('Failed to list subdomains:')) {
      report.subdomain = errorCheck(`Could not list subdomains (${detail.replace('Failed to list subdomains: ', '')}).`, 'gssh user host status');
    } else {
      report.subdomain = errorCheck(`Could not reach gitspace.sh API (${detail}).`, 'gssh user host status');
    }
    report.tunnelToken = missingCheck('Unavailable while API is unreachable.', 'gssh user host status');
    report.serveTunnelToken = missingCheck('Unavailable while API is unreachable.', 'gssh user host status');
    return report;
  }

  if (activeSubdomains.length === 0) {
    report.subdomain = missingCheck(
      'No active subdomain reserved for this account.',
      'gssh user host reserve <name>',
    );
    report.tunnelToken = missingCheck('No relay host selected yet.', 'gssh user host reserve <name>');
    report.serveTunnelToken = missingCheck('No relay host selected yet.', 'gssh user host reserve <name>');

    if (interactive) {
      logger.log('');
      logger.dim('No subdomains reserved yet.');
      logger.dim('To enable remote access, reserve a subdomain:');
      logger.log(`  ${logger.command('gssh user host reserve <name>')}`);
    }

    return report;
  }

  let primary = activeSubdomains.find((entry) => Boolean(entry.is_primary));

  if (!primary && interactive && activeSubdomains.length > 0) {
    logger.log('');
    logger.log('Your subdomains:');
    activeSubdomains.forEach((entry, index) => {
      logger.log(`  ${index + 1}. ${entry.subdomain}.gitspace.sh`);
    });

    if (activeSubdomains.length === 1) {
      const only = activeSubdomains[0]!;
      logger.dim(`Setting ${only.subdomain}.gitspace.sh as primary...`);
      const updated = await setPrimarySubdomainViaSync(headers, only.subdomain);
      if (updated) {
        primary = only;
      } else {
        report.warnings.push(`Could not auto-set ${only.subdomain}.gitspace.sh as primary.`);
      }
    } else {
      logger.log('');
      logger.dim('Select a primary subdomain for this machine:');
      logger.log(`  ${logger.command('gssh user host set-primary <name>')}`);
    }
  }

  if (!primary) {
    report.subdomain = missingCheck('Active subdomains exist, but no primary subdomain is set.', 'gssh user host set-primary <name>');
    report.tunnelToken = missingCheck('Choose a primary subdomain before syncing host config.', 'gssh user host set-primary <name>');
    report.serveTunnelToken = missingCheck('Choose a primary subdomain before syncing host config.', 'gssh user host set-primary <name>');
    report.warnings.push('Host config was not updated because no primary subdomain is set.');
    return report;
  }

  const selected = primary;
  const { serveSubdomain, missingMetadataWarning } = resolveServeCompanion({
    primary: selected,
    serveMetadataSupported,
  });
  if (missingMetadataWarning) {
    report.warnings.push(missingMetadataWarning);
  }

  writeHostConfig({
    subdomain: selected.subdomain,
    ...(serveSubdomain ? { serveSubdomain } : {}),
    subdomains: activeSubdomains.map((entry) => entry.subdomain),
    createdAt: selected.created_at,
  });

  report.primarySubdomain = selected.subdomain;
  report.serveSubdomain = serveSubdomain;
  report.subdomain = configuredCheck(`Primary subdomain ${selected.subdomain}.gitspace.sh is active.`);

  report.tunnelToken = await ensureTokenFromApi({
    headers,
    apiSubdomain: selected.subdomain,
    secretKey: getTunnelTokenKey(selected.subdomain),
    description: `tunnel credentials for ${selected.subdomain}.gitspace.sh`,
  });

  if (missingMetadataWarning) {
    report.serveTunnelToken = errorCheck(
      missingMetadataWarning,
      'Deploy a worker version that exposes serve companion metadata, then re-run `gssh user host status`.',
    );
  } else if (serveSubdomain) {
    report.serveTunnelToken = await ensureTokenFromApi({
      headers,
      apiSubdomain: serveSubdomain,
      secretKey: getServeTokenKey(selected.subdomain),
      description: `serve tunnel credentials for ${serveSubdomain}.gitspace.sh`,
    });
  } else if (serveMetadataSupported) {
    report.serveTunnelToken = missingCheck(
      `No companion serve subdomain exists for ${selected.subdomain}.gitspace.sh.`,
      `gssh user host reserve ${selected.subdomain}`
    );
  } else {
    report.serveTunnelToken = errorCheck(
      `gitspace.sh API compatibility could not be verified for ${selected.subdomain}.gitspace.sh. Serve readiness cannot be confirmed safely.`,
      'Update the gitspace.sh worker, then re-run `gssh user host status`.',
    );
  }

  report.ready = isConfigured(report.subdomain)
    && isConfigured(report.tunnelToken)
    && isConfigured(report.serveTunnelToken);

  return report;
}

// ============================================================================
// Helper: Get Auth Token
// ============================================================================

async function getAuthToken(): Promise<string> {
  const token = await getSecret('GITSPACE_TOKEN');
  if (!token) {
    throw new SpacesError(
      'Not logged in.\n\nRun: gssh user auth login',
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
      'Identity not found.\n\nRun: gssh user identity init',
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

export async function listAccountSubdomains(): Promise<AccountSubdomain[]> {
  const headers = await getAuthHeaders();
  const { subdomains } = await fetchSubdomainListing(headers);
  return subdomains
    .filter((subdomain) => {
      if (subdomain.status !== 'active') {
        return false;
      }

      // Some API versions include a relay capability flag. Respect it when
      // present while remaining compatible with older payloads.
      return subdomain.relay == null || Boolean(subdomain.relay);
    })
    .map((subdomain) => ({
      subdomain: subdomain.subdomain,
      isPrimary: Boolean(subdomain.is_primary),
      status: subdomain.status,
    }));
}

/**
 * Resolve relay-capable subdomains in stable priority order.
 *
 * Priority:
 * 1. Active account subdomains from API (if available)
 * 2. Cached host config fallback
 *
 * Ordering:
 * - Primary subdomain first (from host config)
 * - Remaining subdomains alphabetically
 */
export async function resolveRelaySubdomains(hostConfig: HostConfig | null = readHostConfig()): Promise<string[]> {
  let subdomains: string[] = [];
  let apiPrimarySubdomain: string | null = null;

  try {
    const accountSubdomains = (await listAccountSubdomains())
      .filter((entry) => !entry.subdomain.endsWith('.serve'));
    apiPrimarySubdomain = accountSubdomains.find((entry) => entry.isPrimary)?.subdomain ?? null;
    subdomains = accountSubdomains.map((entry) => entry.subdomain);
  } catch {
    // Account discovery is best-effort; fallback to cached host config.
  }

  if (subdomains.length === 0) {
    if (hostConfig?.subdomains?.length) {
      subdomains = hostConfig.subdomains.filter((subdomain) => !subdomain.endsWith('.serve'));
    } else if (hostConfig?.subdomain && !hostConfig.subdomain.endsWith('.serve')) {
      subdomains = [hostConfig.subdomain];
    }
  }

  const preferredPrimarySubdomain = hostConfig?.subdomain ?? apiPrimarySubdomain;

  return [...new Set(subdomains)].sort((a, b) => {
    if (preferredPrimarySubdomain === a) return -1;
    if (preferredPrimarySubdomain === b) return 1;
    return a.localeCompare(b);
  });
}

export async function resolveHostingSubdomains(hostConfig: HostConfig | null = readHostConfig()): Promise<string[]> {
  let subdomains: string[] = [];

  try {
    const headers = await getAuthHeaders();
    const listing = await fetchSubdomainListing(headers);
    subdomains = listing.subdomains
      .filter((entry) => entry.status === 'active' && entry.serveStatus === 'active' && Boolean(entry.serveSubdomain))
      .map((entry) => entry.serveSubdomain!)
      .filter((entry, index, values) => values.indexOf(entry) === index);
  } catch {
    if (hostConfig?.serveSubdomain) {
      subdomains.push(hostConfig.serveSubdomain);
    }
  }

  return [...new Set(subdomains)].sort((a, b) => a.localeCompare(b));
}

export async function ensureSubdomainTunnelToken(subdomain: string): Promise<string> {
  const normalizedSubdomain = normalizeSubdomain(subdomain);
  const secretKey = getTunnelTokenKey(normalizedSubdomain);
  const existingToken = await getSecret(secretKey);
  if (existingToken) {
    return existingToken;
  }

  const legacyKey = `TUNNEL_TOKEN_${subdomain}`;
  if (legacyKey !== secretKey) {
    const legacyToken = await getSecret(legacyKey);
    if (legacyToken) {
      await setSecret(secretKey, legacyToken);
      await deleteSecret(legacyKey);
      return legacyToken;
    }
  }

  const headers = await getAuthHeaders();
  const tokenRes = await fetch(`${API_BASE}/subdomains/${normalizedSubdomain}/token`, { headers });
  if (!tokenRes.ok) {
    await logApiFailure(`Failed to fetch tunnel token for ${normalizedSubdomain}.gitspace.sh`, tokenRes);
    throw new SpacesError(
      `Failed to fetch tunnel token for ${normalizedSubdomain}.gitspace.sh`,
      'SYSTEM_ERROR',
      2,
    );
  }

  const tokenPayload = await tokenRes.json() as { tunnelToken?: string };
  if (!tokenPayload.tunnelToken) {
    logger.error(
      `No tunnel token returned for ${normalizedSubdomain}.gitspace.sh payload=${JSON.stringify(tokenPayload).slice(0, 500)}`,
    );
    throw new SpacesError(
      `No tunnel token returned for ${normalizedSubdomain}.gitspace.sh`,
      'SYSTEM_ERROR',
      2,
    );
  }

  await setSecret(secretKey, tokenPayload.tunnelToken);
  return tokenPayload.tunnelToken;
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
  subdomain = normalizeSubdomain(subdomain);

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
  let tunnelToken = data.tunnelToken;
  if (!tunnelToken) {
    const tokenRes = await fetch(
      `${API_BASE}/subdomains/${subdomain}/token`,
      {
        headers,
      }
    );

    if (!tokenRes.ok) {
      throw new SpacesError('Failed to get tunnel token', 'SYSTEM_ERROR');
    }

    const tokenData = await tokenRes.json();
    tunnelToken = tokenData.tunnelToken;
  }

  if (!tunnelToken) {
    throw new SpacesError('Failed to get tunnel token', 'SYSTEM_ERROR');
  }

  const serveSubdomain = data.serveSubdomain ?? `${subdomain}.serve`;
  let serveTunnelToken = data.serveTunnelToken;
  if (!serveTunnelToken) {
    const serveTokenRes = await fetch(
      `${API_BASE}/subdomains/${serveSubdomain}/token`,
      {
        headers,
      }
    );

    if (!serveTokenRes.ok) {
      throw new SpacesError('Failed to get serve tunnel token', 'SYSTEM_ERROR');
    }

    const serveTokenData = await serveTokenRes.json();
    serveTunnelToken = serveTokenData.tunnelToken;
  }

  if (!serveTunnelToken) {
    throw new SpacesError('Failed to get serve tunnel token', 'SYSTEM_ERROR');
  }

  await setSecret(getTunnelTokenKey(subdomain), tunnelToken);
  await setSecret(getServeTokenKey(subdomain), serveTunnelToken);

  // Update local host config
  const syncReport = await syncHostConfig();

  logger.log('');
  logger.success(`Reserved: ${data.subdomain}.gitspace.sh`);
  logger.log(`  Wildcard: *.${data.subdomain}.gitspace.sh`);
  logger.log(`Serve: ${serveSubdomain}.gitspace.sh`);
  logger.log(`  Wildcard: *.${serveSubdomain}.gitspace.sh`);
  if (data.isPrimary) {
    logger.dim('  (set as primary)');
  } else if (!syncReport.primarySubdomain) {
    logger.warning('Reserved the subdomain, but no primary subdomain is set for this account.');
    logger.dim('Run `gssh user host set-primary <name>` to choose the default hosted relay and tmux hosting route.');
  }

  for (const warning of syncReport.warnings) {
    logger.warning(warning);
  }

  logger.log('');
  logger.log("Run 'gssh machine tmux hosting select' to publish hosted service URLs.");
  logger.log("Run 'gssh machine serve start' when you also want remote terminal access.");
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
    logger.command('  gssh user host release <subdomain>');
    logger.log('');
    logger.log('To see your subdomains:');
    logger.command('  gssh user host list');
    return;
  }

  subdomain = normalizeSubdomain(subdomain);

  const res = await fetch(`${API_BASE}/subdomains/${subdomain}`, {
    method: 'DELETE',
    headers,
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: res.statusText }));
    throw new SpacesError(`Failed to release: ${error.error}`, 'USER_ERROR');
  }

  // Clear local tunnel token
  await deleteSecret(getTunnelTokenKey(subdomain));
  if (!subdomain.endsWith('.serve')) {
    await deleteSecret(getServeTokenKey(subdomain));
  }

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
    await throwIfInvalidDeviceFingerprint(res);
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
    logger.command('  gssh user host reserve <name>');
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
 * Set a subdomain as the default hosted relay and tmux hosting route.
 */
export async function hostSetPrimary(subdomain: string): Promise<void> {
  const headers = await getAuthHeaders();
  subdomain = normalizeSubdomain(subdomain);

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
 * Check hosted relay readiness with actionable diagnostics.
 */
export async function hostDoctor(): Promise<void> {
  const report = await syncHostConfig(false);
  logger.log('');
  printHostSyncReport(report, 'Hosted relay diagnostics');
}

/**
 * Show hosting status
 */
export async function hostStatus(): Promise<void> {
  let report: HostSyncReport;
  try {
    report = await syncHostConfig(false);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.log(`Could not verify status: ${message}`);

    const hostConfig = readHostConfig();
    if (hostConfig) {
      logger.log(`Local config: ${hostConfig.subdomain}.gitspace.sh`);
      if (hostConfig.serveSubdomain) {
        logger.log(`Local serve: ${hostConfig.serveSubdomain}.gitspace.sh`);
      }
    }
    return;
  }

  if (!report.primarySubdomain) {
    if (report.subdomain.fix === 'gssh user auth login' || report.subdomain.fix === 'gssh user identity init') {
      logger.log(report.subdomain.detail);
      logger.dim(`Run: ${report.subdomain.fix}`);
    } else {
      logger.log('No primary subdomain set.');
      logger.dim('Run: gssh user host set-primary <name>');
    }
    for (const warning of report.warnings) {
      logger.warning(warning);
    }
    return;
  }

  logger.log(`Primary: ${report.primarySubdomain}.gitspace.sh`);
  logger.log(`Status: ${report.subdomain.status}`);
  logger.log(`Serve: ${report.serveSubdomain ? `${report.serveSubdomain}.gitspace.sh` : 'not provisioned'}`);
  logger.log(`Tunnel token: ${checkStatusLabel(report.tunnelToken)}`);
  logger.log(`Serve tunnel token: ${checkStatusLabel(report.serveTunnelToken)}`);

  if (report.serveTunnelToken.status === 'missing' && report.serveTunnelToken.detail.startsWith('No companion serve subdomain exists')) {
    logger.warning(report.serveTunnelToken.detail);
    if (report.serveTunnelToken.fix) {
      logger.dim(`Run: ${report.serveTunnelToken.fix}`);
    }
  } else if (report.serveTunnelToken.status === 'error') {
    logger.warning(report.serveTunnelToken.detail);
    if (report.serveTunnelToken.fix) {
      logger.dim(report.serveTunnelToken.fix);
    }
  }

  for (const warning of report.warnings) {
    logger.warning(warning);
  }
}
