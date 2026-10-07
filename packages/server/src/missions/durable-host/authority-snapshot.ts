import { z } from "zod"
import { canonicalAuthority, rejectAuthority } from "../authority-protocol"
import { MISSION_MAX_ACTORS, MISSION_MAX_MISSIONS, MISSION_SCHEMA_VERSION, type MissionSnapshot } from "../model"
import { controlOperationID } from "../receipt-identity"

const id = z.string().min(1).max(240)
const revision = z.number().int().nonnegative().safe()
const location = z.object({ directory: z.string().min(1).max(4096) }).strict()
const target = z.object({ sessionID: id, location })
const control = z.object({ id, missionID: id, requestID: id, expectedRevision: revision,
  action: z.enum(["start", "pause", "stop"]), targets: z.array(target).min(1).max(MISSION_MAX_ACTORS),
  pending: z.array(id).max(MISSION_MAX_ACTORS), completedRevision: revision.optional(),
}).refine(value => new Set(value.targets.map(item => item.sessionID)).size === value.targets.length
  && new Set(value.pending).size === value.pending.length
  && value.pending.every(pending => value.targets.some(item => item.sessionID === pending)))
const mission = z.object({ id, projectID: id, projectCanonical: z.string().min(1).max(4096),
  coordinatorSessionId: id, revision: revision.min(1), status: z.enum(["active", "completed", "failed", "stopped"]),
  runState: z.enum(["prepared", "running", "paused", "stopped"]).optional(), controlUnavailable: z.boolean().optional(),
  control: control.optional(),
  actors: z.array(z.object({ sessionId: id, kind: z.enum(["coordinator", "specialist"]), location })).min(1).max(MISSION_MAX_ACTORS),
}).refine(value => new Set(value.actors.map(actor => actor.sessionId)).size === value.actors.length
  && value.actors.filter(actor => actor.kind === "coordinator").length === 1
  && value.actors.some(actor => actor.kind === "coordinator" && actor.sessionId === value.coordinatorSessionId)
  && (!value.control || value.control.missionID === value.id
    && value.control.id === controlOperationID(value.id, value.control.requestID)
    && value.control.targets.every(item => value.actors.some(actor => actor.sessionId === item.sessionID
      && actor.location.directory === item.location.directory))
    && (value.control.completedRevision === undefined || value.control.completedRevision > value.control.expectedRevision
      && value.control.completedRevision <= value.revision)))
const snapshot = z.object({ version: z.literal(MISSION_SCHEMA_VERSION), projectID: id,
  discardedEvents: z.literal(0), controlUnavailable: z.boolean().optional(),
  missions: z.array(mission).max(MISSION_MAX_MISSIONS),
}).refine(value => new Set(value.missions.map(item => item.id)).size === value.missions.length
  && value.missions.every(item => item.projectID === value.projectID))

/** Validate the bounded authorization projection, not all presentation fields.
 * RPC JSON Schema outputs are not locally decoded by the Promise client. Keep
 * the original native result only after its consumed identities/control shape
 * are proven; missing pending evidence is never coerced into an empty array. */
export function readAuthoritySnapshot(input: unknown): MissionSnapshot {
  canonicalAuthority(input, 2 * 1024 * 1024)
  if (!snapshot.safeParse(input).success) rejectAuthority("observation-unavailable")
  return input as MissionSnapshot
}
