import type { ServiceUsageSnapshot } from "../../../server/src/api-types"

// Display snapshots for the Stats section, kept for the renderer's lifetime so
// reopening a period shows the last result while it revalidates. Workspace IDs
// are not stable across restarts, so persisting them would never be reused.
const memory = new Map<string, ServiceUsageSnapshot>()

const key = (instanceId: string, days: number, timezone: string) => `${instanceId}\0${days}\0${timezone}`

export function getCachedServiceUsage(instanceId: string, days: number, timezone: string): ServiceUsageSnapshot | undefined {
  return memory.get(key(instanceId, days, timezone))
}

export function setCachedServiceUsage(instanceId: string, days: number, timezone: string, snapshot: ServiceUsageSnapshot) {
  memory.set(key(instanceId, days, timezone), snapshot)
}
