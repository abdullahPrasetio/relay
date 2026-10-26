import { expect, test } from '@playwright/test';
import { closeApp, launchApp } from './helpers/app.js';

// Auth provider UI coverage: the new types must render without errors and the
// OAuth2 panel must expose the browser flow entry point. Network exchange is
// unit-tested against a mock IdP (test/unit/oauth2.test.js); this only checks
// the wiring that a user sees.
let launched;

test.afterEach(async () => {
  if (launched) {
    await closeApp(launched);
    launched = null;
  }
});

test('offers every auth type and renders provider fields', async () => {
  launched = await launchApp();
  const { page } = launched;

  await page.getByRole('button', { name: 'Authorization' }).click();

  const typeSelect = page.locator('.auth-panel select').first();
  const options = await typeSelect.locator('option').allTextContents();
  for (const label of [
    'OAuth 1.0',
    'OAuth 2.0',
    'Digest Auth',
    'NTLM',
    'AWS Signature',
    'JWT Bearer',
  ]) {
    expect(options).toContain(label);
  }

  await typeSelect.selectOption('awsv4');
  await expect(page.locator('.auth-panel label', { hasText: 'Access Key' })).toBeVisible();
  await expect(page.locator('.auth-panel label', { hasText: 'Region' })).toBeVisible();

  await typeSelect.selectOption('oauth1');
  await expect(page.locator('.auth-panel label', { hasText: 'Consumer Key' })).toBeVisible();

  await typeSelect.selectOption('jwt');
  await expect(page.locator('.auth-panel label', { hasText: 'Algorithm' })).toBeVisible();
});

test('exposes the OAuth2 authorization-code flow', async () => {
  launched = await launchApp();
  const { page } = launched;

  await page.getByRole('button', { name: 'Authorization' }).click();
  const typeSelect = page.locator('.auth-panel select').first();
  await typeSelect.selectOption('oauth2');
  await expect(typeSelect).toHaveValue('oauth2');

  // The browser flow only applies to the authorization-code grant.
  const grant = page.locator('.auth-panel select').nth(1);
  await grant.selectOption('authorization_code');
  await expect(page.getByRole('button', { name: /Authorize/ })).toBeVisible();
  await expect(page.locator('.auth-panel label', { hasText: 'Grant Type' })).toBeVisible();

  // Other grants use the in-app token request instead.
  await grant.selectOption('client_credentials');
  await expect(page.getByRole('button', { name: /Get New Access Token/ })).toBeVisible();
});
