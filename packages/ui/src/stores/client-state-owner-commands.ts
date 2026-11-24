import {
  clearRestoredClientState, clientStateIsPrimary, initializeClientState,
  restorePreviousStateEnabled, setRestorePreviousStateEnabled,
} from "./client-state"
import type { StartupStateCommand, StartupStateSnapshot } from "../lib/native/startup-state-command"

/**
 * Runs a Preferences-originated startup-state command inside the owning local
 * window, through the same store transitions as its inline settings card.
 */
export async function runStartupStateCommand(command: StartupStateCommand): Promise<StartupStateSnapshot> {
  await initializeClientState()
  if (command === "enable-restore" || command === "disable-restore") {
    await setRestorePreviousStateEnabled(command === "enable-restore")
  } else if (command === "clear") {
    await clearRestoredClientState()
  }
  return { isPrimary: clientStateIsPrimary(), restoreEnabled: restorePreviousStateEnabled() }
}
