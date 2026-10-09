// Wire contract shared by a local window, its native host and the Preferences
// window. Commands are a closed set; the host forwards them only to the exact
// local window that opened Preferences.
export const STARTUP_STATE_COMMANDS = ["read", "enable-restore", "disable-restore", "clear"] as const
export type StartupStateCommand = typeof STARTUP_STATE_COMMANDS[number]

export interface StartupStateSnapshot {
  isPrimary: boolean
  restoreEnabled: boolean
}

/** `state` is null when the opener is closed, ephemeral or not yet reachable. */
export interface OpenerStartupStateResult {
  epoch: number
  state: StartupStateSnapshot | null
  applied: boolean
}

export const isStartupStateCommand = (value: unknown): value is StartupStateCommand =>
  typeof value === "string" && (STARTUP_STATE_COMMANDS as readonly string[]).includes(value)

export function normalizeStartupStateSnapshot(value: unknown): StartupStateSnapshot | null {
  if (!value || typeof value !== "object") return null
  const candidate = value as Record<string, unknown>
  if (typeof candidate.isPrimary !== "boolean" || typeof candidate.restoreEnabled !== "boolean") return null
  return { isPrimary: candidate.isPrimary, restoreEnabled: candidate.restoreEnabled }
}

export function normalizeOpenerStartupStateResult(value: unknown): OpenerStartupStateResult | null {
  if (!value || typeof value !== "object") return null
  const candidate = value as Record<string, unknown>
  if (!Number.isSafeInteger(candidate.epoch) || typeof candidate.applied !== "boolean") return null
  const state = candidate.state === null ? null : normalizeStartupStateSnapshot(candidate.state)
  if (candidate.state !== null && state === null) return null
  return { epoch: candidate.epoch as number, state, applied: candidate.applied }
}
