// Bundles the program and the hook into dist/. Usage: node scripts/build.mjs [outdir]
import { chmodSync } from 'node:fs'
import { build } from 'esbuild'

const outdir = process.argv[2] ?? 'dist'
const common = { bundle: true, platform: 'node', format: 'esm', target: 'node22', legalComments: 'none', logLevel: 'warning' }

await build({
  ...common,
  entryPoints: ['src/cli.ts'],
  outfile: `${outdir}/decision-center.mjs`,
  loader: { '.html': 'text' },
  banner: { js: '#!/usr/bin/env node' }
})
chmodSync(`${outdir}/decision-center.mjs`, 0o755)
await build({ ...common, entryPoints: ['src/hook-entry.ts'], outfile: `${outdir}/hook.mjs` })
