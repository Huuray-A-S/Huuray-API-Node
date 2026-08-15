import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // No test may reach the network. Every test injects its own fetch.
    testTimeout: 10_000,
  },
});
