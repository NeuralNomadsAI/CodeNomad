import { z } from "zod"
import { MissionControlError } from "./control-error"
import type { MissionDocumentAccess } from "./mission-document-one-time"
import type { MissionLifecycleInput } from "./lifecycle-model"
import type { MissionMap } from "./model"
import { automaticMissionStartID } from "./preparation-result"

export const automaticStartSchema = z.object({
  creationRequestID: z.string().min(1).max(128),
  authorSessionID: z.string().min(1).max(240),
  expectedDocumentRevision: z.number().int().nonnegative(),
}).strict()
export type AutomaticStart = z.infer<typeof automaticStartSchema>
export const automaticStartWire = { type: "object", properties: {
  creationRequestID: { type: "string", minLength: 1, maxLength: 128 },
  authorSessionID: { type: "string", minLength: 1, maxLength: 240 },
  expectedDocumentRevision: { type: "integer", minimum: 0 },
}, required: ["creationRequestID", "authorSessionID", "expectedDocumentRevision"], additionalProperties: false } as const

/** A single monotone slot, consumed durably before first-Play intent or effects.
 * A lost consumption acknowledgement can only be observed, never reacquired. */
export async function consumeAutomaticStart(access: MissionDocumentAccess | undefined, mission: MissionMap,
  input: MissionLifecycleInput, automatic: AutomaticStart, author: { directory: string; sourceMissionID?: string }, current: () => true) {
  if (!access) throw new MissionControlError("Automatic Mission start unavailable", "prepare-refused")
  await access(async store => {
    const doc = await store.read(mission.id)
    const refuse = (): never => { throw new MissionControlError("Original automatic start is unavailable", "control-conflict") }
    if (!doc || "deletedAt" in doc || !doc.oneTime) return refuse()
    const creation = doc.creation, start = creation?.automaticStart
    if (input.action !== "start" || input.recurrence || input.expectedRevision !== mission.revision
      || mission.runState !== "prepared" || doc.revision !== automatic.expectedDocumentRevision
      || doc.state !== "paused" || doc.firstPlayedAt !== null || doc.preparation?.pending || doc.dormantJournal
      || creation?.requestID !== automatic.creationRequestID || creation.author?.coordinatorSessionID !== automatic.authorSessionID
      || creation.author.missionID !== author.sourceMissionID || doc.oneTime.location.directory !== author.directory
      || creation.input?.startOnCreation !== true || !start || start.attempted
      || input.requestID !== start.requestID || start.requestID !== automaticMissionStartID(creation.requestID)) return refuse()
    await store.change(doc.id, doc.revision, current, next => { next.creation!.automaticStart!.attempted = true })
  })
}
