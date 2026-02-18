import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      external: ['bun'],
    },
  },
  resolve: {
    // Dedupe react to avoid multiple instances when importing from shared components
    dedupe: ['react', 'react-dom'],
    alias: {
      // Ensure shared components resolve react from web's node_modules
      'react': path.resolve(__dirname, 'node_modules/react'),
      'react-dom': path.resolve(__dirname, 'node_modules/react-dom'),
      'ghostty-web': path.resolve(__dirname, 'node_modules/ghostty-web'),
      'sonner': path.resolve(__dirname, 'node_modules/sonner'),
      // @pierre/diffs is installed in web/node_modules; alias so src/ imports resolve
      '@pierre/diffs/react': path.resolve(__dirname, 'node_modules/@pierre/diffs/dist/react/index.js'),
      '@pierre/diffs': path.resolve(__dirname, 'node_modules/@pierre/diffs/dist/index.js'),
    },
  },
  server: {
    proxy: {
      '/ws': {
        target: 'ws://localhost:4480',
        ws: true,
        changeOrigin: true,
      },
    },
  },
})
