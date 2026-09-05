import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { cpSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

function accountWebAssets() {
  return {
    name: 'gitspace-account-web-assets',
    writeBundle() {
      const root = fileURLToPath(new URL('.', import.meta.url));
      cpSync(resolve(root, '../account-web/dist'), resolve(root, 'dist/__account'), { recursive: true });
    },
  };
}

export default defineConfig({
  resolve: { alias: { '@': resolve(fileURLToPath(new URL('.', import.meta.url)), '../ui/src/fluid-vendor') } },
  plugins: [react(), tailwindcss(), accountWebAssets()],
  server: { host: '127.0.0.1', port: 4512 },
});
