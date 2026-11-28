/** Colour carries attention; the hourglass, pause and warning shapes
 * distinguish states independently of the palette's accent contrast. */
export type MissionMark = "permission" | "interrupted" | "working" | "paused" | "done" | "prepared" | "waiting" | "idle"

export interface MissionPickerEntry {
  /** `mission:<id>`. */
  key: string
  /** Latest real activity (epoch ms), never a future wake; the shared list is ordered by it. */
  activityAt: number
  title: string
  /** Full localized state for tooltips and screen readers. */
  status: string
  mark: MissionMark
  /** The most urgent state of a Mission's tasks, carried by its chevron like a
   * session's children: a task asks for an answer, works, or finished unseen. */
  childActivity?: "permission" | "working" | "idle"
  /** A Mission whose plan holds no task: like a session without children, no chevron. */
  leaf?: boolean
  /** A programmed Mission: an ordinary row with the recurring icon. */
  recurring?: boolean
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

/** One list for every kind, latest activity first; the key breaks ties stably. */
export function sortMissionPickerEntries(entries: MissionPickerEntry[]): MissionPickerEntry[] {
  return entries.sort((a, b) => b.activityAt - a.activityAt || a.key.localeCompare(b.key))
}

export function filterMissionPickerEntries(entries: readonly MissionPickerEntry[], query: string): MissionPickerEntry[] {
  const needle = query.trim().toLocaleLowerCase()
  return needle ? entries.filter(entry => entry.title.toLocaleLowerCase().includes(needle)) : [...entries]
}
