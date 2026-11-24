/** Whether CodeNomad's own window automation is acting right now (server `automation/page`):
 * page functions run under a depth counter and trusted DevTools input under a short lease, so
 * neither ever counts as a person's input. */
export function automationInputActive(eventTime = performance.now()): boolean {
  const scope = globalThis as typeof globalThis & { __codenomadAutomationDepth?: number; __codenomadAutomationInputUntil?: number }
  return Boolean(scope.__codenomadAutomationDepth) || eventTime <= (scope.__codenomadAutomationInputUntil ?? -1)
}
