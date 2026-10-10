/** Most urgent first; like a collapsed session parent's chevron (`session-child-activity.ts`). */
export const MISSION_PICKER_ATTENTION = ["permission", "failed", "working"] as const
export type MissionPickerAttention = (typeof MISSION_PICKER_ATTENTION)[number]

export interface MissionPickerEntry {
  /** `mission:<id>` or `schedule:<id>`. */
  key: string
  title: string
  /** Full localized state for tooltips and screen readers. */
  status: string
  /** Small status mark: attention when present, otherwise the resting state. */
  mark: string
  attention?: MissionPickerAttention
}

type Translate = (key: string, params?: Record<string, string>) => string
export type MissionPickerAttentionCounts = Record<MissionPickerAttention, number>

/** Attention among the entries other than the selected one. */
export function missionPickerAttention(entries: readonly MissionPickerEntry[], selectedKey?: string): {
  kind?: MissionPickerAttention; counts: MissionPickerAttentionCounts
} {
  const counts: MissionPickerAttentionCounts = { permission: 0, failed: 0, working: 0 }
  for (const entry of entries) if (entry.key !== selectedKey && entry.attention) counts[entry.attention]++
  return { kind: MISSION_PICKER_ATTENTION.find(kind => counts[kind] > 0), counts }
}

/** Counted states, e.g. "1 waiting, 2 running". */
export function missionPickerAttentionLabel(t: Translate, counts: MissionPickerAttentionCounts): string {
  return MISSION_PICKER_ATTENTION.filter(kind => counts[kind] > 0)
    .map(kind => t(`missionsPanel.attention.${kind}.${counts[kind] === 1 ? "one" : "other"}`, { count: String(counts[kind]) }))
    .join(", ")
}

/** One-time Mission attention from native requests and observed actor activity. */
export function missionEntryAttention(mission: { status: string; runState?: string }, openRequests: number,
  actorStates: readonly string[] = []): MissionPickerAttention | undefined {
  if (openRequests > 0 || actorStates.some(state => state === "permission" || state === "form")) return "permission"
  if (mission.status === "failed") return "failed"
  if (mission.status === "active" && (mission.runState ?? "running") === "running"
    && actorStates.some(state => state === "running" || state === "queued" || state === "background")) return "working"
  return undefined
}

/** Recurring schedule attention: a live passage works; a failed latest run stays visible until the next one. */
export function scheduleEntryAttention(schedule: { pending: { status: string } | null; latestResult: { outcome: string } | null }): MissionPickerAttention | undefined {
  if (schedule.pending && schedule.pending.status !== "uncertain") return "working"
  if (!schedule.pending && schedule.latestResult?.outcome === "failed") return "failed"
  return undefined
}

export function filterMissionPickerEntries(entries: readonly MissionPickerEntry[], query: string): MissionPickerEntry[] {
  const needle = query.trim().toLocaleLowerCase()
  return needle ? entries.filter(entry => entry.title.toLocaleLowerCase().includes(needle)) : [...entries]
}
