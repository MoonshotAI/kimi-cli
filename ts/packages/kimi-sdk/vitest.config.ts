import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'kimi-sdk',
    include: ['test/**/*.test.ts'],
  },
});
