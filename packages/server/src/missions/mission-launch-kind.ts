import type { MissionCondition, MissionLaunchPolicy } from "./launch-policy"

export type MissionLaunchSchedule = { kind: "now" } | { kind: "cron"; expression: string; zone: string } | { kind: "every"; intervalMs: number }
  | { kind: "at"; at: number; zone: string } | { kind: "in"; delayMs: number }
/** How one schedule slot launches: only if one of `conditions` changed since the last
 * passage ("if"), and, as a `fallback` ("else"), only if the criteria above its `group`
 * (the position of its schedule run in the list) launched no passage since this
 * schedule's previous slot. */
export type MissionSchedulePlan = { conditions: MissionCondition[]; fallback: boolean; group: number }
/** One reading of both stored shapes. Documents written before launch criteria
 * keep their bytes; their timing, condition and ends read as these criteria.
 * `events` lists every watched event in stored order; `plans` follows `schedules`. */
export type MissionLaunchModel = { schedules: MissionLaunchSchedule[]; plans: MissionSchedulePlan[]; triggers: MissionCondition[]
  conditions: MissionCondition[]; events: MissionCondition[]; until: number | null; endAfterMs: number | null; maxLaunches: number | null }

export type MissionCriterionConnector = "or" | "if" | "else"
export type MissionCriterionRole = "trigger" | "condition"
/** The ordered list as alternating runs of schedules and events. Between two cards the
 * connector depends only on their kinds: same kind "or", schedule → event "if" (the
 * event run is the condition of the schedule run above it), event → schedule "else"
 * (the schedule run is the fallback of the events above it). Events in the first run
 * trigger; any later event run only conditions the schedule run before it. Shared by
 * the codec, the engine, the editor and the list summary. */
export function missionCriteriaStructure(items: readonly { kind: string }[], isSchedule: (kind: string) => boolean = kind => kind === "cron" || kind === "now") {
  const scheduled = items.map(item => isSchedule(item.kind))
  const connectors: MissionCriterionConnector[] = scheduled.slice(1).map((current, index) =>
    current === scheduled[index] ? "or" : current ? "else" : "if")
  const runs: { schedule: boolean; indices: number[] }[] = []
  scheduled.forEach((schedule, index) => {
    if (runs.at(-1)?.schedule === schedule) runs.at(-1)!.indices.push(index)
    else runs.push({ schedule, indices: [index] })
  })
  const roles: MissionCriterionRole[] = scheduled.map(() => "trigger")
  const plans = new Map<number, { conditions: number[]; fallback: boolean; group: number }>()
  runs.forEach((run, position) => {
    if (!run.schedule) { if (position > 0) for (const index of run.indices) roles[index] = "condition"; return }
    const next = runs[position + 1]
    for (const index of run.indices) plans.set(index, { conditions: next?.indices ?? [], fallback: position > 0, group: position })
  })
  return { connectors, roles, plans }
}

/** Browser-safe policy classification shared by preparation and controls. */
export function missionLaunchModel(policy: MissionLaunchPolicy): MissionLaunchModel {
  if ("when" in policy) {
    // A sole now criterion uses ordinary first-Play journal admission. Mixed lists
    // retain now as a native schedule so their OR/if/else groups stay composable.
    const criteria = policy.when.length === 1 && policy.when[0].kind === "now" ? [] : policy.when
    const { roles, plans } = missionCriteriaStructure(criteria)
    const events = criteria.filter(item => item.kind !== "cron" && item.kind !== "now")
    const schedules: MissionLaunchSchedule[] = [], schedulePlans: MissionSchedulePlan[] = []
    criteria.forEach((item, index) => {
      if (item.kind !== "cron" && item.kind !== "now") return
      const plan = plans.get(index)!
      schedules.push(item)
      schedulePlans.push({ conditions: plan.conditions.map(position => criteria[position] as MissionCondition), fallback: plan.fallback, group: plan.group })
    })
    return { schedules, plans: schedulePlans,
      triggers: events.filter(item => roles[criteria.indexOf(item)] === "trigger"),
      conditions: events.filter(item => roles[criteria.indexOf(item)] === "condition"),
      events, until: null, endAfterMs: null, maxLaunches: null }
  }
  const timing = policy.timing, events = policy.condition ? [policy.condition] : []
  const schedules: MissionLaunchSchedule[] = timing.kind === "immediate" ? [] : timing.kind === "multi"
    ? timing.calendars.map(item => ({ kind: "cron", ...item })) : [timing]
  // A dated legacy condition gated those dates ("if" on every schedule); an event-only
  // legacy policy launched once on that event. Both keep their stored end and limit.
  const repeats = ["every", "cron", "multi"].includes(timing.kind)
  return { schedules, plans: schedules.map(() => ({ conditions: events, fallback: false, group: 0 })),
    triggers: schedules.length ? [] : events, conditions: schedules.length ? events : [], events,
    until: policy.ends.at, endAfterMs: policy.ends.afterMs,
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
/** Trigger events own one internal 15-minute principal after the schedules. */
export function missionEventPrincipal(policy: MissionLaunchPolicy): boolean {
  return missionLaunchModel(policy).triggers.length > 0
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
