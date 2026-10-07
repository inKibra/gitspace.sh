import { expect, test } from '@playwright/test';

test('production machine row keeps blockers and definition visible and supports local-work and reclamation', async ({ page }) => {
  await page.goto('/?gallery=environment');
  const row = page.getByRole('region', { name: 'Machine Studio Mac', exact: true });
  await expect(row).toBeVisible();
  await expect(row.getByText('Paused since', { exact: false })).toBeVisible();
  await expect(row.getByText('Check · Database migration · Waiting approval')).toBeVisible();
  await expect(row.getByText('darwin', { exact: true })).toBeVisible();
  await row.getByRole('checkbox', { name: 'Work locally on Studio Mac' }).check();
  await expect(row.getByRole('checkbox', { name: 'Work locally on Studio Mac' })).toBeChecked();
  await row.getByRole('button', { name: 'View checks log' }).click();
  await expect(page.getByText('Opened checks log', { exact: true })).toBeVisible();
  await row.getByRole('button', { name: 'Reclaim now' }).click();
  await expect(row.getByText('Local cache reclaimed.', { exact: false })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Browser origins' })).toBeAttached();
  await expect(page.getByRole('combobox', { name: 'Runtime profile' })).toBeAttached();
  await row.getByRole('button', { name: 'Setup again' }).click();
  await expect(row.getByText('machine/prepare · running', { exact: true })).toBeVisible();
  await row.getByRole('button', { name: 'Detach', exact: true }).click();
  await expect(page.getByText('No machine', { exact: true })).toBeVisible();
});
