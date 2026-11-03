import type { MissionCondition, MissionLaunchPolicy } from "./launch-policy"

export type MissionLaunchSchedule = { kind: "cron"; expression: string; zone: string } | { kind: "every"; intervalMs: number }
  | { kind: "at"; at: number; zone: string } | { kind: "in"; delayMs: number }
/** One reading of both stored shapes. Documents written before launch criteria
 * keep their bytes; their timing, condition and ends read as these criteria. */
export type MissionLaunchModel = { schedules: MissionLaunchSchedule[]; events: MissionCondition[]; onlyWithNews: boolean
  until: number | null; endAfterMs: number | null; maxLaunches: number | null }

/** Browser-safe policy classification shared by preparation and controls. */
export function missionLaunchModel(policy: MissionLaunchPolicy): MissionLaunchModel {
  if ("when" in policy) return { schedules: policy.when.filter(item => item.kind === "cron"), events: policy.when.filter(item => item.kind !== "cron"),
    onlyWithNews: policy.onlyWithNews, until: policy.until, endAfterMs: null, maxLaunches: null }
  const timing = policy.timing, events = policy.condition ? [policy.condition] : []
  const schedules: MissionLaunchSchedule[] = timing.kind === "immediate" ? [] : timing.kind === "multi"
    ? timing.calendars.map(item => ({ kind: "cron", ...item })) : [timing]
  // An event-only legacy policy launched once; dated legacy policies read their
  // condition at those dates only.
  const repeats = ["every", "cron", "multi"].includes(timing.kind)
  return { schedules, events, onlyWithNews: schedules.length > 0 && events.length > 0, until: policy.ends.at, endAfterMs: policy.ends.afterMs,
    maxLaunches: repeats ? policy.ends.maxLaunches : timing.kind === "immediate" && !events.length ? null : 1 }
}
export function requiresMissionCalendar(policy: MissionLaunchPolicy): boolean {
  const model = missionLaunchModel(policy)
  return model.schedules.length > 0 || model.events.length > 0
}
export function missionLaunchLimit(policy: MissionLaunchPolicy): number | null {
  const model = missionLaunchModel(policy)
  if (!model.schedules.length && !model.events.length) return 1
  return model.schedules.some(item => item.kind === "at" || item.kind === "in") ? 1 : model.maxLaunches
}
/** Events without onlyWithNews own one internal 15-minute principal after the schedules. */
export function missionEventPrincipal(policy: MissionLaunchPolicy): boolean {
  const model = missionLaunchModel(policy)
  return model.events.length > 0 && !model.onlyWithNews
}
/** Principal slot whose wakes only check events; schedule slots launch on their own. */
export function missionEventPrincipalSlot(policy: MissionLaunchPolicy): number | null {
  return missionEventPrincipal(policy) ? missionLaunchModel(policy).schedules.length : null
}
export function missionPrincipalCount(policy: MissionLaunchPolicy): number {
  return missionLaunchModel(policy).schedules.length + (missionEventPrincipal(policy) ? 1 : 0)
}
export function missionLaunchesRepeatedly(policy: MissionLaunchPolicy): boolean {
  return requiresMissionCalendar(policy) && missionLaunchLimit(policy) !== 1
}
