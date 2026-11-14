import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyHooks, hookCommand, installedEvents, parseHookCommand, HOOK_EVENTS } from '../src/install.ts'

const CLI = new URL('../dist/decision-center.mjs', import.meta.url).pathname
const command = (agent: 'claude' | 'codex') => hookCommand('/usr/bin/node', "/code/it's here/dist/hook.mjs", agent)

// Other tools' entries, shaped like the ones found in real settings files.
const CLAUDE_SETTINGS = `${JSON.stringify(
  {
    permissions: { allow: ['Bash(ls:*)'] },
    hooks: {
      PreToolUse: [
        { hooks: [{ type: 'command', command: "'/usr/local/bin/bothy' hook claude-code PreToolUse", timeout: 5 }] },
        { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo pre' }] }
      ],
      Notification: [{ hooks: [{ type: 'command', command: 'say done' }] }]
    },
    model: 'opus'
  },
  null,
  2
)}\n`
const CODEX_HOOKS = `${JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: ': other-tool-hook-form=1; true', timeout: 10 }] }] } }, null, 1)}\n`

function withDir(body: (dir: string) => Promise<void> | void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'dc-install-'))
  return Promise.resolve(body(dir)).finally(() => rmSync(dir, { recursive: true, force: true }))
}

const backups = (dir: string) => readdirSync(dir).filter((name) => name.includes('.decision-center-backup-'))

test('install adds one entry per event after the others, and uninstall restores the file byte for byte', () =>
  withDir(async (dir) => {
    const path = join(dir, 'settings.json')
    writeFileSync(path, CLAUDE_SETTINGS)
    const [installed] = await applyHooks([{ agent: 'claude', path }], command, { dryRun: false })
    assert.equal(installed?.status, 'changed')
    const config = JSON.parse(readFileSync(path, 'utf8'))
    assert.deepEqual(Object.keys(config), ['permissions', 'hooks', 'model'])
    assert.deepEqual(config.hooks.PreToolUse.map((group: { hooks: { command: string }[] }) => group.hooks[0]!.command), [
      "'/usr/local/bin/bothy' hook claude-code PreToolUse",
      'echo pre',
      command('claude')
    ])
    assert.deepEqual(installedEvents(readFileSync(path, 'utf8')).sort(), [...HOOK_EVENTS.claude].sort())
    assert.equal(readFileSync(installed!.backup!, 'utf8'), CLAUDE_SETTINGS)
    const [removed] = await applyHooks([{ agent: 'claude', path }], null, { dryRun: false })
    assert.equal(removed?.status, 'changed')
    assert.equal(readFileSync(path, 'utf8'), CLAUDE_SETTINGS)
  }))

