import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

// The public default branch can lag the running beta. Seed the source branch
// used to publish this frontend, not an unrelated checkout of the product.
const sourceBranch = process.env.GITSPACE_SOURCE_BRANCH?.trim()
  || process.env.GITHUB_HEAD_REF?.trim()
  || (process.env.GITHUB_REF_TYPE === 'branch' ? process.env.GITHUB_REF_NAME?.trim() : '')
  || execFileSync('git', ['branch', '--show-current'], { cwd: fileURLToPath(new URL('.', import.meta.url)), encoding: 'utf8' }).trim();
if (!sourceBranch) throw new Error('Set GITSPACE_SOURCE_BRANCH when building GitSpace from a detached checkout.');
const sourceCommit = process.env.GITSPACE_SOURCE_COMMIT?.trim()
  || execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fileURLToPath(new URL('.', import.meta.url)), encoding: 'utf8' }).trim();
if (!/^[a-f0-9]{40,64}$/iu.test(sourceCommit)) throw new Error('GITSPACE_SOURCE_COMMIT must be a full Git commit hash.');


export default defineConfig({
  define: {
    'import.meta.env.VITE_GITSPACE_SOURCE_BRANCH': JSON.stringify(sourceBranch),
    'import.meta.env.VITE_GITSPACE_SOURCE_COMMIT': JSON.stringify(sourceCommit),
  },
  resolve: { alias: { '@': resolve(fileURLToPath(new URL('.', import.meta.url)), '../ui/src/fluid-vendor') } },
  plugins: [react(), tailwindcss(), {
    name: 'gitspace-source-metadata',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'gitspace-source.json', source: JSON.stringify({ release: sourceCommit, branch: sourceBranch, commit: sourceCommit }) });
    },
  }],
  server: {
    host: '127.0.0.1',
    port: 4510,
    // `/health` is the reload gate's readiness probe; it lives beside `/rpc` on the machine.
    proxy: { '/rpc': 'http://127.0.0.1:4511', '/health': 'http://127.0.0.1:4511' },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('result-rpc') || id.includes('@tanstack/query')) return 'rpc';
          if (id.includes('@base-ui/react')) return 'ui';
          if (id.includes('lucide-react')) return 'icons';
          if (id.includes('@streamdown/code')) return 'markdown-code';
          if (id.includes('@streamdown/cjk')) return 'markdown-cjk';
          if (id.includes('@streamdown/mermaid') || id.includes('/mermaid/') || id.includes('cytoscape') || id.includes('dagre')) return 'markdown-diagrams';
          if (id.includes('streamdown') || id.includes('rehype-') || id.includes('remark-') || id.includes('/unified/') || id.includes('/marked/') || id.includes('/remend/')) return 'markdown';
          if (id.includes('/motion/')) return 'ui-motion';
          return undefined;
        },
      },
    },
  },
});
