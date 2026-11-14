import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

// A bare PATH (a login item, a launcher) may miss it: look where the installers put it.
function resolveClaudeBin(): string {
  const candidates = [
    join(homedir(), '.local', 'bin', 'claude'),
    join(homedir(), '.claude', 'local', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude'
  ]
  return candidates.find((path) => existsSync(path)) ?? 'claude'
}

/**
 * Runs `claude -p` with `input` on stdin and returns its answer. Why the
 * flags: no settings (so no hooks, which would log a fake session), no MCP
 * servers, no tools and no saved session. Auth still comes from your login.
 */
export function claudePrint(input: string, options: { model: string; systemPrompt: string; timeoutMs?: number }): Promise<string> {
  const env = { ...process.env }
  // Why: set when the server itself runs under Claude Code; claude refuses to nest.
  delete env.CLAUDECODE
  const args = [
    '-p',
    '--model', options.model,
    '--effort', 'low',
    '--setting-sources', '',
    '--strict-mcp-config',
    '--tools', '',
    '--no-session-persistence',
    '--disable-slash-commands',
    '--system-prompt', options.systemPrompt
  ]
  return new Promise((resolve, reject) => {
    const child = execFile(
      resolveClaudeBin(),
      args,
      // Why tmpdir: keeps a project's CLAUDE.md out of the prompt.
      { env, cwd: tmpdir(), timeout: options.timeoutMs ?? 60_000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const detail = (stderr || stdout).trim().split('\n').pop() || error.message
          reject(new Error(`claude -p failed: ${detail}`))
          return
        }
        resolve(stdout)
      }
    )
    child.stdin?.end(input)
  })
}
