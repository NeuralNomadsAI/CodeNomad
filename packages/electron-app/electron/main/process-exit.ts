export interface ManagedProcessExit {
  state: "error" | "stopped"
  error?: string
}

export function shouldReportManagedProcessError(requestedStop: boolean, currentGeneration: boolean): boolean {
  return currentGeneration && !requestedStop
}

export function resolveManagedProcessExit(
  currentError: string | undefined,
  code: number | null,
  signal: NodeJS.Signals | null,
  requestedStop: boolean,
  currentGeneration: boolean,
): ManagedProcessExit | null {
  if (!currentGeneration) return null
  if (requestedStop) return { state: "stopped" }
  const details = [code === null ? null : `code ${code}`, signal ? `signal ${signal}` : null].filter(Boolean).join(", ")
  return { state: "error", error: currentError ?? `CLI exited unexpectedly (${details || "unknown status"})` }
}
