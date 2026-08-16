import { defineConfig } from '@playwright/test';

const validationRoot = 'tmp/playwright-goal-validation-root';
const enrollToken = 'playwright-validation';

export default defineConfig({
  testDir: 'tests/playwright',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:5173',
    headless: true,
    screenshot: 'on',
    video: 'on',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `bash -lc 'SELF=$$; ROOT=\"$PWD/${validationRoot}\"; for p in $(pgrep -f "bun scripts/dev.ts|bunx vite --port 5173|src/index.ts relay start|src/index.ts machine serve start|src/lib/tmux-lite/server.ts" || true); do if [ "$p" != "$SELF" ]; then kill "$p" || true; fi; done; bun scripts/playwright/seed-goal-validation.ts "$ROOT" && DEV_ENROLL_TOKEN=${enrollToken} GITSPACE_WORKSPACE_ROOT=\"$ROOT\" bun run dev:web'`,
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
