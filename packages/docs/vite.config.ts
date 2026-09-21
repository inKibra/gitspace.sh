import { cloudflare } from '@cloudflare/vite-plugin';
import { holocron } from '@holocron.so/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  base: '/docs/',
  clearScreen: false,
  plugins: [
    holocron({ pagesDir: './src', pageCache: false }),
    cloudflare({
      viteEnvironment: {
        name: 'rsc',
        childEnvironments: ['ssr'],
      },
    }),
  ],
});
