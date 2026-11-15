import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CLAUDE } from './captured.ts'

const HOOK = new URL('../dist/hook.mjs', import.meta.url).pathname
const RULE = /^Decision Center shows this session[\s\S]*Replies: "first reply"/

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

test('the hook prints the reply-line rule only when an interactive Claude session starts', () => {
  withHome((home) => {
    const start = (agent: string, env: Record<string, string>, event = 'SessionStart') =>
      runHook(home, agent, JSON.stringify({ session_id: 'abc123', hook_event_name: event, cwd: '/code/app', source: 'startup' }), env).stdout
    assert.match(start('claude', { CLAUDE_CODE_ENTRYPOINT: 'cli' }), RULE)
    for (const [agent, env, event] of [
      ['claude', { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' }, 'SessionStart'],
      ['claude', {}, 'SessionStart'],
      ['claude', { CLAUDE_CODE_ENTRYPOINT: 'cli', DECISION_CENTER_REPLY_LINE: 'off' }, 'SessionStart'],
      ['claude', { CLAUDE_CODE_ENTRYPOINT: 'cli' }, 'UserPromptSubmit'],
      ['claude', { CLAUDE_CODE_ENTRYPOINT: 'cli' }, 'Stop'],
      ['codex', { CLAUDE_CODE_ENTRYPOINT: 'cli' }, 'SessionStart']
    ] as const) {
      assert.equal(start(agent, env, event), '', `${agent} ${event} ${JSON.stringify(env)}`)
    }
    assert.equal(readdirSync(join(home, 'sessions')).length, 2)
  })
})

test('the hook prints the reply-line rule to a Codex session only when the terminal UI started it', () => {
  withHome((home) => {
    const meta = (originator: unknown, thread_source: unknown = 'user') =>
      `${JSON.stringify({ type: 'session_meta', payload: { originator, thread_source, base_instructions: { text: 'x'.repeat(100_000) } } })}\n{"type":"turn"}\n`
    const start = (transcript: string | null, env: Record<string, string> = {}, event = 'SessionStart') => {
      const path = join(home, 'rollout.jsonl')
      rmSync(path, { force: true })
      if (transcript !== null) {
        writeFileSync(path, transcript)
      }
      const body = { session_id: 'abc123', hook_event_name: event, cwd: '/code/app', source: 'startup', transcript_path: path }
      return runHook(home, 'codex', JSON.stringify(body), env).stdout
    }
    assert.match(start(meta('codex-tui')), RULE)
    for (const [why, transcript, env, event] of [
      ['a scripted run', meta('codex_exec'), {}, 'SessionStart'],
      ['the desktop app', meta('Codex Desktop'), {}, 'SessionStart'],
      ['no originator', meta(null), {}, 'SessionStart'],
      ['a thread the terminal UI started for itself', meta('codex-tui', 'guardian_review'), {}, 'SessionStart'],
      ['no thread source', meta('codex-tui', null), {}, 'SessionStart'],
      ['no transcript file', null, {}, 'SessionStart'],
      ['a first line that is not JSON', 'codex-tui\n', {}, 'SessionStart'],
      ['a first line with no end', meta('codex-tui').split('\n')[0]!, {}, 'SessionStart'],
      ['switched off', meta('codex-tui'), { DECISION_CENTER_REPLY_LINE: 'off' }, 'SessionStart'],
      ['another event', meta('codex-tui'), {}, 'UserPromptSubmit']
    ] as const) {
      assert.equal(start(transcript, env, event), '', why)
    }
    const noPath = { session_id: 'abc123', hook_event_name: 'SessionStart', cwd: '/code/app', source: 'startup', transcript_path: null }
    assert.equal(runHook(home, 'codex', JSON.stringify(noPath)).stdout, '')
  })
})
