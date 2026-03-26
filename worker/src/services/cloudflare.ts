/**
 * Cloudflare API service
 *
 * Handles tunnel and DNS management via Cloudflare API.
 */

import type { Env } from '../types';

type CryptoKeyUsageValue = 'encrypt' | 'decrypt' | 'sign' | 'verify' | 'deriveKey' | 'deriveBits' | 'wrapKey' | 'unwrapKey';

function getCloudflareApiBase(env: Env): string {
  const rawBase = env.CF_API_BASE?.trim();
  if (env.CF_API_BASE === undefined) {
    return 'https://api.cloudflare.com/client/v4';
  }

  if (!rawBase) {
    throw new Error('CF_API_BASE cannot be empty');
  }

  let parsed: URL;
  try {
    parsed = new URL(rawBase);
  } catch {
    throw new Error('CF_API_BASE must be a valid URL');
  }

  const allowedHosts = new Set(['api.cloudflare.com', 'localhost', '127.0.0.1', '::1']);
  if (!allowedHosts.has(parsed.hostname)) {
    throw new Error('CF_API_BASE override is only allowed for api.cloudflare.com or localhost-based test endpoints');
  }

  return parsed.toString().replace(/\/$/, '');
}

/**
 * Remote-managed tunnel creation result.
 */
export interface RemoteManagedTunnelResult {
  id: string;
  name: string;
  token: string;
}

/**
 * Local-managed tunnel creation result.
 */
export interface LocalManagedTunnelResult {
  id: string;
  name: string;
  configSource: 'local';
  tunnelSecret: string;
}

/**
 * Find an existing tunnel by name
 */
async function findTunnelByName(
  env: Env,
  name: string
): Promise<{ id: string; name: string } | null> {
  const tunnelName = `gitspace-${name}`;

  const response = await fetch(
    `${getCloudflareApiBase(env)}/accounts/${env.CF_ACCOUNT_ID}/cfd_tunnel?name=${encodeURIComponent(tunnelName)}`,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${env.CF_API_TOKEN}`,
      },
    }
  );

  if (!response.ok) {
    return null;
  }

  const data = (await response.json()) as {
    success: boolean;
    result: Array<{ id: string; name: string }>;
  };

  if (data.success && data.result.length > 0) {
    return data.result[0] ?? null;
  }

  return null;
}

/**
 * Get tunnel token for an existing tunnel
 */
async function getTunnelToken(
  env: Env,
  tunnelId: string
): Promise<string> {
  const response = await fetch(
    `${getCloudflareApiBase(env)}/accounts/${env.CF_ACCOUNT_ID}/cfd_tunnel/${tunnelId}/token`,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${env.CF_API_TOKEN}`,
      },
    }
  );

  if (!response.ok) {
    throw new Error('Failed to get tunnel token');
  }

  const data = (await response.json()) as {
    success: boolean;
    result: string;
  };

  return data.result;
}

function generateTunnelSecret(): string {
  const secretBytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...secretBytes));
}

interface CloudflareTunnelCreateResponse {
  success: boolean;
  result: { id: string; name?: string; token?: string };
  errors?: Array<{ message: string }>;
}

