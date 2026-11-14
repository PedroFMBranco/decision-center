// Bundles the program and the hook into dist/. Usage: node scripts/build.mjs [outdir]
import { build } from 'esbuild'

const outdir = process.argv[2] ?? 'dist'
const common = { bundle: true, platform: 'node', format: 'esm', target: 'node22', legalComments: 'none', logLevel: 'warning' }

await build({ ...common, entryPoints: ['src/main.ts'], outfile: `${outdir}/main.mjs`, loader: { '.html': 'text' } })
await build({ ...common, entryPoints: ['src/hook-entry.ts'], outfile: `${outdir}/hook.mjs` })
