import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { closeApp, launchApp } from './helpers/app.js';

const tlsDir = path.join(import.meta.dirname, '..', 'test', 'fixtures', 'tls');
const pngBytes = fs.readFileSync(
  path.join(import.meta.dirname, '..', 'test', 'fixtures', 'binary', 'pixel.png')
);

let server;
let launched;

test.afterEach(async () => {
  if (server) {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    server = null;
  }
  if (launched) {
    await closeApp(launched);
    launched = null;
  }
});

function listen(nodeServer) {
  server = nodeServer;
  return new Promise((resolve, reject) => {
    nodeServer.once('error', reject);
    nodeServer.listen(0, '127.0.0.1', () => resolve(nodeServer.address().port));
  });
}

function startHttp(handler) {
  return listen(http.createServer(handler));
}

function startHttps(tlsOptions, handler) {
  return listen(https.createServer(tlsOptions, handler));
}

async function send(page, url) {
  await page.locator('.url-input').fill(url);
  await page.locator('.request-panel .send-btn').click();
}

async function setRequestSetting(page, testId, value) {
  await page.locator('[data-testid="request-settings-open"]').click();
  await page.locator(`[data-testid="${testId}"]`).fill(value);
  await page.locator('[data-testid="request-settings-save"]').click();
}

async function setRequestSelect(page, testId, value) {
  await page.locator('[data-testid="request-settings-open"]').click();
  await page.locator(`[data-testid="${testId}"]`).selectOption(value);
  await page.locator('[data-testid="request-settings-save"]').click();
}

test('returns a plain HTTP response', async () => {
  const port = await startHttp((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('hello');
  });

  launched = await launchApp();
  const { page } = launched;

  await send(page, `http://127.0.0.1:${port}/`);
  await expect(page.locator('[data-testid="response-status"]')).toContainText('200');
  await expect(page.locator('.response-body')).toContainText('hello');
});

test('applies a per-request timeout', async () => {
  const port = await startHttp((req, res) => {
    setTimeout(() => {
      res.writeHead(200);
      res.end('late');
    }, 5000).unref();
  });

  launched = await launchApp();
  const { page } = launched;

  await setRequestSetting(page, 'request-timeout', '100');
  await send(page, `http://127.0.0.1:${port}/slow`);

  await expect(page.locator('.response-panel')).toContainText(
    'Request timed out after 100ms',
    { timeout: 2000 }
  );
});

test('stops an in-flight request', async () => {
  const port = await startHttp((req, res) => {
    setTimeout(() => {
      res.writeHead(200);
      res.end('late');
    }, 5000).unref();
  });

  launched = await launchApp();
  const { page } = launched;

  await send(page, `http://127.0.0.1:${port}/slow`);
  await page.locator('[data-testid="stop-button"]').click({ timeout: 2000 });

  await expect(page.locator('.response-panel')).toContainText('Request aborted', {
    timeout: 2000,
  });
  // Back to a sendable state: the stop button is gone.
  await expect(page.locator('[data-testid="stop-button"]')).toHaveCount(0);
});

test('honours the per-request TLS verification override', async () => {
  const port = await startHttps(
    {
      key: fs.readFileSync(path.join(tlsDir, 'self-key.pem')),
      cert: fs.readFileSync(path.join(tlsDir, 'self-cert.pem')),
    },
    (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('secure');
    }
  );

  launched = await launchApp();
  const { page } = launched;
  const url = `https://localhost:${port}/`;

  await setRequestSelect(page, 'request-verify-tls', 'off');
  await send(page, url);
  await expect(page.locator('[data-testid="response-status"]')).toContainText('200');
  await expect(page.locator('.response-body')).toContainText('secure');
  await expect(page.locator('.tls-warn')).toContainText('TLS verification off');

  await setRequestSelect(page, 'request-verify-tls', 'on');
  await send(page, url);
  await expect(page.locator('.error-text')).toContainText(/self[ -]signed/i, {
    timeout: 10000,
  });
});

test('previews a binary image response', async () => {
  const port = await startHttp((req, res) => {
    res.writeHead(200, { 'Content-Type': 'image/png' });
    res.end(pngBytes);
  });

  launched = await launchApp();
  const { page } = launched;

  await send(page, `http://127.0.0.1:${port}/pixel.png`);

  const img = page.locator('[data-testid="response-binary-preview"]');
  await expect(img).toBeVisible();
  await expect
    .poll(() => img.evaluate((el) => (el.complete ? el.naturalWidth : 0)), {
      timeout: 5000,
    })
    .toBe(1);

  // The exact bytes are saveable; binary examples are not stored.
  await expect(page.locator('[data-testid="response-save"]')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save as Example' })).toHaveCount(0);
  await expect(page.locator('.status-actions')).toContainText('Save');
});
