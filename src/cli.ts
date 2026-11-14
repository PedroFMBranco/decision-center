// `decision-center <command>`: the program's entry point.
import { execFile, spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_PORT, type AgentType } from './contract.ts'
import { runHook } from './hook.ts'
import { homeDir, sessionsDir } from './home.ts'
import { applyHooks, hookCommand, hookProblems, installedEvents, placedHookPath, placeHook, removeHook, HOOK_EVENTS, type FileResult, type InstallTarget } from './install.ts'
import { serve } from './main.ts'

const USAGE = `Usage: decision-center <command>

  serve                 Run the feed server in the foreground (the default).
  open                  Open the feed in your browser.
  install [--dry-run] [--claude-settings <path>] [--codex-hooks <path>]
                        Add the hooks to Claude Code and Codex.
  uninstall [--dry-run] [--claude-settings <path>] [--codex-hooks <path>]
                        Remove the hooks again.
  status                Show the home folder, hooks, sessions and tmux.
  hook <claude|codex>   Record one hook call (agents run this).

Environment: DECISION_CENTER_PORT (default ${DEFAULT_PORT}), DECISION_CENTER_HOME (default ~/.decision-center).`

const port = () => Number(process.env.DECISION_CENTER_PORT) || DEFAULT_PORT
const feedUrl = () => `http://127.0.0.1:${port()}/`

function log(message: string): void {
  console.log(`${new Date().toISOString()} ${message}`)
}

const DEFAULT_TARGETS: InstallTarget[] = [
  { agent: 'claude', path: join(homedir(), '.claude', 'settings.json') },
  { agent: 'codex', path: join(homedir(), '.codex', 'hooks.json') }
]

/** With a path flag, only the files named are touched. */
function targetsFrom(args: string[]): { targets: InstallTarget[]; dryRun: boolean; everyFile: boolean } {
  const named: InstallTarget[] = []
  let dryRun = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--dry-run') dryRun = true
    else if (arg === '--claude-settings' || arg === '--codex-hooks') {
      const path = args[++i]
      if (!path) throw new Error(`${arg} needs a path`)
      named.push({ agent: arg === '--claude-settings' ? 'claude' : 'codex', path })
    } else throw new Error(`unknown option ${arg}\n\n${USAGE}`)
  }
  return { targets: named.length ? named : DEFAULT_TARGETS, dryRun, everyFile: !named.length }
}

const AGENT_NAME: Record<AgentType, string> = { claude: 'Claude Code', codex: 'Codex' }

function report(results: FileResult[], targets: InstallTarget[]): void {
  results.forEach((result, i) => {
    const name = AGENT_NAME[targets[i]!.agent]
    const what = result.changes.map((change) => `${change.action} ${change.event}`).join(', ')
    const line = {
      unchanged: `${name}: ${result.path} is already up to date.`,
      changed: `${name}: updated ${result.path} (${what}). Backup: ${result.backup ?? 'none, the file is new'}.`,
      'would-change': `${name}: would update ${result.path} (${what}).`,
      'no-folder': `${name}: skipped, ${result.path} has no folder (is ${name} installed?).`
    }[result.status]
    console.log(line)
  })
}

const BUILT_HOOK = fileURLToPath(new URL('./hook.mjs', import.meta.url))

async function hooks(args: string[], install: boolean): Promise<void> {
  const { targets, dryRun, everyFile } = targetsFrom(args)
  if (install && !existsSync(BUILT_HOOK)) {
    throw new Error(`${BUILT_HOOK} is missing. Run npm run build first.`)
  }
  const home = homeDir()
  const hookPath = install && !dryRun ? await placeHook(BUILT_HOOK, home) : placedHookPath(home)
  const command = install ? (agent: AgentType) => hookCommand(process.execPath, hookPath, agent) : null
  const results = await applyHooks(targets, command, { dryRun })
  report(results, targets)
  if (!install && !dryRun && everyFile) {
    await removeHook(home)
  }
  if (install && !dryRun && results.some((result) => result.status === 'changed' && targets[results.indexOf(result)]!.agent === 'codex')) {
    console.log('Codex asks you to trust new or changed hooks the next time it starts. Untrusted hooks do not run.')
  }
}

async function status(): Promise<void> {
  const home = homeDir()
  const dir = sessionsDir(home)
  const files = existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.jsonl')) : []
  console.log(`Home: ${home}${existsSync(home) ? '' : ' (not created yet)'}`)
  console.log(`Sessions seen: ${files.length} (${files.filter((f) => f.startsWith('claude-')).length} Claude, ${files.filter((f) => f.startsWith('codex-')).length} Codex)`)
  for (const { agent, path } of DEFAULT_TARGETS) {
    const text = existsSync(path) ? readFileSync(path, 'utf8') : null
    const events = installedEvents(text)
    const missing = HOOK_EVENTS[agent].filter((event) => !events.includes(event))
    console.log(`${AGENT_NAME[agent]} hooks: ${!events.length ? 'not installed' : missing.length ? `partly installed, missing ${missing.join(', ')}` : 'installed'} (${path})`)
    for (const problem of hookProblems(text, BUILT_HOOK)) {
      console.log(`  Not recording: ${problem}. Run install again.`)
    }
  }
  const tmux = spawnSync('tmux', ['-V'], { encoding: 'utf8' })
  console.log(`tmux: ${tmux.status === 0 ? tmux.stdout.trim() : 'not found'}`)
  const health = await fetch(`${feedUrl()}api/health`).then((res) => res.ok).catch(() => false)
  console.log(`Server: ${health ? `running at ${feedUrl()}` : `not running on port ${port()}`}`)
}

function openFeed(): void {
  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open'
  execFile(opener, [feedUrl()], (error) => {
    if (error) {
      console.error(`Couldn't open a browser: ${error.message}. Open ${feedUrl()} yourself.`)
      process.exitCode = 1
    }
  })
}

async function main(): Promise<void> {
  const [command = 'serve', ...args] = process.argv.slice(2)
  switch (command) {
    case 'serve': {
      const server = await serve({ port: port(), home: homeDir(), log })
      log(`serving ${server.url} from ${homeDir()}`)
      return
    }
    case 'open':
      return openFeed()
    case 'hook':
      return runHook(args[0])
    case 'install':
      return hooks(args, true)
    case 'uninstall':
      return hooks(args, false)
    case 'status':
      return status()
    case 'help':
    case '--help':
    case '-h':
      console.log(USAGE)
      return
    default:
      throw new Error(`unknown command ${command}\n\n${USAGE}`)
  }
}

main().catch((error: Error) => {
  console.error(error.message)
  process.exit(1)
})
