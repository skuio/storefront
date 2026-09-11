import { defineConfig } from 'tsup'

export default defineConfig({
  entry: { index: 'src/index.ts', stripe: 'src/stripe.ts' },
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  external: ['stripe'],
})
