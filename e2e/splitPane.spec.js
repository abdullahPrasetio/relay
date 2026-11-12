import { expect, test } from '@playwright/test';
import { closeApp, launchApp } from './helpers/app.js';

async function dragDivider(page, targetY) {
  const divider = page.locator('.split-divider');
  const box = await divider.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, targetY, { steps: 8 });
  await page.mouse.up();
}

test('request/response divider collapses to either edge', async () => {
  const session = await launchApp();
  const { page } = session;
  try {
    const pane = page.locator('.split-pane');
    const paneBox = await pane.boundingBox();

    // Drag the response pane down to its header: the request panel should take
    // almost the whole split, like Postman's full-height request view.
    await dragDivider(page, paneBox.y + paneBox.height - 1);
    const bottomBox = await page.locator('.split-bottom').boundingBox();
    expect(bottomBox.height).toBeGreaterThan(40);
    expect(bottomBox.height).toBeLessThanOrEqual(60);

    // Drag the request pane up to zero height: response fills the split.
    await dragDivider(page, paneBox.y + 1);
    const topBox = await page.locator('.split-top').boundingBox();
    expect(topBox.height).toBeLessThanOrEqual(4);

    // The divider must still be usable to bring the request pane back.
    await dragDivider(page, paneBox.y + paneBox.height * 0.5);
    const restored = await page.locator('.split-top').boundingBox();
    expect(restored.height).toBeGreaterThan(paneBox.height * 0.4);
  } finally {
    await closeApp(session);
  }
});
