/** One visual state per Mission or schedule, on the session palette: colour shows
 * only what needs attention now. Red asks for an answer, yellow works, orange is
 * stopped (interrupted, or paused) with an action to continue, green finished
 * since last seen, blue is prepared and ready to start like a composed prompt;
 * anything else is idle. Outcomes themselves are status text. */
export type MissionMark = "permission" | "interrupted" | "working" | "paused" | "done" | "prepared" | "idle"

export interface MissionPickerEntry {
  /** `mission:<id>` or `schedule:<id>`. */
  key: string
  title: string
  /** Full localized state for tooltips and screen readers. */
  status: string
  mark: MissionMark
  /** The most urgent state of a Mission's tasks, carried by its chevron like a
   * session's children: a task asks for an answer, or works. */
  childActivity?: "permission" | "working"
}

/** A one-time Mission's own state from native requests and observed actor activity:
 * red only for the questions its flag carries (`openRequests`, each one it can
 * open); observed actor states, the coordinator's included, cover whole families
 * and never redden it. Its tasks' questions belong to its chevron.
 * A failed mission can be resumed unless the user stopped it since, so it reads
 * as interrupted; a completed one is green until seen. */
export function missionMark(mission: { status: string; runState?: string }, input: {
  openRequests: number; actorStates?: readonly string[]; coordinatorState?: string; seen: boolean
}): MissionMark {
  const states = input.actorStates ?? []
  if (input.openRequests > 0) return "permission"
  const run = mission.runState ?? "running"
  if (mission.status === "failed") return run === "running" ? "interrupted" : "idle"
  if (mission.status === "completed") return input.seen ? "idle" : "done"
  if (mission.status !== "active") return "idle"
  if (run === "paused") return "paused"
  if (run === "prepared") return "prepared"
  if (run !== "running") return "idle"
  if (states.some(state => state === "running" || state === "queued" || state === "background")) return "working"
  return input.coordinatorState === "idle-without-report" ? "interrupted" : "idle"
}

/** Recurring schedule: an open request of its live passage asks for an answer; a
 * stopped schedule rests and a paused one stays paused; an interrupted schedule,
 * or a running one whose latest run failed (Run now retries), is orange; a live
 * passage works. */
export function scheduleMark(schedule: { state: string; pending: { status: string } | null; latestResult: { outcome: string } | null },
  openRequests = 0): MissionMark {
  if (openRequests > 0) return "permission"
  if (schedule.state === "paused") return "paused"
  if (schedule.state === "interrupted") return "interrupted"
  if (schedule.state !== "running") return "idle"
  if (schedule.pending) return schedule.pending.status === "uncertain" ? "idle" : "working"
  return schedule.latestResult?.outcome === "failed" ? "interrupted" : "idle"
}

export function filterMissionPickerEntries(entries: readonly MissionPickerEntry[], query: string): MissionPickerEntry[] {
  const needle = query.trim().toLocaleLowerCase()
  return needle ? entries.filter(entry => entry.title.toLocaleLowerCase().includes(needle)) : [...entries]
}
