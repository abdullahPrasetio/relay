import { expect, test } from '@playwright/test';
import { closeApp, launchApp } from './helpers/app.js';

test('exports documentation with template, metadata and disclaimer', async () => {
  const session = await launchApp();
  const { page } = session;

  try {
    await page.locator('.collection-row .kebab-btn').first().click();
    await page.getByText('Export docs…').click();
    await expect(page.getByTestId('docs-export-modal')).toBeVisible();

    await page.getByTestId('docs-template-professional').check();
    await page.getByTestId('docs-export-theme').selectOption('dark');
    await page.getByTestId('docs-export-language').selectOption('id');
    await page.getByTestId('docs-export-author').fill('Alice');
    await page.getByTestId('docs-export-prepared-for').fill('Bob');
    await page.getByTestId('docs-export-disclaimer').fill('No liability accepted.');

    await page.getByTestId('docs-export-preview-toggle').click();
    const html = await page.getByTestId('docs-export-preview').evaluate((node) => node.srcdoc);
    expect(html).toContain('data-theme="dark"');
    expect(html).toContain('template-professional');
    expect(html).toContain('Disusun oleh');
    expect(html).toContain('Ditujukan untuk');
    expect(html).toContain('Alice');
    expect(html).toContain('Bob');
    expect(html).toContain('No liability accepted.');
    expect(html).not.toContain('<script');
  } finally {
    await closeApp(session);
  }
});
