import { expect, test } from '@playwright/test';

const galleryUrl = '/?gallery=design-system';

test.beforeEach(async ({ page }) => {
  await page.goto(galleryUrl);
  await expect(page.getByTestId('design-gallery')).toBeVisible();
  await expect(page.locator('#markdown [data-streamdown="mermaid-block"]')).toBeVisible({ timeout: 15_000 });
  await page.evaluate(() => document.fonts.ready);
});

test('gallery has deterministic visual coverage', async ({ page }, testInfo) => {
  await expect(page).toHaveScreenshot(`design-system-${testInfo.project.name}.png`, { fullPage: true });
});

test('layout has no viewport overflow or section overlap', async ({ page }) => {
  const result = await page.evaluate(() => {
    const root = document.documentElement;
    const sections = [...document.querySelectorAll<HTMLElement>('.design-gallery-section')];
    const overlap = sections.some((section, index) => {
      const next = sections[index + 1];
      if (!next) return false;
      return section.getBoundingClientRect().bottom > next.getBoundingClientRect().top + 1;
    });
    return { overflow: root.scrollWidth > root.clientWidth + 1, overlap };
  });
  expect(result).toEqual({ overflow: false, overlap: false });
});

// Fluid's size ladder: 36px default controls, 28px compact, 24px row actions, and 20px glyph
// buttons inside rows (queued-message ×, header triggers). Standalone controls must
// hit the compact step; in-row parts the registry's own 20px floor.
test('visible controls preserve Fluid size-ladder hit areas', async ({ page }) => {
  const undersized = await page.locator('button:visible, a:visible, input:visible, textarea:visible, [role="tab"]:visible, [role="combobox"]:visible, [role="switch"]:visible').evaluateAll((elements) => elements
    .filter((element) => element.getAttribute('aria-hidden') !== 'true' && !(element as HTMLButtonElement | HTMLInputElement).disabled && (element as HTMLElement).tabIndex >= 0)
    // Native inputs sit inside the registry's 36px/28px field frame; the frame
    // is the hit target. Registry-fixed parts keep their own geometry: slider
    // thumbs (20px), the Switch (34×20), the sidebar's drag rail (16px wide).
    // Streamdown's toolbar is third-party and outside the ladder.
    .filter((element) => !element.closest('[data-streamdown]') && element.getAttribute('role') !== 'slider' && element.getAttribute('role') !== 'switch' && element.getAttribute('data-sidebar') !== 'rail' && (element as HTMLInputElement).type !== 'range')
    .map((element) => {
      const target = element.tagName === 'INPUT' || element.tagName === 'TEXTAREA' ? (element.closest('label') ?? element.parentElement ?? element) : element;
      const rect = target.getBoundingClientRect();
      const inRow = !!element.closest('[data-sidebar], [data-slot="card"], [role="menu"], [role="tablist"], [data-slot="input-message"], td, th, [data-slot="chat-message"]');
      const minimum = (inRow ? 20 : 28) - 0.5;
      return { name: element.getAttribute('aria-label') ?? element.textContent?.trim() ?? element.tagName, width: rect.width, height: rect.height, minimum };
    })
    .filter(({ width, height, minimum }) => width < minimum || height < minimum));
  expect(undersized).toEqual([]);
});

test('dialog traps focus and closes with Escape', async ({ page }) => {
  await page.getByRole('button', { name: 'Open dialog' }).click();
  const dialog = page.getByRole('dialog', { name: 'Connect local MCP server' });
  await expect(dialog).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Connection name' })).toBeFocused();
  for (let index = 0; index < 7; index += 1) await page.keyboard.press('Tab');
  await expect(dialog.locator(':focus')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: 'Open dialog' })).toBeFocused();
});

test('keyboard navigation exposes focus-visible state', async ({ page }) => {
  await page.keyboard.press('Tab');
  const focused = page.locator(':focus');
  await expect(focused).toBeVisible();
  const outline = await focused.evaluate((element) => getComputedStyle(element).outlineStyle);
  expect(outline).not.toBe('none');
});

test('reduced motion avoids press scaling', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const button = page.getByRole('button', { name: 'Primary', exact: true });
  await expect(button).toBeVisible();
  await button.dispatchEvent('pointerdown');
  const pressedScale = await button.evaluate((element) => getComputedStyle(element).scale);
  expect(pressedScale === 'none' || pressedScale === '1').toBe(true);
});

test('rich Markdown loads code, Mermaid, and math plugins on demand', async ({ page }) => {
  const markdown = page.locator('#markdown');
  await markdown.scrollIntoViewIfNeeded();
  await expect(markdown.locator('[data-streamdown="code-block"]')).toBeVisible();
  await expect(markdown.locator('[data-streamdown="mermaid-block"]')).toBeVisible({ timeout: 15_000 });
  await expect(markdown.locator('.katex')).toBeVisible();
  const safeLink = markdown.getByRole('button', { name: 'safe links' });
  await safeLink.click();
  await expect(page.getByText('Open external link?')).toBeVisible();
  await expect(page.getByText('https://github.com/', { exact: true })).toBeVisible();
});
