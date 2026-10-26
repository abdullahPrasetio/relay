import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/unit/**/*.test.js'],
    testTimeout: 15000,
    hookTimeout: 15000,
  },
});
