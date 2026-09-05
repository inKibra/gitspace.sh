import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          AUTH_PUBLIC_KEY: 'ebVWLo/mVPlAeLES6KmLp5AfhTrmlb7X4OORC60ElmQ=',
          OPERATOR_URL: 'https://authority.test',
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
  },
});
