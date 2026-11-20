import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Resolves the path aliases declared in tsconfig.json, including the ones
  // added by `nest g library`. Requires Vite 8, which ships this option.
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    fileParallelism: false, // test files share one database
    testTimeout: 20_000,
    hookTimeout: 30_000,
    env: {
      DATABASE_URL:
        process.env.TEST_DATABASE_URL ??
        'postgres://wallet:wallet@localhost:5432/wallet_test',
    },
    include: ['**/*.spec.ts'],
  },
});
