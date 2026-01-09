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
  },
  resolve: {
    // Dedupe react to avoid multiple instances when importing from shared components
    dedupe: ['react', 'react-dom'],
    alias: {
      // Ensure shared components resolve react from web's node_modules
      'react': path.resolve(__dirname, 'node_modules/react'),
      'react-dom': path.resolve(__dirname, 'node_modules/react-dom'),
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
