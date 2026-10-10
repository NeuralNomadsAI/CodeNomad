import { serverEvents } from "../lib/server-events"
import { loading } from "./session-state"

const restored = new Set<string>()

/**
 * Whether the instance's initial session-list restoration (first page, project
 * inventory and saved ancestry) has settled, successfully or not. Secondary
 * panels defer their display reads until then so restoration keeps the shared
 * daemon and browser request budget. Latched per workspace incarnation: later
 * list refreshes do not withdraw an established panel's demand.
 */
export function sessionListRestored(instanceId: string): boolean {
  if (restored.has(instanceId)) return true
  if (loading().fetchingSessions.get(instanceId) !== false) return false
  restored.add(instanceId)
  return true
}

serverEvents.on("workspace.stopped", (event) => {
  if (event.type === "workspace.stopped") restored.delete(event.workspaceId)
})
