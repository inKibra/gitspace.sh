import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';
import { createHash } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';

const rootPublicKey = ed25519.getPublicKey(Uint8Array.from({ length: 32 }, (_, index) => index + 1));
const accountId = `u-${createHash('sha256').update(rootPublicKey).digest('hex').slice(0, 32)}`;

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        serviceBindings: {
          ASSETS: async () => new Response(null, { status: 404 }),
        },
        bindings: {
          AUTH_PUBLIC_KEY: Buffer.from(rootPublicKey).toString('base64'),
          ACCOUNT_ID: accountId,
          TENANT_ID: 'test',
          ACCOUNT_URL: 'https://test.gitspace.sh',
          RELAY_URL: 'https://test.gitspace.sh',
          PLATFORM_URL: 'https://platform.test',
          PLATFORM_TOKEN: 'test-platform-token',
          GITSPACE_OMP_BROKER_TOKEN: 'test-omp-broker-token',
          RELAY_NAME: 'test',
          AUTH_MAX_SKEW_MS: 60_000,
          TUNNEL_HEADER_TIMEOUT_MS: 2_000,
          TUNNEL_IDLE_TIMEOUT_MS: 2_000,
        },
      },
    }),
  ],
  test: {
    include: ['test/**/*.test.ts'],
    setupFiles: ['./test/setup.ts'],
  },
});
