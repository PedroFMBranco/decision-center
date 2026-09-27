// Fails if the committed dist/main.mjs isn't what the sources build to.
// Orca installs never build, so a stale bundle ships stale code.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'decision-center-'))
try {
  const fresh = join(dir, 'main.mjs')
  execFileSync(process.execPath, ['scripts/build.mjs', fresh], { stdio: 'inherit' })
  if (!readFileSync(fresh).equals(readFileSync('dist/main.mjs'))) {
    console.error('dist/main.mjs is stale. Run `npm run build` and commit the result.')
    process.exit(1)
  }
  console.log('dist/main.mjs matches the sources.')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
