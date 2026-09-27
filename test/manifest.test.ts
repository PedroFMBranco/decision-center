import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'

// Mirrors Orca 1.4.206's manifest rules (plugin-manifest.ts and
// plugin-manifest-contribution-validation.ts) that a bad edit can break.
const manifest = JSON.parse(readFileSync('orca-plugin.json', 'utf8'))
const kinds = manifest.capabilities.map((capability: { kind: string }) => capability.kind)

test('manifest identity and entry point', () => {
  assert.equal(manifest.manifestVersion, 1)
  assert.equal(manifest.pluginApi, 1)
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/)
  assert.ok(existsSync(manifest.main), `${manifest.main} must be committed`)
})

test('subscribing to events requires main and the events:subscribe capability', () => {
  if (manifest.contributes.events?.length) {
    assert.ok(manifest.main)
    assert.ok(kinds.includes('events:subscribe'))
  }
})

test('the heartbeat needs the storage capability', () => {
  assert.ok(kinds.includes('storage'))
})

test('contributes only has keys Orca accepts', () => {
  const allowed = ['panels', 'commands', 'events', 'languagePacks', 'keybindings', 'vmRecipes', 'agents']
  for (const key of Object.keys(manifest.contributes)) {
    assert.ok(allowed.includes(key), `unknown contributes key ${key}`)
  }
})

test('capabilities match what the README discloses', () => {
  // No notifications:show: alerts come from Orca's own notifications (issue 0020).
  assert.deepEqual([...kinds].sort(), ['events:subscribe', 'storage'])
})

test('publisher and repository are set for the marketplace', () => {
  assert.equal(`${manifest.publisher}.${manifest.id}`, 'coldfox.decision-center')
  assert.match(manifest.repository, /^https:\/\/github\.com\//)
})
