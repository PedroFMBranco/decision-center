import type { PsAgent, PsWorktree } from '../src/cli.ts'

export function agent(overrides: Partial<PsAgent>): PsAgent {
  return {
    paneKey: 'tab:leaf',
    parentPaneKey: null,
    state: 'done',
    agentType: 'claude',
    prompt: 'fix the login bug\nmore detail',
    taskTitle: null,
    displayName: null,
    lastAssistantMessage: 'Fixed.',
    stateStartedAt: 1000,
    updatedAt: 1000,
    ...overrides
  }
}

export function worktree(agents: PsAgent[]): PsWorktree {
  return { worktreeId: 'repo::/code/app', path: '/code/app', displayName: null, isActive: false, agents }
}
