import type { MissionLaunchPolicy } from "./launch-policy"

/** Browser-safe policy classification shared by preparation and controls. */
export function requiresMissionCalendar(policy: MissionLaunchPolicy): boolean {
  return policy.timing.kind !== "immediate" || policy.condition !== null
}
export function missionLaunchLimit(policy: MissionLaunchPolicy): number | null {
  return ["every", "cron", "multi"].includes(policy.timing.kind) ? policy.ends.maxLaunches : 1
}
