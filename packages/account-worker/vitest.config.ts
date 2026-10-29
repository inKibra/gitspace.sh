import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';
import { createHash } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { writeBrowserRunner } from '@gitspace/browser-runner';

const rootPublicKey = ed25519.getPublicKey(Uint8Array.from({ length: 32 }, (_, index) => index + 1));
const accountId = `u-${createHash('sha256').update(rootPublicKey).digest('hex').slice(0, 32)}`;

// The browser runner module is generated, not committed; the session object imports it when a script runs.
await writeBrowserRunner(new URL('./src/generated/browser-runner.js', import.meta.url));

export default defineConfig({
  define: { GITSPACE_WORKER_SHA: JSON.stringify('test-inference-worker') },
  plugins: [
    cloudflareTest({
      remoteBindings: false,
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        serviceBindings: {
          ASSETS: async () => new Response(null, { status: 404 }),
          // No test sends a model request through fetch; the inference Worker is checked where it runs.
          INFERENCE: async () => new Response(null, { status: 503 }),
        },
        bindings: {
          AUTH_PUBLIC_KEY: Buffer.from(rootPublicKey).toString('base64'),
          ACCOUNT_ID: accountId,
          TENANT_ID: 'test',
          ACCOUNT_URL: 'https://test.gitspace.sh',
          RELAY_URL: 'https://test.gitspace.sh',
          PLATFORM_URL: 'https://platform.test',
          PLATFORM_TOKEN: 'test-platform-token',
          GITSPACE_OMP_BROKER_TOKEN: 'test-credential-broker-token',
          RELAY_NAME: 'test',
        },
      },
    }),
  ],
  test: {
    // Each file boots an isolated workerd; bound fan-out so streaming and lease checks retain CPU time.
    maxWorkers: 4,
    include: ['test/**/*.test.ts'],
    setupFiles: ['./test/setup.ts'],
  },
});
