import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { cpSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
// (By path: the config loader bundles it, where Node could not load the package's TypeScript.)
import { domainsFromSettings, withDomainsMeta } from '../protocol-environment/src/domains';

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
  plugins: [react(), tailwindcss(), accountWebAssets(), {
    // In production the operator Worker names the install's domains in each page it serves; the dev server does it
    // here, from ACCOUNT_DOMAIN and SERVICE_DOMAIN (GitSpace's own when unset).
    name: 'gitspace-install-domains',
    apply: 'serve',
    transformIndexHtml: (html: string) => withDomainsMeta(html, domainsFromSettings(process.env)),
  }],
  server: { host: '127.0.0.1', port: 4512 },
});
