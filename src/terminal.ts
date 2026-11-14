/** A terminal backend refused or failed a call. `code` other than `cli_failed` means the pane said no. */
export class TerminalError extends Error {
  readonly code: string

  constructor(message: string, code: string) {
    super(message)
    this.code = code
  }
}

export interface TerminalScreen {
  /** The rendered frame, top to bottom. */
  lines: string[]
  /** Text typed into the agent's composer but not sent, if any. */
  draft: string | null
}
