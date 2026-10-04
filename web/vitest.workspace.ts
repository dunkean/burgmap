import { configDefaults, defineWorkspace } from 'vitest/config';

// Keep every invariant in the default run; separate the exhaustive city matrix for development.
const slow = ['tests/urban.cultures.city.test.ts'];

export default defineWorkspace([
  {
    extends: './vitest.config.ts',
    test: { name: 'fast', include: ['tests/**/*.test.ts'], exclude: [...configDefaults.exclude, ...slow] },
  },
  {
    extends: './vitest.config.ts',
    test: { name: 'slow', include: slow },
  },
]);
