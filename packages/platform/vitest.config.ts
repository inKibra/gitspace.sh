import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// Stands in for the sandbox provider: it streams until cancelled and records every call whose caller went away.
const computeProbe = `
const aborted = new Set();
export default {
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/__probe/aborted') return Response.json([...aborted]);
    request.signal.addEventListener('abort', () => { aborted.add(path); });
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('event\\n')); } }));
  },
};`;

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.test.jsonc' },
      miniflare: {
        serviceBindings: { COMPUTE: 'compute-probe' },
        workers: [{ name: 'compute-probe', modules: true, script: computeProbe, compatibilityDate: '2026-08-27', compatibilityFlags: ['enable_request_signal'] }],
      },
    }),
  ],
  test: {
    include: ['test/**/*.test.ts'],
  },
});
