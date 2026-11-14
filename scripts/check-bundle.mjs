// Fails if a committed bundle in dist/ isn't what the sources build to, or if
// the hook bundle imports more than it may. Installs never build, so a stale
// bundle ships stale code.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BUNDLES = ['decision-center.mjs', 'hook.mjs']
const HOOK_IMPORTS = new Set(['node:fs', 'node:path', 'node:os', 'node:crypto'])

const dir = mkdtempSync(join(tmpdir(), 'decision-center-'))
try {
  execFileSync(process.execPath, ['scripts/build.mjs', dir], { stdio: 'inherit' })
  const stale = BUNDLES.filter((name) => !existsSync(join('dist', name)) || !readFileSync(join(dir, name)).equals(readFileSync(join('dist', name))))
  if (stale.length) {
    console.error(`${stale.map((name) => `dist/${name}`).join(', ')} stale. Run \`npm run build\` and commit the result.`)
    process.exit(1)
  }
  const hook = readFileSync('dist/hook.mjs', 'utf8')
  const imports = [...hook.matchAll(/(?:from|import)\s*["']([^"']+)["']/g)].map((match) => match[1])
  const extra = imports.filter((name) => !HOOK_IMPORTS.has(name))
  if (extra.length) {
    console.error(`dist/hook.mjs imports ${extra.join(', ')}; it may import only ${[...HOOK_IMPORTS].join(', ')}.`)
    process.exit(1)
  }
  console.log(`${BUNDLES.map((name) => `dist/${name}`).join(' and ')} match the sources.`)
} finally {
  rmSync(dir, { recursive: true, force: true })
}
