import type { UnifiedMissionSchedule } from "./mission-schedules"

type Schedule = Pick<UnifiedMissionSchedule, "id" | "kind" | "state" | "revision" | "configuration" | "pendingPassage" | "control" | "blockReason">

/** A schedule a programmed Mission can take over now: running or paused, with no passage, control or block under way. */
export const convertibleMissionSchedule = (doc: Schedule) => doc.kind === "schedule" && (doc.state === "running" || doc.state === "paused")
  && !doc.pendingPassage && !doc.control?.pending && !doc.blockReason

/** Moves one schedule to a programmed Mission of the same identity: saved paused, the schedule
 * deleted, then resumed if the schedule ran. A step that fails stops there: until its deletion the
 * schedule stays in charge and the programmed Mission paused, so the two never launch together.
 * `save` refuses launch criteria a programmed Mission cannot carry: that schedule is kept. */
export async function convertMissionSchedule(doc: Schedule, steps: {
  save(calendar: string, configuration: unknown): Promise<void>; remove(doc: Schedule): Promise<void>; resume(calendar: string): Promise<void>
}): Promise<void> {
  const { roots: _roots, profileID: _profile, executionHost: _host, coordinatorSelectionAuthor: _author, ...configuration } = doc.configuration
  await steps.save(doc.id, configuration)
  await steps.remove(doc)
  if (doc.state === "running") await steps.resume(doc.id).catch(() => steps.resume(doc.id))
}
