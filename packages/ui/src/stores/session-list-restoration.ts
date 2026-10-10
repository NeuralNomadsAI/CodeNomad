import { createSignal } from "solid-js"
import { serverEvents } from "../lib/server-events"
import { loading } from "./session-state"

const restored = new Set<string>()
// Requests abandoned by their caller (a timed-out foreground refresh) delete
// their loading entry without claiming the list was loaded. They still end
// restoration, so they settle this reactive latch instead.
const [abandoned, setAbandoned] = createSignal<ReadonlySet<string>>(new Set())

/**
 * Whether the instance's initial session-list restoration (first page, project
 * inventory and saved ancestry) has settled, successfully or not. Secondary
 * panels defer their display reads until then so restoration keeps the shared
 * daemon and browser request budget. Latched per workspace incarnation: later
 * list refreshes do not withdraw an established panel's demand.
 */
export function sessionListRestored(instanceId: string): boolean {
  if (restored.has(instanceId)) return true
  if (!abandoned().has(instanceId) && loading().fetchingSessions.get(instanceId) !== false) return false
  restored.add(instanceId)
  return true
}

/** Settle restoration after the latest list request was abandoned unfinished. */
export function settleAbandonedSessionListRestoration(instanceId: string): void {
  if (restored.has(instanceId) || abandoned().has(instanceId)) return
  setAbandoned((previous) => new Set(previous).add(instanceId))
}

/** Forget a removed workspace incarnation. */
export function forgetSessionListRestoration(instanceId: string): void {
  restored.delete(instanceId)
  if (!abandoned().has(instanceId)) return
  setAbandoned((previous) => {
    const next = new Set(previous)
    next.delete(instanceId)
    return next
  })
}

serverEvents.on("workspace.stopped", (event) => {
  if (event.type === "workspace.stopped") forgetSessionListRestoration(event.workspaceId)
})
