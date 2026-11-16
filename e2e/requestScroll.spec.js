import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { closeApp, launchAppAt, makeUserData } from './helpers/app.js';

// The request bar (method, URL, Send, Save) must stay pinned while a long
// request editor (headers/body/params) scrolls, like Postman. Regression for
// the whole split-top pane scrolling the URL bar out of view.
function seed() {
  const headers = Array.from({ length: 40 }, (_, i) => ({
    key: `X-Header-${i + 1}`,
    value: `value-${i + 1}`,
    enabled: true,
  }));
  return {
    schemaVersion: 3,
    activeWorkspaceId: 'ws_scroll',
    workspaces: [
      {
        id: 'ws_scroll',
        name: 'Default',
        collections: [
          {
            id: 'col_scroll',
            name: 'Scroll',
            variables: [],
            items: [
              {
                id: 'req_scroll',
                type: 'request',
                name: 'Long Headers',
                method: 'GET',
                url: 'http://localhost:3000/health',
                headers,
              },
            ],
          },
        ],
        environments: [],
        globals: [],
        history: [],
        activeEnvId: null,
      },
    ],
  };
}

test('request URL bar stays fixed while the editor scrolls', async () => {
  const userData = makeUserData();
  fs.writeFileSync(path.join(userData, 'rest-tamer-data.json'), JSON.stringify(seed(), null, 2));
  const session = await launchAppAt(userData);
  const { page } = session;

  try {
    await page.waitForSelector('.collection-row');
    await page.getByTestId('collections-expand-all').click();
    await page.locator('.request-row', { hasText: 'Long Headers' }).click();
    await page.locator('.request-panel .tabs').getByRole('button', { name: /^Headers/ }).click();

    const content = page.locator('.request-panel > .tab-content');
    const urlBar = page.locator('.request-panel > .url-bar');
    const before = await urlBar.boundingBox();
    const geometry = await content.evaluate((el) => ({
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    }));
    expect(geometry.scrollHeight).toBeGreaterThan(geometry.clientHeight + 200);

    const scrolled = await content.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
      return el.scrollTop;
    });
    expect(scrolled).toBeGreaterThan(0);

    const after = await urlBar.boundingBox();
    expect(Math.abs(after.y - before.y)).toBeLessThan(1);
    await expect(page.locator('.request-panel .send-btn')).toBeVisible();
    expect(await page.locator('.split-top').evaluate((el) => el.scrollTop)).toBe(0);
  } finally {
    await closeApp(session);
  }
});
