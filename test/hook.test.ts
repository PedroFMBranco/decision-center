import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CLAUDE } from './captured.ts'

const HOOK = new URL('../dist/hook.mjs', import.meta.url).pathname

function runHook(home: string, agent: string, stdin: string, env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [HOOK, agent], {
    input: stdin,
    env: { PATH: process.env.PATH ?? '', DECISION_CENTER_HOME: home, ...env },
    encoding: 'utf8',
    timeout: 10_000
  })
}

function withHome(body: (home: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), 'dc-hook-'))
  try {
    body(home)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

test('the hook appends one private line per call to the session file and prints nothing', () => {
  withHome((home) => {
    const row = CLAUDE[11]!
    for (let i = 0; i < 2; i++) {
      const result = runHook(home, 'claude', JSON.stringify(row.body), row.env)
      assert.deepEqual([result.status, result.stdout, result.stderr], [0, '', ''])
    }
    const dir = join(home, 'sessions')
    const file = join(dir, 'claude-02b924eb.jsonl')
    const lines = readFileSync(file, 'utf8').trimEnd().split('\n').map((line) => JSON.parse(line))
    assert.deepEqual(lines.map((line) => [line.event, line.tool.summary, line.pane.id]), [
      ['PostToolUse', 'touch c.txt', '%0'],
      ['PostToolUse', 'touch c.txt', '%0']
    ])
    assert.equal(statSync(file).mode & 0o777, 0o600)
    assert.equal(statSync(dir).mode & 0o777, 0o700)
    assert.doesNotMatch(readFileSync(file, 'utf8'), /secret output/)
  })
})

test('garbage, an unknown agent or an unsafe session id exits 0 and writes nothing', () => {
  withHome((home) => {
    for (const [agent, stdin] of [
      ['claude', 'not json'],
      ['claude', ''],
      ['gemini', JSON.stringify(CLAUDE[0]!.body)],
      ['codex', JSON.stringify({ session_id: '../x', hook_event_name: 'Stop' })]
    ] as const) {
      const result = runHook(home, agent, stdin)
      assert.deepEqual([result.status, result.stdout], [0, ''], `${agent} ${stdin}`)
    }
    assert.deepEqual(readdirSync(home), [])
  })
})
