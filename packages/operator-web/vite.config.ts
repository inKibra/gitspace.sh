import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { cpSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

function cliArtifact() {
  return {
    name: 'gitspace-cli-artifact',
    generateBundle(this: { emitFile(asset: { type: 'asset'; fileName: string; source: Uint8Array }): void }) {
      this.emitFile({
        type: 'asset',
        fileName: 'gitspace',
        source: readFileSync(resolve(fileURLToPath(new URL('.', import.meta.url)), '../cli/dist/index.js')),
      });
    },
    writeBundle() {
      const root = fileURLToPath(new URL('.', import.meta.url));
      cpSync(resolve(root, '../account-web/dist'), resolve(root, 'dist/__account'), { recursive: true });
    },
  };
}

export default defineConfig({
  resolve: { alias: { '@': resolve(fileURLToPath(new URL('.', import.meta.url)), '../ui/src/fluid-vendor') } },
  plugins: [react(), tailwindcss(), cliArtifact()],
  server: { host: '127.0.0.1', port: 4512 },
});