async function createTunnelViaApi(
  env: Env,
  body: Record<string, unknown>,
): Promise<CloudflareTunnelCreateResponse> {
  const response = await fetch(
    `${getCloudflareApiBase(env)}/accounts/${env.CF_ACCOUNT_ID}/cfd_tunnel`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.CF_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to create tunnel: ${error}`);
  }

  return await response.json() as CloudflareTunnelCreateResponse;
}

async function deleteOrphanedTunnelIfPresent(env: Env, name: string): Promise<void> {
  const existingTunnel = await findTunnelByName(env, name);
  if (!existingTunnel) {
    return;
  }

  console.log(`Deleting orphaned tunnel before reprovisioning: ${existingTunnel.name} (${existingTunnel.id})`);
  await deleteTunnel(env, existingTunnel.id);
}

/**
 * Create a new remote-managed Cloudflare Tunnel for hosted relay traffic.
 */
export async function createRemoteManagedTunnel(
  env: Env,
  name: string
): Promise<RemoteManagedTunnelResult> {
  const tunnelName = `gitspace-${name}`;
  await deleteOrphanedTunnelIfPresent(env, name);

  const data = await createTunnelViaApi(env, {
    name: tunnelName,
    config_src: 'cloudflare',
  });

  if (!data.success) {
    throw new Error(
      `Tunnel creation failed: ${data.errors?.map((e) => e.message).join(', ')}`
    );
  }

  const token = await getTunnelToken(env, data.result.id);
  return {
    id: data.result.id,
    name: data.result.name ?? tunnelName,
    token,
  };
}

/**
 * Create a new locally-managed Cloudflare Tunnel for hosted service ingress.
 */
export async function createLocalManagedTunnel(
  env: Env,
  name: string
): Promise<LocalManagedTunnelResult> {
  const tunnelName = `gitspace-${name}`;
  const tunnelSecret = generateTunnelSecret();
  await deleteOrphanedTunnelIfPresent(env, name);

  const data = await createTunnelViaApi(env, {
    name: tunnelName,
    config_src: 'local',
    tunnel_secret: tunnelSecret,
  });

  if (!data.success) {
    throw new Error(
      `Tunnel creation failed: ${data.errors?.map((e) => e.message).join(', ')}`
    );
  }

  return {
    id: data.result.id,
    name: data.result.name ?? tunnelName,
    configSource: 'local',
    tunnelSecret,
  };
}

/**
 * Configure tunnel ingress rules for the remotely-managed relay tunnel.
 *
 * This tells Cloudflare where to route relay traffic for the root subdomain.
 */
export async function configureTunnelIngress(
  env: Env,
  tunnelId: string,
  subdomain: string
): Promise<void> {
  const response = await fetch(
    `${getCloudflareApiBase(env)}/accounts/${env.CF_ACCOUNT_ID}/cfd_tunnel/${tunnelId}/configurations`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${env.CF_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        config: {
          ingress: [
            {
              hostname: `${subdomain}.gitspace.sh`,
              service: 'http://localhost:4480',
            },
            {
              hostname: `*.${subdomain}.gitspace.sh`,
              service: 'http://localhost:4480',
            },
            {
              service: 'http_status:404',
            },
          ],
        },
      }),
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to configure tunnel ingress: ${error}`);
  }
}
/**
 * Delete a Cloudflare Tunnel
 */
export async function deleteTunnel(env: Env, tunnelId: string): Promise<void> {
  // First, clean up the tunnel connections
  await fetch(
    `${getCloudflareApiBase(env)}/accounts/${env.CF_ACCOUNT_ID}/cfd_tunnel/${tunnelId}/connections`,
    {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${env.CF_API_TOKEN}`,
      },
    }
  );

  // Then delete the tunnel
  const response = await fetch(
    `${getCloudflareApiBase(env)}/accounts/${env.CF_ACCOUNT_ID}/cfd_tunnel/${tunnelId}`,
    {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${env.CF_API_TOKEN}`,
      },
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to delete tunnel: ${error}`);
  }
}

/**
 * Find existing DNS record by name
 */
async function findDNSRecord(
  env: Env,
  zoneId: string,
  name: string
): Promise<{ id: string; content: string } | null> {
  const response = await fetch(
    `${getCloudflareApiBase(env)}/zones/${zoneId}/dns_records?name=${encodeURIComponent(name)}`,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${env.CF_API_TOKEN}`,
      },
    }
  );

  if (!response.ok) {
    return null;
  }

  const data = (await response.json()) as {
    success: boolean;
    result: Array<{ id: string; content: string }>;
  };

  if (data.success && data.result.length > 0) {
    return data.result[0] ?? null;
  }

  return null;
}

function getServeDomain(env: Env): string {
  return env.SERVE_DOMAIN?.trim() || 'gitspace.sh';
}

async function upsertCnameRecord(args: {
  env: Env;
  zoneId: string;
  name: string;
  content: string;
  proxied: boolean;
  comment: string;
}): Promise<string> {
  const existing = await findDNSRecord(args.env, args.zoneId, args.name);
  if (existing) {
    const response = await fetch(
      `${getCloudflareApiBase(args.env)}/zones/${args.zoneId}/dns_records/${existing.id}`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${args.env.CF_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          type: 'CNAME',
          name: args.name,
          content: args.content,
          proxied: args.proxied,
          comment: args.comment,
        }),
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to update DNS record ${args.name}: ${error}`);
    }

    return existing.id;
  }

  const response = await fetch(
    `${getCloudflareApiBase(args.env)}/zones/${args.zoneId}/dns_records`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${args.env.CF_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        type: 'CNAME',
        name: args.name,
        content: args.content,
        proxied: args.proxied,
        comment: args.comment,
      }),
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to create DNS record for ${args.name}: ${error}`);
  }

  const data = (await response.json()) as {
    success: boolean;
    result: { id: string };
  };
  if (!data.success) {
    throw new Error(`Cloudflare rejected DNS record for ${args.name}`);
  }

  return data.result.id;
}

/**
 * Create proxied DNS records for a root relay hostname pair.
 * Returns array of record IDs for later cleanup.
 */
