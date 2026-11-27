import { sameLocation } from "../../opencode/compatibility/location"
import type { ServiceConnection } from "../../workspaces/opencode-service"

/** Persistent ownership the permit was admitted under: the backend's workspace
 * object, the native project whose plugin storage holds the schedule, and the
 * physical checkout entered in the deletion fence. A replacement connection may
 * only settle the original permit after a fresh read proves all of them again. */
export interface RecurrenceHoldOwner { workspace: object; projectID: string; projectCanonical: string; checkout: string }

/** Fresh owner read through the current connection; the caller has already
 * revalidated directory ownership and keeps its workspace/connection fences. */
export async function readRecurrenceHoldOwner(manager: { getWorktreeIdentityForPath(id: string, directory: string): Promise<string | undefined> },
  workspaceID: string, workspace: object, directory: string, client: ServiceConnection["client"], signal: AbortSignal): Promise<RecurrenceHoldOwner | undefined> {
  const info = await client.location.get({ location: { directory } }, { signal })
  const checkout = await manager.getWorktreeIdentityForPath(workspaceID, directory)
  if (!checkout || !sameLocation(info, { directory }) || typeof info.project?.id !== "string" || typeof info.project.canonical !== "string") return undefined
  return { workspace, projectID: info.project.id, projectCanonical: info.project.canonical, checkout }
}
