/**
 * Generates a complete sandbox identity for dev mode.
 *
 * Creates:
 *   1. A BIP39 mnemonic → user root identity (stored in test secrets file)
 *   2. A device keypair + encrypted keypair.json (for serve, encrypted with DEV_PASSWORD)
 *   3. A browser device keypair + device cert signed by the root (for browser localStorage)
 *
 * Outputs JSON to stdout: { userRootStored, keypairStorage, browserIdentity }
 */

import { generateIdentity, serializeIdentity } from '../src/lib/tmux-lite/crypto/identity.js';
import { createDeviceCertificate } from '../src/lib/tmux-lite/crypto/device-cert.js';
import { seal } from '../src/lib/tmux-lite/crypto/secretbox.js';
import { deriveKey, generateSalt } from '../src/lib/tmux-lite/crypto/keys.js';
import { generateMnemonic, mnemonicToUserIdentity } from '../src/lib/tmux-lite/crypto/user-identity.js';

const DEV_PASSWORD = 'dev';

async function main() {
  // 1. Generate user root identity from a fresh mnemonic
  const mnemonic = generateMnemonic();
  const userRoot = mnemonicToUserIdentity(mnemonic);
  const userRootStored = {
    version: 2,
    mnemonic,
    createdAt: Date.now(),
  };

  // 2. Generate device keypair for serve (encrypted with DEV_PASSWORD)
  const deviceIdentity = generateIdentity('Dev Machine');
  const deviceSerialized = serializeIdentity(deviceIdentity);
  const salt = generateSalt();
  const encryptionKey = await deriveKey(DEV_PASSWORD, salt);
  const secrets = JSON.stringify({
    signingSecretKey: deviceSerialized.signingSecretKey,
    keyExchangePrivateKey: deviceSerialized.keyExchangePrivateKey,
  });
  const encryptedSecrets = seal(Buffer.from(secrets, 'utf-8'), encryptionKey);

  const keypairStorage = {
    version: 1,
    id: deviceIdentity.id,
    label: deviceIdentity.label,
    createdAt: deviceIdentity.createdAt,
    signingPublicKey: deviceSerialized.signingPublicKey,
    keyExchangePublicKey: deviceSerialized.keyExchangePublicKey,
    encryptedSecrets: encryptedSecrets.toString('base64'),
    salt: salt.toString('base64'),
  };

  // 3. Generate browser device identity, signed by user root
  const browserDevice = generateIdentity('Dev Browser');
  const browserDeviceCert = createDeviceCertificate(
    userRoot,
    browserDevice.signing.publicKey,
    browserDevice.keyExchange.publicKey,
    { label: 'Dev Browser' },
  );

  const browserIdentity = {
    identity: {
      id: browserDevice.id,
      signingPublicKey: Buffer.from(browserDevice.signing.publicKey).toString('base64'),
      signingSecretKey: Buffer.from(browserDevice.signing.secretKey).toString('base64'),
      keyExchangePublicKey: Buffer.from(browserDevice.keyExchange.publicKey).toString('base64'),
      keyExchangePrivateKey: Buffer.from(browserDevice.keyExchange.privateKey).toString('base64'),
      label: browserDevice.label,
      createdAt: browserDevice.createdAt,
    },
    deviceCert: JSON.stringify(browserDeviceCert),
  };

  process.stdout.write(JSON.stringify({ userRootStored, keypairStorage, browserIdentity }));
}

main().catch((err) => {
  process.stderr.write(`Failed to generate dev identity: ${err}\n`);
  process.exit(1);
});
