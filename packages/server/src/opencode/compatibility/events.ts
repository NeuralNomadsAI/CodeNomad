import type { OpenCodeEvent } from "@opencode/client"

export function normalizeRuntimeEvent(event: OpenCodeEvent): OpenCodeEvent {
  // Native metadata/durable identity is retained. Catalog/content changes stay
  // invalidation intents; no synthetic upstream durable records are invented.
  if ((event.type as string) === "session.permissions.updated") {
    return { ...event, type: "session.permissions" } as OpenCodeEvent
  }
  return event
}