export async function createDNSRecords(
  env: Env,
  subdomain: string,
  tunnelId: string
): Promise<string[]> {
  const recordIds: string[] = [];
  const records = [
    { name: `${subdomain}.gitspace.sh`, comment: `gitspace.sh subdomain for ${subdomain}` },
    { name: `*.${subdomain}.gitspace.sh`, comment: `gitspace.sh wildcard for ${subdomain}` },
  ];

  for (const record of records) {
    const recordId = await upsertCnameRecord({
      env,
      zoneId: env.CF_ZONE_ID,
      name: record.name,
      content: `${tunnelId}.cfargotunnel.com`,
      proxied: true,
      comment: record.comment,
    });
    recordIds.push(recordId);
  }

  return recordIds;
}

export interface ServeRouteDnsRecord {
  hostname: string;
  dnsRecordId: string;
}

export async function createServeRouteDnsRecords(
  env: Env,
  hostnames: string[],
  tunnelId: string
): Promise<ServeRouteDnsRecord[]> {
  const records: ServeRouteDnsRecord[] = [];
  for (const hostname of [...new Set(hostnames)].sort()) {
    const dnsRecordId = await upsertCnameRecord({
      env,
      zoneId: env.CF_ZONE_ID,
      name: hostname,
      content: `${tunnelId}.cfargotunnel.com`,
      proxied: true,
      comment: 'gitspace hosted service route',
    });
    records.push({ hostname, dnsRecordId });
  }

  return records;
}

export function isServeRouteHostname(env: Env, hostname: string): boolean {
  return hostname.toLowerCase().endsWith(`.${getServeDomain(env)}`);
}

export function getServeRouteDomain(env: Env): string {
  return getServeDomain(env);
}

/**
 * Delete DNS records by ID
 */
export async function deleteDNSRecords(
  env: Env,
  recordIds: string[],
  zoneId: string = env.CF_ZONE_ID,
): Promise<void> {
  for (const recordId of recordIds) {
    await fetch(
      `${getCloudflareApiBase(env)}/zones/${zoneId}/dns_records/${recordId}`,
      {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${env.CF_API_TOKEN}`,
        },
      }
    );
  }
}

export async function deleteServeRouteDnsRecords(env: Env, recordIds: string[]): Promise<void> {
  await deleteDNSRecords(env, recordIds, env.CF_ZONE_ID);
}

// ============================================================================
// Cloudflare for SaaS - Custom Hostnames
// ============================================================================

export interface DelegatedDcvRecord {
  cname: string;
  cnameTarget: string;
  status?: string;
  txtName?: string;
  txtValue?: string;
}


/**
 * Custom hostname creation result
 */
export interface CustomHostnameResult {
  id: string;
  hostname: string;
  status: string;
  sslStatus: string;
  dcvDelegationRecords: DelegatedDcvRecord[];
}

function normalizeDelegatedDcvRecords(
  hostname: string,
  rawRecords: unknown,
): DelegatedDcvRecord[] {
  if (!Array.isArray(rawRecords)) {
    return [];
  }

  return rawRecords.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') {
      return [];
    }
    const record = entry as Record<string, unknown>;
    const cname = typeof record.cname === 'string' ? record.cname : '';
    const cnameTarget = typeof record.cname_target === 'string' ? record.cname_target : '';
    if (!cname || !cnameTarget) {
      return [];
    }
    return [{
      cname,
      cnameTarget,
      ...(typeof record.status === 'string' ? { status: record.status } : {}),
      ...(typeof record.txt_name === 'string' ? { txtName: record.txt_name } : {}),
      ...(typeof record.txt_value === 'string' ? { txtValue: record.txt_value } : {}),
    }];
  });
}

async function readCustomHostname(
  env: Env,
  customHostnameId: string,
): Promise<CustomHostnameResult> {
  const response = await fetch(
    `${getCloudflareApiBase(env)}/zones/${env.CF_ZONE_ID}/custom_hostnames/${customHostnameId}`,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${env.CF_API_TOKEN}`,
      },
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to get custom hostname details: ${error}`);
  }

  const data = (await response.json()) as {
    success: boolean;
    result: {
      hostname: string;
      status: string;
      ssl?: { status?: string; dcv_delegation_records?: unknown };
    };
    errors?: Array<{ message: string }>
  };
  if (!data.success) {
    throw new Error(`Failed to read custom hostname ${customHostnameId}: ${data.errors?.map((e) => e.message).join(', ')}`);
  }

  const hostname = data.result.hostname;
  const dcvDelegationRecords = normalizeDelegatedDcvRecords(
    hostname,
    data.result.ssl?.dcv_delegation_records,
  );

  return {
    id: customHostnameId,
    hostname,
    status: data.result.status,
    sslStatus: data.result.ssl?.status ?? 'unknown',
    dcvDelegationRecords,
  };
}

async function waitForCustomHostnameDetails(
  env: Env,
  customHostnameId: string,
): Promise<CustomHostnameResult> {
  let lastResult: CustomHostnameResult | null = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const result = await readCustomHostname(env, customHostnameId);
    lastResult = result;
    if (result.dcvDelegationRecords.length > 0) {
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  if (lastResult) {
    return lastResult;
  }
  throw new Error(`Cloudflare did not return delegated DCV records for ${customHostnameId}`);
}

/**
 * Create a custom hostname with delegated DCV-compatible wildcard SSL.
 *
 * This provisions a certificate for *.subdomain.gitspace.sh.
 */
export async function createCustomHostname(
  env: Env,
  subdomain: string
): Promise<CustomHostnameResult> {
  const hostname = `${subdomain}.gitspace.sh`;

  const response = await fetch(
    `${getCloudflareApiBase(env)}/zones/${env.CF_ZONE_ID}/custom_hostnames`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.CF_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        hostname,
        ssl: {
          method: 'txt',
          type: 'dv',
          wildcard: true,
          settings: {
            min_tls_version: '1.2',
          },
        },
      }),
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to create custom hostname: ${error}`);
  }

  const data = (await response.json()) as {
    success: boolean;
    result: { id: string; hostname: string; status: string };
    errors?: Array<{ message: string }>;
  };

  if (!data.success) {
    throw new Error(
      `Custom hostname creation failed: ${data.errors?.map((e) => e.message).join(', ')}`
    );
  }

  return await waitForCustomHostnameDetails(env, data.result.id);
}

