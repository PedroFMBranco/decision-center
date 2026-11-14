// Merges Decision Center's hook entries into an agent's hook config file.
// Every other entry stays in place and in order.
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { copyFile, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { AgentType } from './contract.ts'

export const HOOK_EVENTS: Record<AgentType, string[]> = {
  claude: ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'StopFailure', 'SessionEnd'],
  codex: ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'Stop']
}
const TIMEOUT_S = 10
const MARKER = '# decision-center hook'

const quote = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`

/**
 * One simple command, so the shell execs node and the hook's parent is the
 * agent. The trailing comment marks it as ours wherever the folder lives.
 */
export function hookCommand(node: string, hookPath: string, agent: AgentType): string {
  return `${quote(node)} ${quote(hookPath)} ${agent} ${MARKER}`
}

/** The node and hook paths in one of our commands, or null when it has another shape. */
export function parseHookCommand(command: string): { node: string; hookPath: string } | null {
  const match = /^'((?:[^']|'\\'')*)' '((?:[^']|'\\'')*)' /.exec(command)
  const plain = (text: string) => text.replace(/'\\''/g, "'")
  return match ? { node: plain(match[1]!), hookPath: plain(match[2]!) } : null
}

const HOOK_FILE = 'hook.mjs'

/**
 * Copies the built hook into the home folder and returns the copy's path.
 * Why a copy: the agents' config then names a path that outlives the checkout.
 */
export async function placeHook(builtHook: string, home: string): Promise<string> {
  const target = join(home, HOOK_FILE)
  const built = await readFile(builtHook)
  const current = await readFile(target).catch(() => null)
  if (!current?.equals(built)) {
    await mkdir(home, { recursive: true, mode: 0o700 })
    const temp = join(home, `.${HOOK_FILE}.${randomBytes(6).toString('hex')}.tmp`)
    await writeFile(temp, built, { mode: 0o644 })
    await rename(temp, target)
  }
  return target
}

export async function removeHook(home: string): Promise<void> {
  await rm(join(home, HOOK_FILE), { force: true })
}

export function placedHookPath(home: string): string {
  return join(home, HOOK_FILE)
}

export function isOurs(hook: unknown): boolean {
  const command = (hook as { command?: unknown } | null)?.command
  return typeof command === 'string' && command.includes('decision-center') && command.includes(' hook')
}

type Json = Record<string, unknown>
interface Group {
  hooks?: unknown[]
}

export type HookChange = { event: string; action: 'add' | 'update' | 'remove' }

/** Puts our entry in each of `events` and takes it out of every other event. Pure. */
export function mergeHooks(config: unknown, events: string[], entry: Json | null): { config: Json; changes: HookChange[] } {
  const next: Json = structuredClone(config && typeof config === 'object' && !Array.isArray(config) ? (config as Json) : {})
  const hooks: Record<string, unknown> =
    next.hooks && typeof next.hooks === 'object' && !Array.isArray(next.hooks) ? (next.hooks as Record<string, unknown>) : {}
  const changes: HookChange[] = []
  for (const event of new Set([...Object.keys(hooks), ...(entry ? events : [])])) {
    const groups: Group[] = Array.isArray(hooks[event]) ? (hooks[event] as Group[]) : []
    const want = entry && events.includes(event) ? entry : null
    let placed = false
    let removed = false
    let updated = false
    const kept = groups.flatMap((group) => {
      if (!Array.isArray(group?.hooks) || !group.hooks.some(isOurs)) {
        return [group]
      }
      const own = group.hooks.flatMap((hook) => {
        if (!isOurs(hook)) return [hook]
        if (want && !placed) {
          placed = true
          updated ||= JSON.stringify(hook) !== JSON.stringify(want)
          return [want]
        }
        removed = true
        return []
      })
      return own.length ? [{ ...group, hooks: own }] : []
    })
    let action: HookChange['action'] | null = null
    if (want && !placed) {
      kept.push({ hooks: [want] })
      action = 'add'
    } else if (want && (updated || removed)) {
      action = 'update'
    } else if (!want && removed) {
      action = 'remove'
    }
    if (!action) {
      continue
    }
    changes.push({ event, action })
    if (kept.length) {
      hooks[event] = kept
    } else {
      delete hooks[event]
    }
  }
  if (changes.length) {
    next.hooks = hooks
  }
  return { config: next, changes }
}

export function hookEntry(command: string): Json {
  return { type: 'command', command, timeout: TIMEOUT_S }
}

export interface FileResult {
  path: string
  status: 'unchanged' | 'changed' | 'would-change' | 'no-folder'
  changes: HookChange[]
  backup?: string
}

/** Applies a change to one JSON config file: backup first, then a temp file and a rename. */
export async function updateConfigFile(
  path: string,
  change: (config: unknown) => { config: Json; changes: HookChange[] },
  options: { dryRun: boolean; now?: Date }
): Promise<FileResult> {
  // Why realpath: a dotfiles symlink keeps pointing at the file we update.
  const target = await realpath(path).catch(() => path)
  const folder = await stat(dirname(target)).catch(() => null)
  if (!folder?.isDirectory()) {
    return { path, status: 'no-folder', changes: [] }
  }
  const text = await readFile(target, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  let parsed: unknown = {}
  if (text !== null && text.trim()) {
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      throw new Error(`${path} is not valid JSON, so it was left alone: ${(error as Error).message}`)
    }
  }
  const { config, changes } = change(parsed)
  if (!changes.length) {
    return { path, status: 'unchanged', changes }
  }
  if (options.dryRun) {
    return { path, status: 'would-change', changes }
  }
  const indent = text ? (/^([ \t]+)"/m.exec(text)?.[1] ?? '  ') : '  '
  const out = `${JSON.stringify(config, null, indent)}${text === null || text.endsWith('\n') ? '\n' : ''}`
  let backup: string | undefined
  let mode = 0o600
  if (text !== null) {
    const stamp = (options.now ?? new Date()).toISOString().replace(/[:.]/g, '-')
    backup = join(dirname(target), `${basename(target)}.decision-center-backup-${stamp}`)
    await copyFile(target, backup)
    mode = (await stat(target)).mode & 0o777
  }
  const temp = join(dirname(target), `.${basename(target)}.${randomBytes(6).toString('hex')}.tmp`)
  await writeFile(temp, out, { mode })
  await rename(temp, target)
  return { path, status: 'changed', changes, ...(backup ? { backup } : {}) }
}

export interface InstallTarget {
  agent: AgentType
  path: string
}

/** Installs (or with `command: null`, removes) our hook entries in each target file. */
export async function applyHooks(
  targets: InstallTarget[],
  command: ((agent: AgentType) => string) | null,
  options: { dryRun: boolean; now?: Date }
): Promise<FileResult[]> {
  const results: FileResult[] = []
  for (const { agent, path } of targets) {
    const entry = command ? hookEntry(command(agent)) : null
    results.push(await updateConfigFile(path, (config) => mergeHooks(config, HOOK_EVENTS[agent], entry), options))
  }
  return results
}

/** Which of `events` hold our entry in a config file's text. */
export function installedEvents(text: string | null): string[] {
  try {
    const hooks = (JSON.parse(text ?? '') as { hooks?: Record<string, Group[]> }).hooks ?? {}
    return Object.entries(hooks)
      .filter(([, groups]) => Array.isArray(groups) && groups.some((group) => Array.isArray(group?.hooks) && group.hooks.some(isOurs)))
      .map(([event]) => event)
  } catch {
    return []
  }
}

/** What stops the installed hook commands in a config file's text from recording. */
export function hookProblems(text: string | null, builtHook: string): string[] {
  let hooks: Record<string, Group[]> = {}
  try {
    hooks = (JSON.parse(text ?? '') as { hooks?: Record<string, Group[]> }).hooks ?? {}
  } catch {
    return []
  }
  const commands = new Set<string>()
  for (const groups of Object.values(hooks)) {
    for (const group of Array.isArray(groups) ? groups : []) {
      for (const hook of Array.isArray(group?.hooks) ? group.hooks : []) {
        if (isOurs(hook)) commands.add((hook as { command: string }).command)
      }
    }
  }
  const built = existsSync(builtHook) ? readFileSync(builtHook) : null
  const problems = new Set<string>()
  for (const command of commands) {
    const parsed = parseHookCommand(command)
    if (!parsed) {
      problems.add('the hook command has an unknown shape')
      continue
    }
    if (!existsSync(parsed.node)) problems.add(`node is gone from ${parsed.node}`)
    if (!existsSync(parsed.hookPath)) problems.add(`the hook file is gone from ${parsed.hookPath}`)
    else if (built && !readFileSync(parsed.hookPath).equals(built)) problems.add(`the hook file at ${parsed.hookPath} differs from this build`)
  }
  return [...problems]
}
