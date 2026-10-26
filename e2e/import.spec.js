import { expect, test } from '@playwright/test';
import path from 'node:path';
import { closeApp, launchApp } from './helpers/app.js';

// The Import button accepts every supported format through one hidden file
// input; Playwright sets files on it directly (no native dialog involved).
const fixture = (p) => path.join(import.meta.dirname, '..', 'test', 'fixtures', p);

let launched;

test.afterEach(async () => {
  if (launched) {
    await closeApp(launched);
    launched = null;
  }
});

async function launch() {
  launched = await launchApp();
  return launched.page;
}

async function importFile(page, file) {
  await page.setInputFiles('input[accept*=".sh"]', file);
}

test('imports a cURL command into a collection', async () => {
  const page = await launch();

  await importFile(page, fixture('import/curl-get-auth.sh'));

  await expect(page.locator('.collection-name', { hasText: 'cURL Import' })).toBeVisible({
    timeout: 5000,
  });
});

test('imports an OpenAPI document', async () => {
  const page = await launch();

  await importFile(page, fixture('import/petstore-openapi.json'));

  await expect(page.locator('.collection-name', { hasText: 'Petstore' })).toBeVisible({
    timeout: 5000,
  });
});

test('imports a HAR file', async () => {
  const page = await launch();

  await importFile(page, fixture('import/sample.har'));

  await expect(page.locator('.collection-name', { hasText: /Imported HAR/ })).toBeVisible({
    timeout: 5000,
  });
});

test('imports an Insomnia export with its environment', async () => {
  const page = await launch();

  await importFile(page, fixture('import/insomnia-v4.json'));

  await expect(page.locator('.collection-name', { hasText: 'Demo Workspace' })).toBeVisible({
    timeout: 5000,
  });
  await expect(
    page.locator('.env-select option', { hasText: 'Development' })
  ).toHaveCount(1);
});

test('still imports a Postman collection', async () => {
  const page = await launch();

  await importFile(page, fixture('postman/collection-with-events.json'));

  await expect(page.locator('.collection-name', { hasText: 'Events Collection' })).toBeVisible({
    timeout: 5000,
  });
});
