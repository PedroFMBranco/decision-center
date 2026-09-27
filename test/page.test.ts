import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Script } from 'node:vm'

const page = readFileSync(new URL('../src/page.html', import.meta.url), 'utf8')

test('the page script parses', () => {
  const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1])
  assert.equal(scripts.length, 1)
  assert.doesNotThrow(() => new Script(scripts[0] ?? ''))
})

test('the page loads nothing from outside the server', () => {
  // Why: the server's CSP blocks other origins, and the page must work offline.
  assert.doesNotMatch(page, /<(link|script)[^>]+(href|src)=/)
  assert.doesNotMatch(page, /url\((['"]?)https?:/)
})

test('the page calls only endpoints the contract defines', () => {
  const paths = new Set([...page.matchAll(/["'`](\/api\/[a-z/]+)["'`]/g)].map((match) => match[1]))
  assert.deepEqual([...paths].sort(), ['/api/dismiss', '/api/failures', '/api/failures/clear', '/api/open', '/api/read', '/api/reply', '/api/stream', '/api/suggest'])
})
