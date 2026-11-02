import type { MissionDocument } from "./mission-document"
import { projectMissionDocument } from "./mission-document"
import { missionLaunchLimit } from "./launch-policy"

/** Display evidence only. A technical wake is an admitted native prompt, rather
 * than a source verification or a launched business passage. Its scope is the
 * current temporal generation; replacements start new native counters. */
export type MissionScheduleObservation = {
  state: "unarmed" | "known" | "unknown"
  nativeStatus: "active" | "paused" | "done" | "mixed" | null
  nextDueAt: number | null
  wakeCount: number | null
  timeGeneration: number
  kind: "check" | "launch"
}

export function unobservedMissionSchedule(doc: MissionDocument): MissionScheduleObservation {
  return { state: doc.firstPlayedAt === null || !doc.calendars.some(item => item.role === "principal") ? "unarmed" : "unknown",
    nativeStatus: null, nextDueAt: null, wakeCount: null, timeGeneration: doc.timeGeneration, kind: doc.configuration.launch.condition ? "check" : "launch" }
}

/** Candidates from durable state. Every control rechecks its revision, native
 * capabilities, ownership and pending identities at the mutation boundary. */
export function missionScheduleAvailableActions(doc: MissionDocument) {
  const actions: ("play" | "pause" | "resume" | "stop" | "check" | "run-now" | "configure" | "delete")[] = []
  if (doc.oneTime && !doc.dormantJournal || doc.preparation?.pending) return actions
  if (doc.calendarOwner || doc.pending || doc.synchronization) actions.push("check")
  if (doc.deletion) return actions
  actions.push("delete")
  if (doc.state !== "stopped") actions.push("stop")
  if (doc.state === "running" || doc.state === "finished" && doc.pending) actions.push("pause")
  const unresolved = doc.synchronization || doc.calendarOwner?.operation.pending || doc.fanIn && !doc.fanIn.completed
    || doc.calendars.some(item => item.wakePreparing || item.pendingWake && !doc.pending)
    || doc.blocked === "unknown" || doc.scheduleActivation && doc.scheduleActivation.state !== "ready"
  if (!unresolved) {
    if (doc.firstPlayedAt === null && doc.state === "paused" && !doc.blocked && !doc.pending) actions.push("play")
    if (doc.firstPlayedAt !== null && (doc.state === "paused" || doc.state === "running" && doc.blocked || doc.state === "finished" && doc.pending)
      && (!doc.pending || doc.pending.admittedAt !== null)) actions.push("resume")
    const limit = missionLaunchLimit(doc.configuration.launch)
    if (doc.firstPlayedAt !== null && ["paused", "running"].includes(doc.state) && !doc.pending && !doc.blocked
      && (limit === null || doc.launchedCount < limit)) actions.push("run-now")
  }
  const edit = projectMissionDocument(doc).edit
  if (edit.structural || edit.reason === "passage" || edit.reason === "launched-once") actions.push("configure")
  return actions
}
