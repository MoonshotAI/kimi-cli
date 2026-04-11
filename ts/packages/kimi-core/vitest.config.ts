import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'kimi-core',
    include: ['test/**/*.test.ts'],
  },
});
