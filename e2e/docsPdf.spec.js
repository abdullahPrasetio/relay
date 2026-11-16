/* global window */
import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeApp, launchApp } from './helpers/app.js';

test('exports documentation as a PDF through the native bridge', async () => {
  const session = await launchApp();
  const { app, page } = session;
  const pdfPath = path.join(os.tmpdir(), `relay-docs-test-${process.pid}.pdf`);

  try {
    await app.evaluate(({ dialog }, destination) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: destination });
    }, pdfPath);

    const result = await page.evaluate(() =>
      window.api.exportDocsPdf({
        suggestedName: 'relay-docs.pdf',
        html: '<!doctype html><html><body><h1>Relay PDF</h1><p>Hello</p></body></html>',
      })
    );

    expect(result).toMatchObject({ ok: true, saved: true, filePath: pdfPath });
    expect(fs.readFileSync(pdfPath).subarray(0, 4).toString()).toBe('%PDF');
  } finally {
    fs.rmSync(pdfPath, { force: true });
    await closeApp(session);
  }
});
