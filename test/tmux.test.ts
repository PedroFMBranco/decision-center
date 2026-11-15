import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { focus, panes, parseScreen, screen, send } from '../src/tmux.ts'
import { TerminalError } from '../src/terminal.ts'
import { CLAUDE_AFTER_TURN, CLAUDE_CURSOR_MID, CLAUDE_PLACEHOLDER, CLAUDE_TYPED } from './styled-screens.ts'

test("Claude's dim placeholder is not a draft; typed text is", () => {
  assert.equal(parseScreen(CLAUDE_PLACEHOLDER).draft, null)
  assert.equal(parseScreen(CLAUDE_AFTER_TURN).draft, null)
  assert.equal(parseScreen(CLAUDE_TYPED).draft, 'half typed draft')
  assert.equal(parseScreen(CLAUDE_CURSOR_MID).draft, 'half typed draft')
})

test('plain lines carry no styling and keep what reply.ts parses', () => {
  const { lines } = parseScreen(CLAUDE_TYPED)
  assert.ok(lines.every((line) => !line.includes('\x1b')))
  assert.ok(lines.includes('❯\xa0half typed draft'))
  assert.ok(lines.at(-1)?.includes('manual mode on'))
})

test("Codex's dim placeholder is not a draft; plain typed text is", () => {
  const rows = ['  › 1. Spring', '    2. Summer']
  assert.equal(parseScreen([...rows, '\x1b[1m›\x1b[0m \x1b[2mAsk Codex to do anything\x1b[0m', '']).draft, null)
  assert.equal(parseScreen(['\x1b[1m›\x1b[0m fix the build', '  ? for shortcuts']).draft, 'fix the build')
  assert.equal(parseScreen(['\x1b[1m›\x1b[0m \x1b[38;5;244mpredicted next step\x1b[39m']).draft, null)
})

test('dim and grey carry over from the line above, as capture-pane writes them', () => {
  const rule = '─'.repeat(20)
  assert.equal(parseScreen([rule, '❯\xa0\x1b[2mTry "fix', 'typecheck"\x1b[0m', rule]).draft, null)
  assert.equal(parseScreen([rule, '❯\xa0\x1b[38;2;128;128;128mgrey\x1b[39m mine', rule]).draft, 'mine')
})

const hasTmux = spawnSync('tmux', ['-V']).status === 0

test('a private tmux server: types literally, reads the screen, refuses copy mode, focuses', { skip: !hasTmux && 'tmux not installed' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dc-tmux-'))
  const socket = join(dir, 's')
  try {
    execFileSync('tmux', ['-S', socket, 'new-session', '-d', '-x', '80', '-y', '10', 'cat -v'])
    const [pane] = await panes([socket])
    assert.ok(pane && /^%\d+$/.test(pane.id) && pane.tty.startsWith('/dev/'))
    // A background service has no locale, and tmux then writes its formats differently.
    const locale = Object.fromEntries(['LANG', 'LC_ALL', 'LC_CTYPE'].map((name) => [name, process.env[name]]))
    try {
      for (const name of Object.keys(locale)) delete process.env[name]
      assert.deepEqual(await panes([socket]), [pane])
    } finally {
      for (const [name, value] of Object.entries(locale)) if (value !== undefined) process.env[name] = value
    }
    await send(pane, { text: '-a; "b" \x1b[1;3A;', enter: true })
    await new Promise((done) => setTimeout(done, 300))
    assert.equal((await screen(pane)).lines[0], '-a; "b" ^[[1;3A;')
    execFileSync('tmux', ['-S', socket, 'copy-mode', '-t', pane.id])
    await assert.rejects(screen(pane), (error) => error instanceof TerminalError && error.code === 'pane_in_mode')
    execFileSync('tmux', ['-S', socket, 'send-keys', '-t', pane.id, '-X', 'cancel'])
    await focus(pane)
    assert.deepEqual(await panes([join(dir, 'missing')]), [])
  } finally {
    spawnSync('tmux', ['-S', socket, 'kill-server'])
    rmSync(dir, { recursive: true, force: true })
  }
})
