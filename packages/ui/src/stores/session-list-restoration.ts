import { createSignal } from "solid-js"
import { backendEvents as serverEvents } from "../lib/server-events"
import { loading } from "./session-state"

const restored = new Set<string>()
// Settled by either the first visible page + project metadata arriving (before
// full historical descendant pagination completes) or an abandoned foreground
// refresh that deleted its loading entry without claiming the list was loaded.
const [settled, setSettled] = createSignal<ReadonlySet<string>>(new Set())

/**
 * Whether the instance's initial visible session list (first page and project
 * metadata) or terminal load state has settled. Secondary panels defer their
 * display reads until then so the initial sidebar page keeps the shared daemon
 * and browser request budget without waiting on full historical descendant
 * pagination. Latched per workspace incarnation: later list refreshes do not
 * withdraw an established panel's demand.
 */
export function sessionListRestored(instanceId: string): boolean {
  if (restored.has(instanceId)) return true
  if (!settled().has(instanceId) && loading().fetchingSessions.get(instanceId) !== false) return false
  restored.add(instanceId)
  return true
}

/** Settle restoration once the first visible session page and project metadata are published. */
export function settleSessionListFirstPage(instanceId: string): void {
  if (restored.has(instanceId) || settled().has(instanceId)) return
  setSettled((previous) => new Set(previous).add(instanceId))
}

/** Settle restoration after the latest list request was abandoned unfinished. */
export function settleAbandonedSessionListRestoration(instanceId: string): void {
  if (restored.has(instanceId) || settled().has(instanceId)) return
  setSettled((previous) => new Set(previous).add(instanceId))
}

/** Forget a removed workspace incarnation. */
export function forgetSessionListRestoration(instanceId: string): void {
  restored.delete(instanceId)
  if (!settled().has(instanceId)) return
  setSettled((previous) => {
    const next = new Set(previous)
    next.delete(instanceId)
    return next
  })
}

serverEvents.on("workspace.stopped", (event) => {
  if (event.type === "workspace.stopped") forgetSessionListRestoration(event.workspaceId)
})
