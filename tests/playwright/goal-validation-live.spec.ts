import { expect, test } from '@playwright/test';

test('renders populated artifacts and judgments for a planned goal in the live app', async ({ page }, testInfo) => {
  await page.goto('/?enroll=playwright-validation');

  const goalCard = page.getByRole('button', { name: /playwright-artifact-goal/i });
  await expect(goalCard).toBeVisible({ timeout: 30_000 });
  await goalCard.click();

  await expect(page.getByText('VALIDATION')).toBeVisible();
  await expect(page.getByText('REQUIRED ARTIFACTS')).toBeVisible();
  await expect(page.getByText('ARTIFACT VIEWER')).toBeVisible();
  await expect(page.getByText('JUDGMENT ACTIONS')).toBeVisible();
  await expect(page.getByText('JUDGMENT PROMPT')).toBeVisible();

  await expect(page.getByText('Live artifact note')).toBeVisible();
  await expect(page.getByText('accepted: live artifact and judgment are visible')).toBeVisible();
  await expect(page.getByText('COMPLETE')).toBeVisible();
  await expect(page.getByText('1/1')).toBeVisible();
  await expect(page.getByText('human judgment')).toBeVisible();

  const screenshotPath = testInfo.outputPath('goal-validation-live-playwright.png');
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await testInfo.attach('goal-validation-live-screenshot', { path: screenshotPath, contentType: 'image/png' });
});
