import { builtinModules } from 'node:module'
import { readFileSync } from 'node:fs'

import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

/**
 * Server-only files that enter the web bundle transitively through shared code.
 * Each is replaced with a no-op stub module during both dev and build.
 *
 * Why these exist:
 * - cli.ts: shebang, Bun spawn, fs, @inquirer — pulled via ports.ts → resolveProcessStartConflict
 * - secretbox.ts / keys.ts: node:crypto — pulled via crypto/frames.ts (but web uses frames.web.ts)
 * - hosting/routes.ts: fs, path — pulled via useWorkspaceDetailModel.ts
 * - hosting/state.ts: fs, os, path — pulled via showServiceLauncherSelect.ts
 * - core/config.ts: fs, path, os — pulled via hosting modules + lib/processes
 * - core/identity.ts: fs, path — pulled via hosting/supervisor (dynamic import but still resolved)
 * - utils/secrets.ts: fs, os, path — pulled via core/identity
 * - utils/hostnames.ts: crypto — pulled via hosting/routes
 * - commands/host.ts: fs, path — pulled via hosting/supervisor
 */
const SERVER_ONLY_PATTERNS = [
  /tmux-lite\/cli\.(ts|js)$/,
  /tmux-lite\/crypto\/secretbox\.(ts|js)$/,
  /tmux-lite\/crypto\/keys\.(ts|js)$/,
  /tmux-lite\/hosting\/routes\.(ts|js)$/,
  /tmux-lite\/hosting\/state\.(ts|js)$/,
  /tmux-lite\/hosting\/supervisor\.(ts|js)$/,
  /core\/config\.(ts|js)$/,
  /core\/identity\.(ts|js)$/,
  /utils\/secrets\.(ts|js)$/,
  /utils\/hostnames\.(ts|js)$/,
  /commands\/host\.(ts|js)$/,
];

function isServerOnlyModule(resolvedPath: string): boolean {
  return SERVER_ONLY_PATTERNS.some(re => re.test(resolvedPath));
}

// Node builtin module names to stub when they appear as direct imports
const NODE_BUILTIN_SET = new Set([
  ...builtinModules,
  ...builtinModules.map(m => `node:${m}`),
]);

/**
 * Vite plugin that replaces server-only modules with empty stubs.
 *
 * Works in both dev (serve) and build mode. Uses resolved absolute paths
 * so relative imports (e.g. `from "./secretbox"` in frames.ts) are caught.
 *
 * For Node builtins (fs, path, etc.), only stubs during build (Rollup).
 * In dev mode, Vite's built-in browser-external handling creates shims
 * that throw on access — which is correct since server-only code paths
 * are never actually called in the browser.
 */
function stubServerModules(): Plugin {
  let isBuild = false;

  return {
    name: 'stub-server-modules',
    enforce: 'pre',

    configResolved(config) {
      isBuild = config.command === 'build';
    },

    async resolveId(source, importer, options) {
      // In build mode, stub Node builtins to avoid Rollup's stricter
      // named-export resolution from browser-external shims.
      if (isBuild && (source === 'bun' || NODE_BUILTIN_SET.has(source))) {
        return {
          id: `virtual:stub-node-builtin:${source}`,
          moduleSideEffects: false,
          syntheticNamedExports: true,
        };
      }

      // Skip entry points and already-resolved virtual modules
      if (!importer || source.startsWith('virtual:')) return null;

      // Resolve to absolute path, then check against server-only patterns
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      if (!resolved) return null;

      if (isServerOnlyModule(resolved.id)) {
        return { id: 'virtual:stub-server-module', moduleSideEffects: false };
      }
      return null;
    },

    load(id) {
      if (id === 'virtual:stub-server-module') {
        // Export no-ops for every name any consumer might import.
        // Uses a Proxy default export + explicit named exports for Rollup.
        return [
          'const noop = () => {};',
          'const noopAsync = async () => {};',
          'const ZERO = 0;',
          'export default {};',
          // Re-export common names as no-ops. This covers both static
          // Rollup analysis and dev-mode ES module named imports.
          ...stubExportNames.map(n => `export const ${n} = noop;`),
        ].join('\n');
      }
      if (id.startsWith('virtual:stub-node-builtin:')) {
        // Build-only: Rollup uses syntheticNamedExports to derive
        // named exports from the default export object.
        return 'export default {};';
      }
    },
  };
}

