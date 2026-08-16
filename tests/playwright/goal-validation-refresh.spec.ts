import { execFileSync } from 'child_process';
import { expect, test } from '@playwright/test';

const artifactRoot = 'tmp/playwright-goal-validation-root';

test('refresh pulls newly written artifacts and validation changes into the live sidebar', async ({ page }, testInfo) => {
  const token = `${Date.now()}`;
  const refreshTitle = `Refreshed artifact note (${token})`;
  const refreshCriterion = `Refresh mutation arrived (${token}).`;
  const refreshPrompt = `Refresh pulled the updated artifact and criteria into the live sidebar (${token}).`;

  await page.goto('/?enroll=playwright-validation');

  const goalCard = page.getByRole('button', { name: /playwright-artifact-goal/i });
  await expect(goalCard).toBeVisible({ timeout: 30_000 });
  await goalCard.click();

  await expect(page.getByText('VALIDATION')).toBeVisible();
  await expect(page.getByText(refreshTitle)).toHaveCount(0);
  await expect(page.getByText(refreshCriterion)).toHaveCount(0);

  execFileSync('bun', ['scripts/playwright/mutate-goal-validation.ts', artifactRoot, token], {
    cwd: process.cwd(),
    env: { ...process.env, GITSPACE_WORKSPACE_ROOT: artifactRoot },
    stdio: 'ignore',
  });

  await page.getByRole('button', { name: 'Close' }).click();
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(goalCard).toBeVisible({ timeout: 30_000 });
  await goalCard.click();

  await expect(page.getByText(refreshTitle)).toBeVisible();
  await expect(page.getByText(refreshCriterion)).toBeVisible();
  await expect(page.getByText(refreshPrompt)).toBeVisible();

  const screenshotPath = testInfo.outputPath('goal-validation-refresh-playwright.png');
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await testInfo.attach('goal-validation-refresh-screenshot', { path: screenshotPath, contentType: 'image/png' });
});
