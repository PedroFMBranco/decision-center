import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { runArgs } from '../src/run.ts'

const CLI = new URL('../dist/decision-center.mjs', import.meta.url).pathname
const hasTmux = spawnSync('tmux', ['-V']).status === 0
const hasScript = process.platform === 'darwin'

test('the session gets the caller\'s environment and folder, minus tmux\'s own variables', () => {
  const args = runArgs(['/bin/claude', "it's; here", ';'], {
    env: { PATH: '/bin', FOO: 'a b', TMUX: 'x,1,0', TMUX_PANE: '%1', TERM: 'xterm', 'BAD-NAME': '1', GONE: undefined },
    cwd: '/code/app',
    platform: 'linux',
    id: 'ab12'
  })
  const start = args.indexOf('new-session')
  assert.deepEqual(args.slice(start), ['new-session', '-s', 'claude-ab12', '-c', '/code/app', '-e', 'PATH=/bin', '-e', 'FOO=a b', '--', `exec '/bin/claude' 'it'\\''s; here' ';'`])
  assert.deepEqual(args.slice(0, 5), ['-L', 'decision-center', '-f', '/dev/null', 'start-server'])
  assert.equal(args.includes('pbcopy'), false)
  assert.equal(runArgs(['claude'], { env: {}, cwd: '/', platform: 'darwin', id: 'x' }).includes('pbcopy'), true)
})

test('run starts the command in a tmux pane on its own server, with no status line', { skip: (!hasTmux || !hasScript) && 'needs tmux and macOS script' }, () => {
  // Why /tmp: a tmux socket path has to stay under 104 characters.
  const dir = realpathSync(mkdtempSync('/tmp/dc-run-'))
  try {
    const out = join(dir, 'out')
    const report = `echo "$TMUX_PANE|$TMUX|$FOO|$PWD|$1|$(tmux show -gv status)" > ${out}`
    const run = spawnSync('script', ['-q', '/dev/null', process.execPath, CLI, 'run', 'sh', '-c', report, 'sh', 'semi;'], {
      cwd: dir,
      env: { PATH: process.env.PATH ?? '', HOME: dir, TMUX_TMPDIR: dir, TERM: 'xterm-256color', FOO: 'a b;c' },
      // Why ignore: script refuses a pipe as its input.
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      timeout: 20000
    })
    assert.equal(run.status, 0, run.stdout + run.stderr)
    const [pane, tmux, foo, pwd, arg, status] = readFileSync(out, 'utf8').trim().split('|')
    assert.match(pane!, /^%\d+$/)
    assert.match(tmux!, new RegExp(`^${dir}/tmux-\\d+/decision-center,`))
    assert.deepEqual([foo, pwd, arg, status], ['a b;c', dir, 'semi;', 'off'])
  } finally {
    spawnSync('tmux', ['-S', join(dir, `tmux-${process.getuid?.()}`, 'decision-center'), 'kill-server'])
    rmSync(dir, { recursive: true, force: true })
  }
})
