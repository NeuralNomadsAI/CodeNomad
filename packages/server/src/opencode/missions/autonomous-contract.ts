import { isDeepStrictEqual } from "node:util"
import { z } from "zod"
import { canonicalAuthority, rejectAuthority, type AuthorityBinding } from "../../missions/authority-protocol"
import { assignmentInput, reportInput } from "../../missions/inputs"
import { missionIsRunning } from "../../missions/lifecycle-model"
import type { MissionSnapshot } from "../../missions/model"
import { missionRecoveryInput } from "../../missions/recovery-input"

const id = z.string().min(1).max(100)
const input = z.object({
  sessionID: z.string().regex(/^ses/).max(240), id: z.string().regex(/^msg_/).max(240),
  text: z.string().min(1).max(250_000), description: z.string().max(240).optional(),
  metadata: z.object({ "codenomad.mission": z.object({
    version: z.literal(1), missionID: id, kind: z.enum(["assignment", "report", "recovery"]),
    taskKey: id.optional(), role: id.optional(), reportID: id.optional(),
    fromSessionID: z.string().max(240).optional(), target: z.enum(["coordinator", "report"]).optional(),
    revision: z.number().int().positive().optional(),
  }).strict() }).strict(), delivery: z.enum(["queue", "steer"]), resume: z.literal(true),
}).strict()
const commandSchema = z.object({ kind: z.enum(["prompt", "synthetic"]), input }).strict()
export type AutonomousMissionCommand = z.infer<typeof commandSchema>

/** Shared business reconstruction for a future native admission AND the ordinary
 * backend route. This is data validation, not a grant or native effect capability.
 * No default publication authority, control action, root creation or replay. */
export function reconstructAutonomousMissionCommand(snapshot: MissionSnapshot, scope: AuthorityBinding, raw: unknown) {
  canonicalAuthority(raw, 512 * 1024)
  const command = commandSchema.parse(raw), metadata = command.input.metadata["codenomad.mission"]
  const mission = snapshot.missions.find(item => item.id === metadata.missionID)
  if (snapshot.discardedEvents || snapshot.controlUnavailable || snapshot.notificationUnavailable
    || snapshot.projectID !== scope.projectID || !mission || mission.id !== scope.missionID
    || mission.projectID !== scope.projectID || mission.projectCanonical !== scope.projectCanonical
    || mission.coordinatorSessionId !== scope.coordinatorSessionID || !missionIsRunning(mission)
    || mission.notificationUnavailable) rejectAuthority("binding-mismatch")
  const task = mission.tasks.find(item => item.key === metadata.taskKey)
  const report = task && (task.report?.id === metadata.reportID ? task.report
    : task.lateReports?.find(item => item.id === metadata.reportID))
  const expected = metadata.kind === "recovery" && command.kind === "synthetic" && metadata.target && metadata.revision
    ? missionRecoveryInput(mission, { missionID: mission.id, expectedRevision: metadata.revision,
      target: metadata.target, ...(metadata.taskKey === undefined ? {} : { taskKey: metadata.taskKey }) })
    : metadata.kind === "assignment" && command.kind === "prompt" && task?.status === "dispatching"
      ? assignmentInput(mission, task)
      : metadata.kind === "report" && command.kind === "synthetic" && report ? reportInput(mission, report) : undefined
  if (!expected || !isDeepStrictEqual(command.input, expected)) rejectAuthority("binding-mismatch")
  return { command, mission: structuredClone(mission), execution: command.kind === "prompt" ? task?.execution : undefined }
}
