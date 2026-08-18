import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Each test builds its own app + repository, so there is no shared state to
    // serialize on and files can run in parallel.
    globals: false,
  },
});