/**
 * Trigger a DCV recheck after delegated DNS records are in place.
 */
export async function refreshCustomHostnameValidation(
  env: Env,
  customHostnameId: string,
): Promise<CustomHostnameResult> {
  const response = await fetch(
    `${getCloudflareApiBase(env)}/zones/${env.CF_ZONE_ID}/custom_hostnames/${customHostnameId}`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${env.CF_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ssl: {
          method: 'txt',
          type: 'dv',
          wildcard: true,
          settings: {
            min_tls_version: '1.2',
          },
        },
      }),
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to refresh custom hostname validation: ${error}`);
  }

  return await readCustomHostname(env, customHostnameId);
}

/**
 * Delete a custom hostname
 */
export async function deleteCustomHostname(
  env: Env,
  customHostnameId: string
): Promise<void> {
  const response = await fetch(
    `${getCloudflareApiBase(env)}/zones/${env.CF_ZONE_ID}/custom_hostnames/${customHostnameId}`,
    {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${env.CF_API_TOKEN}`,
      },
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to delete custom hostname: ${error}`);
  }
}

/**
 * Get custom hostname status (for checking SSL provisioning)
 */
export async function getCustomHostnameStatus(
  env: Env,
  customHostnameId: string
): Promise<{ status: string; sslStatus: string }> {
  const details = await readCustomHostname(env, customHostnameId);
  return {
    status: details.status,
    sslStatus: details.sslStatus,
  };
}

/**
 * Simple encryption for tunnel tokens (stored in D1)
 * Uses AES-GCM with an HKDF-derived key from the ENCRYPTION_KEY secret
 */
const TOKEN_DERIVATION_INFO = new TextEncoder().encode('tunnel-token-v1');
const TOKEN_DERIVATION_SALT = new Uint8Array(32);

async function deriveTokenKey(
  env: Env,
  usages: CryptoKeyUsageValue[]
): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(env.ENCRYPTION_KEY),
    'HKDF',
    false,
    ['deriveKey']
  );

  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: TOKEN_DERIVATION_SALT,
      info: TOKEN_DERIVATION_INFO,
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    usages
  );
}

async function deriveLegacyTokenKey(
  env: Env,
  usages: CryptoKeyUsageValue[]
): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(env.ENCRYPTION_KEY.padEnd(32, '0').slice(0, 32)),
    { name: 'AES-GCM' },
    false,
    usages
  );
}

export async function encryptToken(
  env: Env,
  token: string
): Promise<string> {
  const key = await deriveTokenKey(env, ['encrypt']);

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(token)
  );

  // Combine IV + ciphertext and base64 encode
  const combined = new Uint8Array(iv.length + encrypted.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(encrypted), iv.length);

  return btoa(String.fromCharCode(...combined));
}

/**
 * Decrypt a tunnel token
 */
export async function decryptToken(
  env: Env,
  encryptedToken: string
): Promise<string> {
  const combined = new Uint8Array(
    atob(encryptedToken)
      .split('')
      .map((c) => c.charCodeAt(0))
  );

  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);

  const key = await deriveTokenKey(env, ['decrypt']);

  try {
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      ciphertext
    );

    return new TextDecoder().decode(decrypted);
  } catch {
    const legacyKey = await deriveLegacyTokenKey(env, ['decrypt']);
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      legacyKey,
      ciphertext
    );

    return new TextDecoder().decode(decrypted);
  }
}
