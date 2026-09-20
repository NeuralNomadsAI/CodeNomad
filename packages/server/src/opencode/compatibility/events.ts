import type { OpenCodeEvent } from "@opencode/client"

export function normalizeRuntimeEvent(event: OpenCodeEvent): OpenCodeEvent {
  // Native metadata/durable identity is retained. Catalog/content changes stay
  // invalidation intents; no synthetic upstream durable records are invented.
  if ((event.type as string) === "session.permissions.updated") {
    return { ...event, type: "session.permissions" } as OpenCodeEvent
  }
  if (event.type === "session.step.started" && event.data.started === undefined) {
    // Before 2.0.7 the native reducer used the durable event's creation time.
    // Keep that meaning for old daemons; preserve precise start times when sent.
    return { ...event, data: { ...event.data, started: event.created } }
  }
  return event
}
