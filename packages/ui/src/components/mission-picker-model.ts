/** One visual state per Mission or schedule, on the session palette: colour shows
 * only what needs attention now. Red asks for an answer, yellow works, orange is
 * stopped (interrupted, or paused) with an action to continue, green finished
 * since last seen; anything else is idle. Outcomes themselves are status text. */
export type MissionMark = "permission" | "interrupted" | "working" | "paused" | "done" | "idle"

/** Most urgent first; like a collapsed session parent's chevron (`session-child-activity.ts`). */
export const MISSION_PICKER_ATTENTION = ["permission", "interrupted", "working", "done"] as const
export type MissionPickerAttention = (typeof MISSION_PICKER_ATTENTION)[number]

export interface MissionPickerEntry {
  /** `mission:<id>` or `schedule:<id>`. */
  key: string
  title: string
  /** Full localized state for tooltips and screen readers. */
  status: string
  mark: MissionMark
}

type Translate = (key: string, params?: Record<string, string>) => string
export type MissionPickerAttentionCounts = Record<MissionPickerAttention, number>

const attentionOf = (mark: MissionMark): MissionPickerAttention | undefined =>
  (MISSION_PICKER_ATTENTION as readonly string[]).includes(mark) ? mark as MissionPickerAttention : undefined

/** Attention among the entries other than the selected one. */
export function missionPickerAttention(entries: readonly MissionPickerEntry[], selectedKey?: string): {
  kind?: MissionPickerAttention; counts: MissionPickerAttentionCounts
} {
  const counts: MissionPickerAttentionCounts = { permission: 0, interrupted: 0, working: 0, done: 0 }
  for (const entry of entries) {
    const attention = attentionOf(entry.mark)
    if (entry.key !== selectedKey && attention) counts[attention]++
  }
  return { kind: MISSION_PICKER_ATTENTION.find(kind => counts[kind] > 0), counts }
}

/** Counted states, e.g. "1 waiting, 2 running". */
export function missionPickerAttentionLabel(t: Translate, counts: MissionPickerAttentionCounts): string {
  return MISSION_PICKER_ATTENTION.filter(kind => counts[kind] > 0)
    .map(kind => t(`missionsPanel.attention.${kind}.${counts[kind] === 1 ? "one" : "other"}`, { count: String(counts[kind]) }))
    .join(", ")
}

/** A one-time Mission's state from native requests and observed actor activity.
 * A failed mission can be resumed unless the user stopped it since, so it reads
 * as interrupted; a completed one is green until seen. */
export function missionMark(mission: { status: string; runState?: string }, input: {
  openRequests: number; actorStates?: readonly string[]; coordinatorState?: string; seen: boolean
}): MissionMark {
  const states = input.actorStates ?? []
  if (input.openRequests > 0 || states.some(state => state === "permission" || state === "form")) return "permission"
  const run = mission.runState ?? "running"
  if (mission.status === "failed") return run === "running" ? "interrupted" : "idle"
  if (mission.status === "completed") return input.seen ? "idle" : "done"
  if (mission.status !== "active") return "idle"
  if (run === "paused") return "paused"
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
