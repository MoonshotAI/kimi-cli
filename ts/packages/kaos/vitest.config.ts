import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'kaos',
    include: ['test/**/*.test.ts'],
  },
});
