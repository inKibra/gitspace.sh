import { expect, test } from '@playwright/test';

test('renders an explicit empty artifact state for a planned goal with missing required artifact', async ({ page }, testInfo) => {
  await page.goto('/?enroll=playwright-validation');

  const goalCard = page.getByRole('button', { name: /playwright-missing-artifact-goal/i });
  await expect(goalCard).toBeVisible({ timeout: 30_000 });
  await goalCard.click();

  await expect(page.getByText('VALIDATION')).toBeVisible();
  await expect(page.getByText('ARTIFACT VIEWER')).toBeVisible();
  await expect(page.getByText('No artifacts recorded yet.')).toBeVisible();
  await expect(page.getByText('Missing required artifacts')).toBeVisible();
  await expect(page.getByText('image: Attach a screenshot.')).toBeVisible();
  await expect(page.getByText('NEEDS-ARTIFACT')).toBeVisible();
  await expect(page.getByText('0/1')).toBeVisible();

  const screenshotPath = testInfo.outputPath('goal-validation-missing-playwright.png');
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await testInfo.attach('goal-validation-missing-screenshot', { path: screenshotPath, contentType: 'image/png' });
});
