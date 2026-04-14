import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['./src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  outDir: 'dist',
  clean: true,
  deps: { neverBundle: ['@moonshot-ai/core', '@moonshot-ai/kosong'] },
});
