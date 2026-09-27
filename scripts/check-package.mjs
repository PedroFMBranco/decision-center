// Fails if the files a git install would ship break Orca's install rules
// (plugin-content-hash.ts: 2,000 entries, 50 MB, no symlinks).
import { execFileSync } from 'node:child_process'
import { lstatSync, readFileSync } from 'node:fs'

const MAX_FILES = 2_000
const MAX_BYTES = 50 * 1024 * 1024

const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
  encoding: 'utf8'
})
  .split('\n')
  .filter((path) => path && lstatSync(path, { throwIfNoEntry: false }))
const manifest = JSON.parse(readFileSync('orca-plugin.json', 'utf8'))
const problems = []
let bytes = 0
for (const path of files) {
  const stat = lstatSync(path)
  if (stat.isSymbolicLink()) problems.push(`symlink: ${path}`)
  bytes += stat.size
}
if (files.length > MAX_FILES) problems.push(`${files.length} files, limit ${MAX_FILES}`)
if (bytes > MAX_BYTES) problems.push(`${bytes} bytes, limit ${MAX_BYTES}`)
for (const path of [manifest.main, 'orca-plugin.json', 'README.md', 'LICENSE']) {
  if (!files.includes(path)) problems.push(`${path} is not committed`)
}
for (const path of files) {
  if (/^(node_modules|issues|research|prototype)\//.test(path)) problems.push(`should not ship: ${path}`)
}
if (problems.length) {
  console.error(`Package check failed:\n  ${problems.join('\n  ')}`)
  process.exit(1)
}
console.log(`Package ships ${files.length} files, ${(bytes / 1024).toFixed(0)} KB.`)
