import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 60000,
  workers: 1,
  // CI runners occasionally stall during Electron quit or window startup;
  // retry once there while keeping local failures immediate.
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: { trace: 'retain-on-failure' },
});
