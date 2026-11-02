import type { OpenCodeEvent } from "@opencode/client"

/** Integration notifications carry invalidation only. Keep no plugin-authored fields in the relay. */
export function integrationEventForRelay(event: OpenCodeEvent): OpenCodeEvent | undefined {
  if (!event.type.startsWith("rpc.neuralnomads.")) return event
  if (!/^rpc\.neuralnomads\.[a-z][a-z0-9-]{0,31}\.(status_changed|hosts_changed)$/.test(event.type) || !event.location) return undefined
  const workspaceID = "workspaceID" in event.location ? event.location.workspaceID : undefined
  return { type: event.type, location: { directory: event.location.directory,
    ...(workspaceID === undefined ? {} : { workspaceID }) }, data: {} } as OpenCodeEvent
}
