import { expect, test } from '@playwright/test';

test('renders workspace-backed failed command artifact details in the live app', async ({ page }, testInfo) => {
  await page.goto('/?enroll=playwright-validation');

  const workspaceGoalCard = page.getByRole('button', { name: /\bapi\b/i }).first();
  await expect(workspaceGoalCard).toBeVisible({ timeout: 30_000 });
  await workspaceGoalCard.click();

  const workspaceGoalButton = page.getByRole('button', { name: /Goal\s*⛓\s*1\/5/i }).first();
  await expect(workspaceGoalButton).toBeVisible();
  await workspaceGoalButton.click();

  await expect(page.getByText('VALIDATION')).toBeVisible();
  await expect(page.getByText('ARTIFACT VIEWER')).toBeVisible();
  await expect(page.getByText('Workspace artifact note')).toBeVisible();
  await expect(page.getByText('Workspace command failure')).toBeVisible();
  await expect(page.locator('pre').filter({ hasText: 'workspace-stderr-artifact' }).first()).toBeVisible();
  await expect(page.getByText('NEEDS-JUDGMENT')).toBeVisible();
  await expect(page.getByText('2/2')).toBeVisible();
  await expect(page.getByText('REQUIRED ARTIFACTS')).toBeVisible();

  const screenshotPath = testInfo.outputPath('goal-validation-workspace-playwright.png');
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await testInfo.attach('goal-validation-workspace-screenshot', { path: screenshotPath, contentType: 'image/png' });
});