// All named exports consumed from server-only modules by web-reachable code.
// Gathered by tracing imports from the seven violations above.
const stubExportNames = [
  // tmux-lite/cli.ts
  'listSessionsFromRunningServer', 'isServerRunning',
  'listSessions', 'createSession', 'send', 'isProcessRunning',
  'ensureServer', 'getStatus', 'getAgentState', 'watchAgentState',
  'killServer', 'createVirtualSession',
  // tmux-lite/crypto/secretbox.ts
  'encrypt', 'decrypt', 'seal', 'open', 'generateNonce',
  'NONCE_LENGTH', 'AUTH_TAG_LENGTH',
  // tmux-lite/crypto/keys.ts
  'generateSalt', 'deriveKey', 'SALT_LENGTH', 'KEY_LENGTH',
  // core/config.ts
  'readProjectConfig', 'getProjectBaseDir', 'projectExists',
  'getGitspaceDir', 'readGlobalConfig', 'writeGlobalConfig',
  'getProjectEventsConfig', 'getNotificationConfig', 'updateNotificationConfig',
  // core/identity.ts
  'readMachineIdentity', 'readRelayConfig',
  // hosting/routes.ts
  'resolveHostedServiceUrl',
  // hosting/state.ts
  'readTmuxHostingState',
  // hosting/supervisor.ts
  'refreshTmuxHosting',
  // utils/secrets.ts
  'initializeSecretRuntime',
  // utils/hostnames.ts
  'generateSubdomainSuggestion',
  // commands/host.ts (unlikely to be imported but safe)
  'hostCommand',
];

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    // In dev mode, serve the auto-provisioned browser identity at /__enroll.
    // Requires a one-time enrollment token to prevent ambient local trust.
    // The token is burned after first successful use.
    ...(process.env.DEV_IDENTITY_PATH && process.env.DEV_ENROLL_TOKEN ? (() => {
      let enrollToken: string | null = process.env.DEV_ENROLL_TOKEN!;
      return [{
        name: 'serve-enroll-identity',
        configureServer(server: import('vite').ViteDevServer) {
          server.middlewares.use((req, res, next) => {
            const reqUrl = req.url ?? '';
            if (!reqUrl.startsWith('/__enroll')) { next(); return; }

            // Parse token from query string
            const url = new URL(reqUrl, 'http://localhost');
            const token = url.searchParams.get('token');

            if (!enrollToken || token !== enrollToken) {
              res.statusCode = 403;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: 'Invalid or expired enrollment token' }));
              return;
            }

            try {
              const data = readFileSync(process.env.DEV_IDENTITY_PATH!, 'utf-8');
              // Token stays valid for the lifetime of this dev server.
              // It's a random UUID that dies when the process exits.
              res.setHeader('Content-Type', 'application/json');
              res.end(data);
            } catch {
              res.statusCode = 404;
              res.end('{}');
            }
          });
        },
      } satisfies Plugin];
    })() : []),

    stubServerModules(),
    react(),
    tailwindcss(),
  ],
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
      'ghostty-web': path.resolve(__dirname, 'node_modules/ghostty-web'),
      'sonner': path.resolve(__dirname, 'node_modules/sonner'),
      // @pierre/diffs + @pierre/trees are installed in web/node_modules; alias so src/ imports resolve
      '@pierre/diffs/react': path.resolve(__dirname, 'node_modules/@pierre/diffs/dist/react/index.js'),
      '@pierre/diffs': path.resolve(__dirname, 'node_modules/@pierre/diffs/dist/index.js'),
      '@pierre/trees/react': path.resolve(__dirname, 'node_modules/@pierre/trees/dist/react/index.js'),
      '@pierre/trees': path.resolve(__dirname, 'node_modules/@pierre/trees/dist/index.js'),
      // mermaid is installed in web/node_modules; alias so src/ imports resolve
      'mermaid': path.resolve(__dirname, 'node_modules/mermaid/dist/mermaid.core.mjs'),
    },
  },
  server: {
    proxy: {
      '/ws': {
        target: `ws://localhost:${process.env.RELAY_PORT || '4480'}`,
        ws: true,
        changeOrigin: true,
      },
    },
  },
})
