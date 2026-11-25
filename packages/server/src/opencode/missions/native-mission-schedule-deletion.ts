import type { Plugin } from "@opencode/plugin/effect"
import { finishMissionDocumentDeletion } from "../../missions/mission-document-deletion"
import type { NativeMissionDocumentStore } from "../../missions/mission-document-store"
import { deleteDormantMissionJournal } from "../../missions/mission-dormant-journal"
import type { MissionDocument } from "../../missions/mission-document"
import { optionalOrdinaryJournalRange } from "./ordinary-journal-range"
import type { MissionNativeRunner } from "./native-service-adapter"

export function missionDocumentDeletionPending(doc: MissionDocument): boolean {
  if (!doc.deletion) return false
  return doc.deletion.deleteManagedSessions && doc.launchedCount > 0
    || doc.coordinatorReleases.length > 0
    || !!doc.pending
    || doc.blocked === "unknown"
    || !!doc.calendarOwner?.operation.pending
    || !!doc.calendarOwner?.slots.length
    || !!doc.calendarOwner?.retired.length
    || !!doc.calendars.length
}

/** Compact an already-recorded deletion once every calendar, passage, coordinator
 * release and dormant journal is clean, preserving the original deletion identity. */
export async function compactNativeMissionDocumentDeletion(
  ctx: Plugin.Context,
  store: NativeMissionDocumentStore,
  missionID: string,
  run: MissionNativeRunner,
  current: () => true,
  actorPending = false,
): Promise<{ compacted: boolean; managedOrReleasePending: boolean }> {
  const deleting = await store.read(missionID)
  if (!deleting || "deletedAt" in deleting || !deleting.deletion) return { compacted: false, managedOrReleasePending: false }
  const deletion = deleting.deletion
  const managedOrReleasePending = deletion.deleteManagedSessions && deleting.launchedCount > 0 || deleting.coordinatorReleases.length > 0
  if (actorPending || managedOrReleasePending || missionDocumentDeletionPending(deleting))
    return { compacted: false, managedOrReleasePending }
  const range = await run(optionalOrdinaryJournalRange(ctx, run))
  const compacted = await store.withExclusion(async locked => {
    const fresh = await locked.read(missionID)
    if (!fresh || "deletedAt" in fresh || !fresh.deletion || missionDocumentDeletionPending(fresh)) return false
    await deleteDormantMissionJournal(locked, { range, get: key => run(ctx.storage.get(key)), scan: input => run(ctx.storage.scan(input)),
      set: async (key, value, guard) => { current(); guard?.(); await run(ctx.storage.set(key, value)) } }, fresh, current)
    await finishMissionDocumentDeletion(use => use(locked), use => use(locked),
      { missionID, ...fresh.deletion }, Date.now(), current, true)
    return true
  })
  return { compacted, managedOrReleasePending: false }
}
