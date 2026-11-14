import type { FeedQuestion } from '../src/contract.ts'
import type { Ask, Session } from '../src/session.ts'

export function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 'claude:s1',
    agent: 'claude',
    cwd: '/code/app',
    transcriptPath: null,
    pane: { socket: '/tmp/tmux-501/default', id: '%1' },
    pid: 10,
    startedAt: 0,
    turn: 'done',
    turnSince: 1000,
    pending: null,
    prompt: 'fix the login bug\nmore detail',
    lastMessage: 'Fixed.',
    ended: false,
    updatedAt: 1000,
    ...overrides
  }
}

export function permissionAsk(summary: string, at: number, actor: string | null = null): Ask {
  return { kind: 'permission', permission: { toolName: 'Bash', summary }, key: `k-${summary}`, actor, at }
}

export function questionAsk(question: FeedQuestion, at: number): Ask {
  return { kind: 'question', question, key: 'k-q', actor: null, at }
}
