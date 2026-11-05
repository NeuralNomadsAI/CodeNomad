import { waitForSettledPrerequisite } from "../lib/trailing-resync"
import { hydrateRestoredWorkspaceState } from "./app-session-workspace-hydration"
import { shouldWaitForSavedSessionList } from "./app-session-restore-readiness"
import { runAbortable } from "./app-session-restore-timeout"
import type { RestorableWorkspaceTabState } from "./client-state-codec"
import { instances, waitForInstanceInitialSessionHydration } from "./instances"

const RESTORE_TIMEOUT_MS = 60_000

/**
 * The embedded single-project page has no client state of its own: its host
 * tab keeps the active session in the page's address. It is selected with the
 * same hydration as a restored local tab, unless the user picked one meanwhile.
 */
export function restoreEmbeddedSession(instanceId: string, folder: string, sessionId: string): Promise<void> {
  const snapshot: RestorableWorkspaceTabState = {
    kind: "workspace", folder, activeSessionId: sessionId,
    drafts: {}, attachments: {}, scrollSnapshots: {}, unseenIdleSince: {}, generationRecovery: {},
  }
  const isCurrent = () => instances().has(instanceId)
  return runAbortable(async (signal) => {
    const unavailable = await hydrateRestoredWorkspaceState(instanceId, snapshot, signal, isCurrent)
    if (!shouldWaitForSavedSessionList(undefined, sessionId, unavailable)) return
    await runAbortable(() => waitForSettledPrerequisite(waitForInstanceInitialSessionHydration(instanceId)), { signal })
    if (isCurrent()) await hydrateRestoredWorkspaceState(instanceId, snapshot, signal, isCurrent)
  }, { timeoutMs: RESTORE_TIMEOUT_MS, message: `Timed out restoring the embedded session ${sessionId}` })
}
