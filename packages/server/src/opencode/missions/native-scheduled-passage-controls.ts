import { MissionControlError } from "../../missions/control-error"
import { controlOperationID } from "../../missions/receipt-identity"
import { nativeScheduledPassageBusiness, type NativeScheduledPassageContext } from "./native-scheduled-passage-business"

export type ScheduledPassageControl = { requestID: string; action: "start" | "pause" | "stop" }

/** Dedicated human control path. Desired document state is already committed;
 * journal intent and exact actor receipts use the existing lifecycle machinery. */
export async function controlNativeScheduledPassage(input: NativeScheduledPassageContext, control: ScheduledPassageControl): Promise<{ pending: boolean }> {
  const doc = input.document, pending = doc.pending
  input.locked.assertActive(); input.current()
  if (!pending) return { pending: false }
  if (control.action === "pause" && doc.state !== "paused" || control.action === "stop" && doc.state !== "stopped"
    || control.action === "start" && (doc.deletion || doc.blocked || !["running", "finished"].includes(doc.state)))
    throw new Error("Document passage control phase differs")
  const scoped = nativeScheduledPassageBusiness(input), snapshot = await scoped.control.snapshot()
  if (snapshot.discardedEvents || snapshot.controlUnavailable || snapshot.notificationUnavailable || snapshot.missions.length > 1)
    return { pending: true }
  const mission = snapshot.missions[0]
  if (!mission) {
    if (pending.admittedAt !== null) return { pending: true }
    // Positive root/family absence, never inferred from an absent journal alone.
    if (await input.observation.exists(pending.coordinatorSessionID)
      || (await input.observation.children(pending.coordinatorSessionID)).length
      || await input.observation.requests([pending.coordinatorSessionID])) return { pending: true }
    input.current(); input.locked.assertActive()
    return { pending: false }
  }
  if (mission.id !== pending.missionID || mission.coordinatorSessionId !== pending.coordinatorSessionID) return { pending: true }
  // Initial admission always retains its reserved original message identity.
  if (control.action === "start" && pending.admittedAt === null) return { pending: true }
  const previous = await scoped.journal.event(mission.id, controlOperationID(mission.id, control.requestID))
  if (previous && (previous.type !== "mission.control-requested" || previous.requestID !== control.requestID || previous.action !== control.action))
    throw new Error("Document passage control request differs")
  const expectedRevision = previous?.type === "mission.control-requested" ? previous.expectedRevision : mission.revision
  try {
    const result = await scoped.control.lifecycle({ missionID: mission.id, expectedRevision,
      requestID: control.requestID, action: control.action })
    return { pending: !!result.mission.control?.pending.length }
  } catch (error) {
    if (error instanceof MissionControlError && ["control-pending", "mission-finished"].includes(error.code)) return { pending: true }
    throw error
  }
}
