// Bundles the worker into one ESM file. Usage: node scripts/build.mjs [outfile]
import { build } from 'esbuild'

const outfile = process.argv[2] ?? 'dist/main.mjs'

await build({
  entryPoints: ['src/main.ts'],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  loader: { '.html': 'text' },
  legalComments: 'none',
  logLevel: 'warning'
})
