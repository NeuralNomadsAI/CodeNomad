import { withTimeout, type RendererFlushWindow } from "./renderer-client-state-flush"
import type { PreferencesOpener } from "./preferences-window"

export const OPENER_STARTUP_STATE_TIMEOUT_MS = 10_000
const STARTUP_STATE_COMMAND_CALLBACK = "__CODENOMAD_STARTUP_STATE_COMMAND__"
const COMMANDS = ["read", "enable-restore", "disable-restore", "clear"] as const

export type StartupStateCommand = typeof COMMANDS[number]
export interface StartupStateSnapshot { isPrimary: boolean; restoreEnabled: boolean }
export interface OpenerStartupStateResult { epoch: number; state: StartupStateSnapshot | null; applied: boolean }

export function requireStartupStateCommand(value: unknown): StartupStateCommand {
  if (typeof value !== "string" || !(COMMANDS as readonly string[]).includes(value)) throw new Error("Invalid startup state command")
  return value as StartupStateCommand
}

export function requireOpenerEpoch(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error("Invalid startup state opener epoch")
  return value as number
}

function normalizeSnapshot(value: unknown): StartupStateSnapshot {
  const candidate = value as Record<string, unknown> | null
  if (!candidate || typeof candidate.isPrimary !== "boolean" || typeof candidate.restoreEnabled !== "boolean") {
    throw new Error("Invalid startup state returned by the opener window")
  }
  return { isPrimary: candidate.isPrimary, restoreEnabled: candidate.restoreEnabled }
}

/** Runs one fixed command in the exact local renderer through its own client-state store. */
export async function runStartupStateCommandInWindow(
  window: RendererFlushWindow | undefined,
  command: StartupStateCommand,
  isTrustedOrigin: (url: string) => boolean,
  timeoutMs = OPENER_STARTUP_STATE_TIMEOUT_MS,
): Promise<StartupStateSnapshot | null> {
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return null
  const currentUrl = window.webContents.getURL()
  if (!isTrustedOrigin(currentUrl)) return null
  const callbackName = JSON.stringify(STARTUP_STATE_COMMAND_CALLBACK)
  const expectedOrigin = JSON.stringify(new URL(currentUrl).origin)
  const value = await withTimeout(
    window.webContents.executeJavaScript(`(() => {
      if (window.location.origin !== ${expectedOrigin}) throw new Error("Renderer origin changed before startup state command");
      const run = window[${callbackName}];
      if (typeof run !== "function") return null;
      return run(${JSON.stringify(command)});
    })()`),
    timeoutMs,
    "Opener startup state command",
  )
  return value === null ? null : normalizeSnapshot(value)
}

/**
 * Resolves the Preferences opener on the host and forwards the command only to
 * that local window. A mutation fenced by a stale epoch degrades to a read of
 * the current opener and is reported as not applied.
 */
export async function forwardOpenerStartupState(
  opener: PreferencesOpener,
  command: StartupStateCommand,
  expectedEpoch: number | undefined,
  run: (openerId: string, command: StartupStateCommand) => Promise<StartupStateSnapshot | null>,
): Promise<OpenerStartupStateResult> {
  const fenced = command !== "read" && expectedEpoch !== opener.epoch
  const effective = fenced ? "read" : command
  const state = opener.id ? await run(opener.id, effective) : null
  return { epoch: opener.epoch, state, applied: effective !== "read" && state !== null }
}
