import { resolve } from 'node:path';

import { defineConfig } from 'vitest/config';

const here = import.meta.dirname;

export default defineConfig({
  resolve: {
    alias: {
      '@moonshot-ai/core': resolve(here, '../../packages/kimi-core/src/index.ts'),
    },
  },
  test: {
    name: 'cli',
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
  },
});
