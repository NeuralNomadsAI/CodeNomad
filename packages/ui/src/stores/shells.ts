import { backendEvents as serverEvents } from "../lib/server-events"
import { captureBackendOperation } from "../lib/backend-operation"
import { getRootClient } from "./opencode-client"
import { createShellApi, createShellStore, type ShellRefreshEvent } from "./shell-store"
import { backendOf } from "../lib/backend-client"

const shellStore = createShellStore((instanceId) => createShellApi(getRootClient(instanceId),
  (directory, workspaceID, signal) => {
    if (workspaceID !== undefined) return Promise.reject(new Error("Background shell inventory requires a public directory location"))
    return backendOf(instanceId).api.fetchBackgroundShells(instanceId, directory, signal)
  }), id => captureBackendOperation(id).signal)

serverEvents.on("instance.event", (event) => {
  if (event.type !== "instance.event") return
  void shellStore.refreshForEvent(event.instanceId, event.event as ShellRefreshEvent)
})

serverEvents.on("instance.eventStatus", (event) => {
  if (event.type !== "instance.eventStatus" || event.status !== "connected") return
  void shellStore.refreshForEvent(event.instanceId, { type: "server.connected" })
})

export { shellStore }

serverEvents.onOpen(backendId => shellStore.refreshBackend(backendId))
