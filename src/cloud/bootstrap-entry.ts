import { serveStart } from '../commands/serve.js';

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function isRetryableServeError(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes('failed to connect to relay for unlock request')
    || normalized.includes('relay closed unlock connection before unlock grant was received')
    || normalized.includes('failed to connect to relay')
    || normalized.includes('connection closed')
    || normalized.includes('econnreset')
    || normalized.includes('econnrefused')
    || normalized.includes('eai_again')
    || normalized.includes('timed out')
    || normalized.includes('timeout')
    || normalized.includes('fetch failed')
    || normalized.includes('socket hang up')
    || normalized.includes('enotfound');
}

async function runServeStartWithRetry(options: {
  relay: string;
  relayPubkey: string;
  workspaceId: string;
  unlockToken: string;
  enrollmentToken: string;
}): Promise<void> {
  const maxAttempts = Number.parseInt(process.env.GSSH_BOOTSTRAP_MAX_ATTEMPTS ?? '16', 10);
  const attempts = Number.isFinite(maxAttempts) && maxAttempts > 0 ? maxAttempts : 16;
  const baseDelayMs = Number.parseInt(process.env.GSSH_BOOTSTRAP_BASE_DELAY_MS ?? '2000', 10);
  const initialDelayMs = Number.isFinite(baseDelayMs) && baseDelayMs > 0 ? baseDelayMs : 2000;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await serveStart({
        relay: options.relay,
        relayPubkey: options.relayPubkey,
        workspaceId: options.workspaceId,
        unlockToken: options.unlockToken,
        enrollmentToken: options.enrollmentToken,
        foreground: true,
        ignoreKeychainAndSkipSecrets: true,
      });
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const retryable = isRetryableServeError(message);
      const isLastAttempt = attempt >= attempts;

      if (!retryable || isLastAttempt) {
        throw error;
      }

      const waitMs = Math.min(30_000, initialDelayMs * attempt);
      process.stderr.write(
        `Bootstrap serve connect failed (attempt ${attempt}/${attempts}): ${message}. Retrying in ${waitMs}ms...\n`
      );
      await Bun.sleep(waitMs);
    }
  }
}

async function main(): Promise<void> {
  const relay = requiredEnv('GSSH_RELAY_URL');
  const relayPubkey = requiredEnv('GSSH_RELAY_PUBKEY');
  const workspaceId = requiredEnv('GSSH_WORKSPACE_ID');
  const unlockToken = requiredEnv('GSSH_UNLOCK_TOKEN');
  const enrollmentToken = requiredEnv('GSSH_ENROLLMENT_TOKEN');

  await runServeStartWithRetry({
    relay,
    relayPubkey,
    workspaceId,
    unlockToken,
    enrollmentToken,
  });
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
