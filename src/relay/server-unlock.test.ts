import { afterEach, describe, expect, test } from 'bun:test';
import type { Server } from 'bun';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearAllRegistries } from './registries';
import { generateRelayIdentity } from './identity';
import { startRelayServer } from './__tests__/helpers/ports';
import { connectClient, sendAndWait } from './__tests__/helpers/auth';
import { signMessage } from './signing';
import { ensureControlStore, getVaultMeta, setVaultMeta } from './control/store.js';
import { generateMnemonic, mnemonicToUserIdentity } from '../lib/tmux-lite/crypto/user-identity';
import { _resetVaultState } from './vault.js';

const TEST_HOST = '127.0.0.1';

let previousControlDir: string | undefined;
let tempControlDir: string | undefined;
let server: Server<any> | undefined;

function signUnlockMessage(ownerUserRoot: ReturnType<typeof mnemonicToUserIdentity>, proof: Uint8Array) {
  return signMessage(
    {
      type: 'unlock_relay',
      userRootPublicKey: Buffer.from(ownerUserRoot.signing.publicKey).toString('base64'),
      proof: Buffer.from(proof).toString('base64'),
    },
    ownerUserRoot.signing.secretKey.slice(0, 32),
    ownerUserRoot.signing.publicKey,
  );
}

afterEach(() => {
  server?.stop(true);
  server = undefined;
  clearAllRegistries();
  _resetVaultState();

  if (previousControlDir === undefined) {
    delete process.env.GITSPACE_CONTROL_DIR;
  } else {
    process.env.GITSPACE_CONTROL_DIR = previousControlDir;
  }

  if (tempControlDir) {
    rmSync(tempControlDir, { recursive: true, force: true });
    tempControlDir = undefined;
  }
});

describe('relay unlock repair', () => {
  test('repairs incomplete legacy vault metadata during first unlock', async () => {
    previousControlDir = process.env.GITSPACE_CONTROL_DIR;
    tempControlDir = mkdtempSync(join(tmpdir(), 'gssh-relay-unlock-test-'));
    process.env.GITSPACE_CONTROL_DIR = tempControlDir;

    const ownerUserRoot = mnemonicToUserIdentity(generateMnemonic());
    ensureControlStore();
    setVaultMeta('owner_user_root_id', ownerUserRoot.id);
    setVaultMeta('vault_initialized', '1');

    server = startRelayServer({
      bind: TEST_HOST,
      hostname: TEST_HOST,
      disableRateLimit: true,
      identity: generateRelayIdentity('unlock-repair-test-relay'),
    });

    const relayUrl = `ws://${TEST_HOST}:${server.port}/ws`;
    const clientWs = await connectClient(relayUrl);

    const unlockResult = await sendAndWait<any>(
      clientWs,
      signUnlockMessage(ownerUserRoot, ownerUserRoot.signing.secretKey.slice(0, 32)),
      'unlock_relay_result',
    );

    expect(unlockResult.success).toBe(true);
    expect(getVaultMeta('vault_salt')).toBeTruthy();
    expect(getVaultMeta('vault_key_check')).toBeTruthy();

    clientWs.close();
  });
});
