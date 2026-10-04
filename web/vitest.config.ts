import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 60000,
    pool: 'forks',
    minWorkers: 1,
    maxWorkers: 2,
  },
});
