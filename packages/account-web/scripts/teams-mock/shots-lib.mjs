// Shared by the teams mock's screenshot scripts: open the mock in headless Chromium, act, screenshot the page, collect
// captions and every console error, warning or page error.
// The mock's address: TEAMS_MOCK_URL, default account-web's dev server (`bun run dev` in packages/account-web).
// Where screenshots go: the first argument, else TEAMS_MOCK_SHOTS, else /tmp/teams-mock/shots.
import { mkdirSync } from 'node:fs';
import { chromium } from '@playwright/test';

export const MOCK_URL = process.env.TEAMS_MOCK_URL ?? 'http://127.0.0.1:4510/mock-teams.html';
export const OUT = process.argv[2] ?? process.env.TEAMS_MOCK_SHOTS ?? '/tmp/teams-mock/shots';
mkdirSync(OUT, { recursive: true });

/** A run: `flow(query, name, caption, { act, width, height, scheme, dialogOnly })` takes one screenshot after `act`;
 * `session(query, async (step) => …)` keeps one page open and `step(name, caption)` screenshots each wizard step. */
export async function runner(captionFile) {
  const browser = await chromium.launch();
  const problems = [];
  const captions = [];
  async function open(query, { scheme = 'light', width = 1440, height = 1000 } = {}) {
    const context = await browser.newContext({ viewport: { width, height }, colorScheme: scheme, deviceScaleFactor: 2 });
    const page = await context.newPage();
    page.on('console', (message) => { if (message.type() === 'error' || message.type() === 'warning') problems.push(`${query} · ${message.type()}: ${message.text()}`); });
    page.on('pageerror', (error) => problems.push(`${query} · pageerror: ${error.message}`));
    await page.goto(`${MOCK_URL}?${query}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(600);
    return { page, context };
  }
  async function snap(page, name, caption) {
    await page.waitForTimeout(450);
    await page.screenshot({ path: `${OUT}/${name}.png` });
    captions.push(`${name}.png — ${caption}`);
  }
  return {
    open,
    snap,
    async flow(query, name, caption, { act, ...options } = {}) {
      const { page, context } = await open(query, options);
      try {
        if (act) await act(page);
        await snap(page, name, caption);
      } catch (error) {
        problems.push(`${name} · script: ${error.message.split('\n')[0]}`);
      }
      await context.close();
    },
    async session(query, steps, options = {}) {
      const { page, context } = await open(query, options);
      try {
        await steps(page, (name, caption) => snap(page, name, caption));
      } catch (error) {
        problems.push(`${query} · script: ${error.message.split('\n')[0]}`);
      }
      await context.close();
    },
    async finish() {
      await browser.close();
      console.log(captions.join('\n'));
      await Bun.write(`${OUT}/${captionFile}`, `${captions.join('\n')}\n`);
      console.log(problems.length ? `\nPROBLEMS (${problems.length}):\n${problems.join('\n')}` : '\nNo console errors or warnings.');
    },
  };
}
