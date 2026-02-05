/**
 * Cloudflare API service
 *
 * Handles tunnel and DNS management via Cloudflare API.
 */

import type { Env } from '../types';

/**
 * Tunnel creation result
 */
export interface TunnelResult {
  id: string;
  token: string;
}

/**
 * Find an existing tunnel by name
 */
function getTunnelName(name: string): string {
  return `gitspace-${name.replace(/\./g, '-')}`;
}

async function findTunnelByName(
  env: Env,
  name: string
): Promise<{ id: string; name: string } | null> {
  const tunnelName = getTunnelName(name);

  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/cfd_tunnel?name=${encodeURIComponent(tunnelName)}`,
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
    return data.result[0];
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
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/cfd_tunnel/${tunnelId}/token`,
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

/**
 * Create a new Cloudflare Tunnel (or reuse existing one)
 */
export async function createTunnel(
  env: Env,
  name: string
): Promise<TunnelResult> {
  const tunnelName = getTunnelName(name);

  // Check if tunnel already exists
  const existingTunnel = await findTunnelByName(env, name);

  if (existingTunnel) {
    console.log(`Reusing existing tunnel: ${existingTunnel.name} (${existingTunnel.id})`);

    // Get fresh token for existing tunnel
    const token = await getTunnelToken(env, existingTunnel.id);

    return {
      id: existingTunnel.id,
      token,
    };
  }

  // Create new tunnel
  // Generate tunnel secret (32 random bytes, base64)
  const secretBytes = crypto.getRandomValues(new Uint8Array(32));
  const secret = btoa(String.fromCharCode(...secretBytes));

  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/cfd_tunnel`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.CF_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: tunnelName,
        tunnel_secret: secret,
      }),
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to create tunnel: ${error}`);
  }

  const data = (await response.json()) as {
    success: boolean;
    result: { id: string; token: string };
    errors?: Array<{ message: string }>;
  };

  if (!data.success) {
    throw new Error(
      `Tunnel creation failed: ${data.errors?.map((e) => e.message).join(', ')}`
    );
  }

  return {
    id: data.result.id,
    token: data.result.token,
  };
}

/**
 * Configure tunnel ingress rules
 *
 * This tells cloudflared where to route traffic for the subdomain.
 * Points to local relay server on port 4480.
 */
export async function configureTunnelIngress(
  env: Env,
  tunnelId: string,
  subdomain: string
): Promise<void> {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/cfd_tunnel/${tunnelId}/configurations`,
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
              // Catch-all rule (required)
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
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/cfd_tunnel/${tunnelId}/connections`,
    {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${env.CF_API_TOKEN}`,
      },
    }
  );

  // Then delete the tunnel
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/cfd_tunnel/${tunnelId}`,
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
  name: string
): Promise<{ id: string; content: string } | null> {
  const fullName = name.endsWith('.gitspace.sh') ? name : `${name}.gitspace.sh`;

  const response = await fetch(
    `https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/dns_records?name=${encodeURIComponent(fullName)}`,
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
    return data.result[0];
  }

  return null;
}

/**
 * Update existing DNS record
 */
async function updateDNSRecord(
  env: Env,
  recordId: string,
  name: string,
  tunnelId: string,
  comment: string
): Promise<void> {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/dns_records/${recordId}`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${env.CF_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        type: 'CNAME',
        name,
        content: `${tunnelId}.cfargotunnel.com`,
        proxied: true,
        comment,
      }),
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to update DNS record: ${error}`);
  }
}

/**
 * Create DNS records for a subdomain (or update existing ones)
 * Returns array of record IDs for later cleanup
 */
export async function createDNSRecords(
  env: Env,
  subdomain: string,
  tunnelId: string
): Promise<string[]> {
  const recordIds: string[] = [];

  const records = [
    { name: subdomain, comment: `gitspace.sh subdomain for ${subdomain}` },
    { name: `*.${subdomain}`, comment: `gitspace.sh wildcard for ${subdomain}` },
  ];

  for (const record of records) {
    // Check if record already exists
    const existing = await findDNSRecord(env, record.name);

    if (existing) {
      console.log(`Updating existing DNS record: ${record.name}`);
      await updateDNSRecord(env, existing.id, record.name, tunnelId, record.comment);
      recordIds.push(existing.id);
      continue;
    }

    // Create new record
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/dns_records`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.CF_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          type: 'CNAME',
          name: record.name,
          content: `${tunnelId}.cfargotunnel.com`,
          proxied: true,
          comment: record.comment,
        }),
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to create DNS record for ${record.name}: ${error}`);
    }

    const data = (await response.json()) as {
      success: boolean;
      result: { id: string };
    };

    if (data.success) {
      recordIds.push(data.result.id);
    }
  }

  return recordIds;
}

/**
 * Delete DNS records by ID
 */
export async function deleteDNSRecords(
  env: Env,
  recordIds: string[]
): Promise<void> {
  for (const recordId of recordIds) {
    await fetch(
      `https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/dns_records/${recordId}`,
      {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${env.CF_API_TOKEN}`,
        },
      }
    );
  }
}

// ============================================================================
// Cloudflare for SaaS - Custom Hostnames
// ============================================================================

/**
 * Custom hostname creation result
 */
export interface CustomHostnameResult {
  id: string;
  hostname: string;
  status: string;
}

/**
 * Create a custom hostname with wildcard SSL (Cloudflare for SaaS)
 *
 * This provisions a certificate for *.subdomain.gitspace.sh
 */
export async function createCustomHostname(
  env: Env,
  subdomain: string
): Promise<CustomHostnameResult> {
  // Create hostname WITHOUT the * prefix - Cloudflare adds wildcard SAN automatically
  // when wildcard: true is set. This covers both brad.gitspace.sh AND *.brad.gitspace.sh
  const hostname = `${subdomain}.gitspace.sh`;

  const response = await fetch(
    `https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/custom_hostnames`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.CF_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        hostname,
        ssl: {
          method: 'http',
          type: 'dv',
          wildcard: true, // Adds *.brad.gitspace.sh to the certificate SAN
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

  return {
    id: data.result.id,
    hostname: data.result.hostname,
    status: data.result.status,
  };
}

/**
 * Delete a custom hostname
 */
export async function deleteCustomHostname(
  env: Env,
  customHostnameId: string
): Promise<void> {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/custom_hostnames/${customHostnameId}`,
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
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/custom_hostnames/${customHostnameId}`,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${env.CF_API_TOKEN}`,
      },
    }
  );

  if (!response.ok) {
    throw new Error('Failed to get custom hostname status');
  }

  const data = (await response.json()) as {
    success: boolean;
    result: { status: string; ssl: { status: string } };
  };

  return {
    status: data.result.status,
    sslStatus: data.result.ssl?.status ?? 'unknown',
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
  usages: KeyUsage[]
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
  usages: KeyUsage[]
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
