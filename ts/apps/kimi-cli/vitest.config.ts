import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'cli',
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
  },
});
