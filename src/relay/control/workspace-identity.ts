import type { StoredIdentity } from '../../types/identity.js';
import { generateIdentity, serializeIdentity } from '../../lib/tmux-lite/crypto/identity.js';
import { getSecret, setSecret } from '../../utils/secrets.js';
import { SpacesError } from '../../types/errors.js';

const WORKSPACE_IDENTITY_SECRET_PREFIX = 'cloud:workspace:identity:';

function workspaceIdentitySecretKey(workspaceId: string): string {
  return `${WORKSPACE_IDENTITY_SECRET_PREFIX}${workspaceId}`;
}

function parseStoredIdentity(raw: string): StoredIdentity {
  const parsed = JSON.parse(raw) as Partial<StoredIdentity>;
  if (!parsed || typeof parsed !== 'object') {
    throw new SpacesError('Invalid workspace identity payload', 'SYSTEM_ERROR', 2);
  }
  if (!parsed.id || !parsed.signingPublicKey || !parsed.signingSecretKey || !parsed.keyExchangePublicKey || !parsed.keyExchangePrivateKey || !parsed.createdAt) {
    throw new SpacesError('Workspace identity payload is missing required fields', 'SYSTEM_ERROR', 2);
  }

  return {
    id: parsed.id,
    signingPublicKey: parsed.signingPublicKey,
    signingSecretKey: parsed.signingSecretKey,
    keyExchangePublicKey: parsed.keyExchangePublicKey,
    keyExchangePrivateKey: parsed.keyExchangePrivateKey,
    label: parsed.label,
    createdAt: parsed.createdAt,
  };
}

export async function getWorkspaceIdentity(workspaceId: string): Promise<StoredIdentity | null> {
  const raw = await getSecret(workspaceIdentitySecretKey(workspaceId));
  if (!raw) return null;
  return parseStoredIdentity(raw);
}

export async function ensureWorkspaceIdentity(workspaceId: string): Promise<StoredIdentity> {
  const existing = await getWorkspaceIdentity(workspaceId);
  if (existing) {
    return existing;
  }

  const identity = generateIdentity(`cloud-${workspaceId}`);
  const stored = serializeIdentity(identity);
  await setSecret(workspaceIdentitySecretKey(workspaceId), JSON.stringify(stored));
  return stored;
}
