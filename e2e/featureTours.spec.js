/* global localStorage */
import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { closeApp, launchAppAt, makeUserData, waitForAppReady } from './helpers/app.js';

const TOUR_ENV = { RELAY_DISABLE_FEATURE_TOURS: '0' };

function seed() {
  return {
    schemaVersion: 3,
    activeWorkspaceId: 'ws_tour',
    workspaces: [
      {
        id: 'ws_tour',
        name: 'Existing Workspace',
        collections: [
          {
            id: 'col_tour',
            name: 'Existing API',
            variables: [],
            items: [
              {
                id: 'req_tour',
                type: 'request',
                name: 'Existing Request',
                method: 'GET',
                url: 'https://api.example.test/health',
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

async function quitKeepingData({ app }) {
  await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => {});
  await app.close().catch(() => {});
}

test('first install shows the welcome tour and skipping it is permanent', async () => {
  const userData = makeUserData();
  let session = await launchAppAt(userData, TOUR_ENV, { keepDashboard: true });
  let { page } = session;

  try {
    await expect(page.getByTestId('feature-welcome')).toBeVisible();
    await page.getByTestId('feature-welcome-skip').click();
    await expect(page.getByTestId('feature-welcome')).toHaveCount(0);

    await quitKeepingData(session);
    session = await launchAppAt(userData, TOUR_ENV, { keepDashboard: true });
    page = session.page;
    await expect(page.getByTestId('feature-welcome')).toHaveCount(0);
    await expect(page.getByTestId('feature-tour')).toHaveCount(0);
  } finally {
    await closeApp(session);
  }
});

test('core tour advances and contextual request tips appear once', async () => {
  const userData = makeUserData();
  const session = await launchAppAt(userData, TOUR_ENV, { keepDashboard: true });
  const { page } = session;

  try {
    await expect(page.getByTestId('feature-welcome')).toBeVisible();
    await page.getByTestId('feature-welcome-start').click();
    await expect(page.getByTestId('feature-tour')).toBeVisible();
    await expect(page.getByTestId('feature-tour')).toContainText('Switch workspaces');

    for (let step = 0; step < 12; step += 1) {
      const tour = page.getByTestId('feature-tour');
      if ((await tour.count()) === 0) break;
      await page.getByTestId('feature-tour-next').click();
    }
    await expect(page.getByTestId('feature-tour')).toHaveCount(0);

    await page.getByTestId('dashboard-new-request').click();
    await expect(page.getByTestId('feature-tour')).toBeVisible();
    await expect(page.getByTestId('feature-tour')).toContainText('Choose a method and URL');
    await page.getByTestId('feature-tour-skip-step').click();
    await expect(page.getByTestId('feature-tour')).toContainText('Send and stop requests');
  } finally {
    await closeApp(session);
  }
});

test('existing installs do not get the first-run welcome', async () => {
  const userData = makeUserData();
  fs.writeFileSync(path.join(userData, 'rest-tamer-data.json'), JSON.stringify(seed(), null, 2));
  const session = await launchAppAt(userData, TOUR_ENV, { keepDashboard: true });
  const { page } = session;

  try {
    await expect(page.getByTestId('feature-welcome')).toHaveCount(0);
    await expect(page.getByTestId('feature-tour')).toHaveCount(0);
    await expect(page.getByTestId('whats-new')).toBeVisible();
    await page.getByTestId('whats-new-dismiss').click();
    await page.getByTestId('feature-guide-open').click();
    await expect(page.getByTestId('feature-guide')).toBeVisible();
  } finally {
    await closeApp(session);
  }
});

test('feature guide replays a feature and records it as seen', async () => {
  const userData = makeUserData();
  const session = await launchAppAt(userData, TOUR_ENV, { keepDashboard: true });
  const { page } = session;

  try {
    await page.getByTestId('feature-welcome-skip').click();
    await page.getByTestId('feature-guide-open').click();
    await expect(page.getByTestId('feature-guide')).toBeVisible();
    await page.getByTestId('feature-guide-show-request.send').click();
    await expect(page.getByTestId('feature-tour')).toContainText('Send and stop requests');
    await page.getByRole('button', { name: 'Done' }).click();
    await page.getByTestId('feature-guide-open').click();
    await expect(page.getByTestId('feature-guide')).toContainText('Seen');
  } finally {
    await closeApp(session);
  }
});

test('skipped request tips do not return after a restart', async () => {
  const userData = makeUserData();
  let session = await launchAppAt(userData, TOUR_ENV, { keepDashboard: true });
  let { page } = session;

  try {
    await page.getByTestId('feature-welcome-start').click();
    for (let step = 0; step < 12; step += 1) {
      const tour = page.getByTestId('feature-tour');
      if ((await tour.count()) === 0) break;
      await page.getByTestId('feature-tour-next').click();
    }
    await page.getByTestId('dashboard-new-request').click();
    await expect(page.getByTestId('feature-tour')).toContainText('Choose a method and URL');
    await page.getByTestId('feature-tour-skip-step').click();
    await page.getByTestId('feature-tour-skip').click();

    await quitKeepingData(session);
    session = await launchAppAt(userData, TOUR_ENV, { keepDashboard: true });
    page = session.page;
    await expect(page.getByTestId('feature-tour')).toHaveCount(0);
  } finally {
    await closeApp(session);
  }
});

test('an app update queues new features once', async () => {
  const userData = makeUserData();
  const session = await launchAppAt(userData, TOUR_ENV, { keepDashboard: true });
  const { page } = session;

  try {
    await page.evaluate(() => {
      localStorage.setItem(
        'relay-feature-tours-v1',
        JSON.stringify({
          schemaVersion: 1,
          lastAppVersion: '0.25.0',
          enabled: true,
          seen: {},
        })
      );
    });
    await page.reload();
    await waitForAppReady(page, { keepDashboard: true });
    await expect(page.getByTestId('whats-new')).toBeVisible();
    await page.getByTestId('whats-new-dismiss').click();
    await expect(page.getByTestId('whats-new')).toHaveCount(0);

    await page.reload();
    await waitForAppReady(page, { keepDashboard: true });
    await expect(page.getByTestId('whats-new')).toHaveCount(0);
  } finally {
    await closeApp(session);
  }
});

test('a beta state that hid the guide announcement reopens it once', async () => {
  const userData = makeUserData();
  const session = await launchAppAt(userData, TOUR_ENV, { keepDashboard: true });
  const { page } = session;

  try {
    await page.evaluate(() => {
      localStorage.setItem(
        'relay-feature-tours-v1',
        JSON.stringify({
          schemaVersion: 1,
          lastAppVersion: '0.27.0-beta.2',
          enabled: true,
          seen: {
            'help.featureGuide': {
              action: 'completed',
              version: '0.27.0-beta.2',
              at: '2026-11-13T00:00:00.000Z',
            },
          },
        })
      );
    });
    await page.reload();
    await waitForAppReady(page, { keepDashboard: true });
    await expect(page.getByTestId('whats-new')).toBeVisible();
    await page.getByTestId('whats-new-dismiss').click();

    await page.reload();
    await waitForAppReady(page, { keepDashboard: true });
    await expect(page.getByTestId('whats-new')).toHaveCount(0);
  } finally {
    await closeApp(session);
  }
});

test('manual Tips button starts a tour for the current screen', async () => {
  const userData = makeUserData();
  const session = await launchAppAt(userData, TOUR_ENV, { keepDashboard: true });
  const { page } = session;

  try {
    await page.getByTestId('feature-welcome-skip').click();
    await page.getByTestId('feature-tour-start').click();
    await expect(page.getByTestId('feature-tour')).toContainText('Import existing work');
    await page.getByTestId('feature-tour-skip').click();
    await expect(page.getByTestId('feature-tour')).toHaveCount(0);
  } finally {
    await closeApp(session);
  }
});
