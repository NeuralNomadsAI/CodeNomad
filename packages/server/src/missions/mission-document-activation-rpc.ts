import { z } from "zod"
import { documentCounter, documentID } from "./launch-policy"
import { missionScheduleActivationSchema } from "./mission-document"
import { missionDocumentSummary } from "./mission-document-one-time"
import type { NativeMissionDocumentStore } from "./mission-document-store"
import { acknowledgeMissionScheduleActivation, attemptingMissionScheduleActivation, failMissionScheduleActivation,
  prepareMissionScheduleActivation, readyMissionScheduleActivation } from "./mission-document-activation"

const common = { missionID: documentID, requestID: z.string().min(1).max(128), expectedRevision: documentCounter }
const target = { scope: z.enum(["global", "project"]), resultDigest: z.string().regex(/^[a-f0-9]{64}$/) }
export const missionDocumentActivationRequest = z.discriminatedUnion("action", [
  z.object({ ...common, action: z.literal("read") }).strict(),
  z.object({ ...common, action: z.literal("prepare"), authority: z.string().regex(/^[a-f0-9]{64}$/),
    targets: missionScheduleActivationSchema.innerType().shape.targets }).strict(),
  z.object({ ...common, ...target, action: z.literal("attempting") }).strict(),
  z.object({ ...common, ...target, action: z.literal("acknowledged") }).strict(),
  z.object({ ...common, action: z.literal("ready"), effectiveOrigin: z.string().min(1).max(4096).nullable() }).strict(),
  z.object({ ...common, action: z.literal("failed"), errorCode: z.string().regex(/^[a-z0-9-]{1,80}$/) }).strict(),
])

/** Storage-only RPC for the authenticated settings executor. Every phase carries
 * the original expected revision; subsequent CASes use a fresh document revision.
 * Read/ready keep the mission paused. Native calendar arming is a separate owner. */
export async function applyMissionDocumentActivation(store: NativeMissionDocumentStore, raw: unknown, current: () => true, directory: string) {
  current()
  const input = missionDocumentActivationRequest.parse(raw), doc = await store.read(input.missionID)
  if (!doc || "deletedAt" in doc) throw new Error("Mission document unavailable")
  current()
  if (!doc.configuration.roots.some(root => root.directory === directory)) throw new Error("Mission activation Location differs")
  if (input.action === "read") return { document: missionDocumentSummary(doc) }
  const prior = doc.scheduleActivation
  if (input.action !== "prepare" && (!prior || prior.requestID !== input.requestID || prior.expectedRevision !== input.expectedRevision))
    throw new Error("Mission activation original request conflict")
  const result = await store.change(doc.id, doc.revision, current, next => {
    if (input.action === "prepare") prepareMissionScheduleActivation(next, { requestID: input.requestID,
      expectedRevision: input.expectedRevision, authority: input.authority, targets: input.targets, state: "prepared" })
    else if (input.action === "attempting") {
      const target = next.scheduleActivation!.targets.find(target => target.scope === input.scope)
      if (target?.attempted && target.resultDigest === input.resultDigest) return // Readback only; executor retains the attempted barrier.
      attemptingMissionScheduleActivation(next, input.requestID, input.scope, input.resultDigest)
    } else if (input.action === "acknowledged") acknowledgeMissionScheduleActivation(next, input.requestID, input.scope, input.resultDigest)
    else if (input.action === "ready") readyMissionScheduleActivation(next, input.requestID, input.effectiveOrigin)
    else failMissionScheduleActivation(next, input.requestID, input.errorCode)
  })
  return { document: missionDocumentSummary(result) }
}
