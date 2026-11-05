import { serverEvents } from "../lib/server-events"
import { getRootClient } from "./opencode-client"
import { createShellApi, createShellStore, type ShellRefreshEvent } from "./shell-store"
import { getProjectAvailability, requireProjectAvailability } from "./project-capability"
import { captureInstanceRequestAuthority } from "./session-api"

const shellStore = createShellStore((instanceId) => {
  requireProjectAvailability(instanceId, "backgroundShells")
  const current = captureInstanceRequestAuthority(instanceId)
  const api = createShellApi(getRootClient(instanceId))
  return {
    list: async (...args) => { const result = await api.list(...args); if (!current()) throw new DOMException("", "AbortError"); return result },
    remove: (...args) => { requireProjectAvailability(instanceId, "backgroundShells"); return api.remove(...args) },
    output: async (...args) => { const result = await api.output(...args); if (!current()) throw new DOMException("", "AbortError"); return result },
  }
}, instanceId => {
  const current = captureInstanceRequestAuthority(instanceId)
  return () => current() && getProjectAvailability(instanceId, "backgroundShells").allowed
})

serverEvents.on("instance.event", (event) => {
  if (event.type !== "instance.event" || !event.event.type.startsWith("shell.")) return
  if (!getProjectAvailability(event.instanceId, "backgroundShells").allowed) return
  void shellStore.refreshForEvent(event.instanceId, event.event as ShellRefreshEvent)
})

serverEvents.on("instance.eventStatus", (event) => {
  if (event.type !== "instance.eventStatus" || event.status !== "connected") return
  if (!getProjectAvailability(event.instanceId, "backgroundShells").allowed) return
  void shellStore.refreshForEvent(event.instanceId, { type: "server.connected" })
})

export { shellStore }
