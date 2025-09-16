import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/hooks.ts'],
  format: ['cjs'],
  target: 'node22',
  outDir: 'dist',
  clean: true,
  minify: false,
  sourcemap: true
})
