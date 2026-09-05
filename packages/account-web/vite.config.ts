import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';


export default defineConfig({
  resolve: { alias: { '@': resolve(fileURLToPath(new URL('.', import.meta.url)), '../ui/src/fluid-vendor') } },
  plugins: [react(), tailwindcss()],
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
