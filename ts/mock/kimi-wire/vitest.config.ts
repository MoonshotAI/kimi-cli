import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'kimi-wire-mock',
    include: ['test/**/*.test.ts'],
  },
});
