import { homedir } from 'node:os'
import { join } from 'node:path'

/** Where hook events, flags and failures live: `$DECISION_CENTER_HOME` or `~/.decision-center`. */
export function homeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.DECISION_CENTER_HOME || join(homedir(), '.decision-center')
}

export const sessionsDir = (home: string) => join(home, 'sessions')
