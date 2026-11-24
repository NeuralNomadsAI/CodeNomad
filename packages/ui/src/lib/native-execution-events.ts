const EXECUTION_TERMINAL_EVENT_TYPES = new Set([
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
])

/**
 * OpenCode V2 settles every busy period of a session with exactly one of these
 * events. It never publishes the deprecated session.idle/session.status.
 */
export function isExecutionTerminalEvent(event: { type: string }): boolean {
  return EXECUTION_TERMINAL_EVENT_TYPES.has(event.type)
}