test('a second install changes nothing and writes no second backup', () =>
  withDir(async (dir) => {
    const path = join(dir, 'hooks.json')
    writeFileSync(path, CODEX_HOOKS)
    await applyHooks([{ agent: 'codex', path }], command, { dryRun: false })
    const once = readFileSync(path, 'utf8')
    assert.match(once, /^\{\n "hooks"/, 'keeps the file indent')
    const [again] = await applyHooks([{ agent: 'codex', path }], command, { dryRun: false })
    assert.deepEqual([again?.status, readFileSync(path, 'utf8'), backups(dir).length], ['unchanged', once, 1])
  }))

test('an older entry of ours is replaced where it stands, and duplicates go', () =>
  withDir(async (dir) => {
    const path = join(dir, 'settings.json')
    const old = { type: 'command', command: "'/old/node' '/old/decision-center/dist/hook.mjs' claude # decision-center hook" }
    const other = { hooks: [{ type: 'command', command: 'echo stop' }] }
    writeFileSync(path, JSON.stringify({ hooks: { Stop: [{ hooks: [old] }, other, { hooks: [old] }], Notification: [{ hooks: [old] }] } }))
    const [result] = await applyHooks([{ agent: 'claude', path }], command, { dryRun: false })
    const hooks = JSON.parse(readFileSync(path, 'utf8')).hooks
    assert.deepEqual(hooks.Stop, [{ hooks: [{ type: 'command', command: command('claude'), timeout: 10 }] }, other])
    assert.equal(hooks.Notification, undefined)
    assert.deepEqual(result?.changes.filter((c) => c.event === 'Stop' || c.event === 'Notification'), [
      { event: 'Stop', action: 'update' },
      { event: 'Notification', action: 'remove' }
    ])
  }))

test('dry run, a missing folder and invalid JSON leave every file alone', () =>
  withDir(async (dir) => {
    const path = join(dir, 'settings.json')
    writeFileSync(path, CLAUDE_SETTINGS)
    const [dry] = await applyHooks([{ agent: 'claude', path }], command, { dryRun: true })
    assert.equal(dry?.status, 'would-change')
    assert.equal(readFileSync(path, 'utf8'), CLAUDE_SETTINGS)
    const [skipped] = await applyHooks([{ agent: 'codex', path: join(dir, 'nope', 'hooks.json') }], command, { dryRun: false })
    assert.equal(skipped?.status, 'no-folder')
    writeFileSync(path, '{ not json')
    await assert.rejects(applyHooks([{ agent: 'claude', path }], command, { dryRun: false }), /not valid JSON/)
    assert.equal(readFileSync(path, 'utf8'), '{ not json')
    assert.deepEqual(backups(dir), [])
  }))

test('a symlinked config file is updated through the link, which stays a link', () =>
  withDir(async (dir) => {
    const real = join(dir, 'dotfiles-settings.json')
    const link = join(dir, 'settings.json')
    writeFileSync(real, CLAUDE_SETTINGS)
    symlinkSync(real, link)
    await applyHooks([{ agent: 'claude', path: link }], command, { dryRun: false })
    assert.ok(lstatSync(link).isSymbolicLink())
    assert.equal(installedEvents(readFileSync(real, 'utf8')).length, HOOK_EVENTS.claude.length)
  }))

test('the installed command runs the hook through the shell, quotes and all', () =>
  withDir((dir) => {
    const hook = join(dir, "it's here", 'hook.mjs')
    mkdirSync(join(dir, "it's here"))
    writeFileSync(hook, readFileSync(new URL('../dist/hook.mjs', import.meta.url)))
    const run = spawnSync('/bin/sh', ['-c', hookCommand(process.execPath, hook, 'codex')], {
      input: JSON.stringify({ session_id: 'abc', cwd: '/c', hook_event_name: 'Stop', last_assistant_message: 'ok' }),
      env: { DECISION_CENTER_HOME: join(dir, 'home') },
      encoding: 'utf8'
    })
    assert.deepEqual([run.status, run.stdout], [0, ''])
    assert.equal(JSON.parse(readFileSync(join(dir, 'home', 'sessions', 'codex-abc.jsonl'), 'utf8')).lastMessage, 'ok')
  }))

test('the CLI touches only the file a path flag names, and the default files under HOME otherwise', () =>
  withDir((dir) => {
    mkdirSync(join(dir, '.claude'))
    mkdirSync(join(dir, '.codex'))
    writeFileSync(join(dir, '.codex', 'hooks.json'), CODEX_HOOKS)
    const named = join(dir, 'named.json')
    writeFileSync(named, '{}\n')
    const cli = (...args: string[]) => spawnSync(process.execPath, [CLI, ...args], { env: { HOME: dir, PATH: process.env.PATH ?? '' }, encoding: 'utf8' })
    const one = cli('install', '--claude-settings', named)
    assert.equal(one.status, 0, one.stderr)
    assert.equal(installedEvents(readFileSync(named, 'utf8')).length, HOOK_EVENTS.claude.length)
    assert.equal(readFileSync(join(dir, '.codex', 'hooks.json'), 'utf8'), CODEX_HOOKS)
    assert.equal(existsSync(join(dir, '.claude', 'settings.json')), false)
    const both = cli('install')
    assert.equal(both.status, 0, both.stderr)
    assert.match(both.stdout, /trust new or changed hooks/)
    assert.equal(installedEvents(readFileSync(join(dir, '.claude', 'settings.json'), 'utf8')).length, HOOK_EVENTS.claude.length)
    assert.equal(installedEvents(readFileSync(join(dir, '.codex', 'hooks.json'), 'utf8')).length, HOOK_EVENTS.codex.length)
    assert.match(cli('status').stdout, /Claude Code hooks: installed/)
    assert.equal(cli('uninstall').status, 0)
    assert.equal(readFileSync(join(dir, '.codex', 'hooks.json'), 'utf8'), CODEX_HOOKS)
  }))

test('the installed hook is a copy in the home folder that records without the checkout, and status says when it is gone', () =>
  withDir((dir) => {
    mkdirSync(join(dir, '.claude'))
    const env = { HOME: dir, PATH: process.env.PATH ?? '' }
    const cli = (...args: string[]) => spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8' })
    assert.equal(cli('install', '--dry-run').status, 0)
    assert.equal(existsSync(join(dir, '.decision-center')), false)
    assert.equal(cli('install').status, 0)
    const settings = JSON.parse(readFileSync(join(dir, '.claude', 'settings.json'), 'utf8'))
    const installed: string = settings.hooks.Stop[0].hooks[0].command
    const copy = join(dir, '.decision-center', 'hook.mjs')
    assert.deepEqual(parseHookCommand(installed), { node: process.execPath, hookPath: copy })
    const run = spawnSync('/bin/sh', ['-c', installed], {
      input: JSON.stringify({ session_id: 'abc', cwd: '/c', hook_event_name: 'Stop', last_assistant_message: 'ok' }),
      env,
      encoding: 'utf8'
    })
    assert.deepEqual([run.status, run.stdout], [0, ''])
    assert.equal(existsSync(join(dir, '.decision-center', 'sessions', 'claude-abc.jsonl')), true)
    assert.doesNotMatch(cli('status').stdout, /Not recording/)
    writeFileSync(copy, 'older build')
    assert.match(cli('status').stdout, /Not recording: the hook file at .*hook\.mjs differs from this build\. Run install again\./)
    rmSync(copy)
    assert.match(cli('status').stdout, /Not recording: the hook file is gone from .*hook\.mjs\. Run install again\./)
    assert.equal(cli('install').status, 0)
    assert.doesNotMatch(cli('status').stdout, /Not recording/)
    assert.equal(cli('uninstall').status, 0)
    assert.equal(existsSync(copy), false)
  }))

test('a hook command gives back the paths it was built from', () => {
  assert.deepEqual(parseHookCommand(command('claude')), { node: '/usr/bin/node', hookPath: "/code/it's here/dist/hook.mjs" })
  assert.equal(parseHookCommand('decision-center hook claude'), null)
})
