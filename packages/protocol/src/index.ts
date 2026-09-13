export const ARTIFACT_ENCRYPTION_VERSION = 1 as const;
export const ARTIFACT_NONCE_BYTES = 12;

export * from './relay.js';

function ownedBuffer(bytes: Uint8Array): ArrayBuffer {
  const owned = new Uint8Array(bytes.byteLength);
  owned.set(bytes);
  return owned.buffer;
}

export async function encryptArtifactBytes(
  plaintext: Uint8Array,
  key: Uint8Array,
  nonce = crypto.getRandomValues(new Uint8Array(ARTIFACT_NONCE_BYTES)),
): Promise<Uint8Array> {
  if (key.byteLength !== 32) throw new RangeError('Artifact encryption key must be 32 bytes');
  if (nonce.byteLength !== ARTIFACT_NONCE_BYTES) throw new RangeError(`Artifact nonce must be ${ARTIFACT_NONCE_BYTES} bytes`);
  const cryptoKey = await crypto.subtle.importKey('raw', ownedBuffer(key), 'AES-GCM', false, ['encrypt']);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: ownedBuffer(nonce) },
    cryptoKey,
    ownedBuffer(plaintext),
  );
  const sealed = new Uint8Array(1 + nonce.byteLength + ciphertext.byteLength);
  sealed[0] = ARTIFACT_ENCRYPTION_VERSION;
  sealed.set(nonce, 1);
  sealed.set(new Uint8Array(ciphertext), 1 + nonce.byteLength);
  return sealed;
}

export async function decryptArtifactBytes(sealed: Uint8Array, key: Uint8Array): Promise<Uint8Array> {
  if (key.byteLength !== 32) throw new RangeError('Artifact encryption key must be 32 bytes');
  if (sealed.byteLength <= 1 + ARTIFACT_NONCE_BYTES || sealed[0] !== ARTIFACT_ENCRYPTION_VERSION) {
    throw new Error('Unsupported or malformed encrypted artifact');
  }
  const nonce = sealed.subarray(1, 1 + ARTIFACT_NONCE_BYTES);
  const ciphertext = sealed.subarray(1 + ARTIFACT_NONCE_BYTES);
  const cryptoKey = await crypto.subtle.importKey('raw', ownedBuffer(key), 'AES-GCM', false, ['decrypt']);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: ownedBuffer(nonce) },
    cryptoKey,
    ownedBuffer(ciphertext),
  );
  return new Uint8Array(plaintext);
}

export * from './credential-vault.js';
export * from './device-grant.js';
export * from './machine-pairing.js';
export * from './client.js';
export * from './routed-transport.js';
export * from './deployment.js';
export * from './cron-contract.js';
export * from './inspector-contract.js';
export * from './mcp-contract.js';
export * from './rpc-contract.js';
export * from './transcript.js';
export * from './project-authority.js';
export * from './artifact-storage.js';
export * from './rpc-crypto.js';
export * from './skills-contract.js';
export * from './user-settings.js';
