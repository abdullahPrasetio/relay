import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { closeApp, launchAppAt, makeUserData } from './helpers/app.js';

const LONG_ENV = 'Imported Environment With A Very Long Name That Would Overflow';

function seed() {
  return {
    schemaVersion: 3,
    activeWorkspaceId: 'ws_header',
    workspaces: [
      {
        id: 'ws_header',
        name: 'Default',
        collections: [],
        environments: [{ id: 'env_long', name: LONG_ENV, variables: [] }],
        globals: [],
        history: [],
        activeEnvId: 'env_long',
      },
    ],
  };
}

test('header controls stay circular and the environment name truncates', async () => {
  const userData = makeUserData();
  fs.writeFileSync(
    path.join(userData, 'rest-tamer-data.json'),
    JSON.stringify(seed(), null, 2)
  );
  const session = await launchAppAt(userData);
  const { page } = session;

  try {
    await page.setViewportSize({ width: 900, height: 700 });

    const boxes = await page
      .locator('.topbar-right .mini-btn.icon-only, .topbar-right .cloud-chip')
      .evaluateAll((nodes) =>
        nodes.map((node) => {
          const r = node.getBoundingClientRect();
          return { w: Math.round(r.width), h: Math.round(r.height) };
        })
      );
    expect(boxes.length).toBeGreaterThanOrEqual(5);
    for (const box of boxes) expect(box).toEqual({ w: 30, h: 30 });

    // On narrow windows the label is hidden, but the full name stays available
    // as a tooltip/title on the trigger.
    await expect(page.locator('.env-trigger-label')).toBeHidden();
    await expect(page.getByTestId('env-trigger')).toHaveAttribute('title', new RegExp(LONG_ENV));

    await page.setViewportSize({ width: 1280, height: 700 });
    await expect(page.locator('.env-trigger-label')).toBeVisible();
    const label = await page.locator('.env-trigger-label').evaluate((node) => ({
      client: node.clientWidth,
      scroll: node.scrollWidth,
      text: node.textContent,
    }));
    expect(label.text).toBe(LONG_ENV);
    expect(label.scroll).toBeGreaterThan(label.client);
  } finally {
    await closeApp(session);
  }
});
