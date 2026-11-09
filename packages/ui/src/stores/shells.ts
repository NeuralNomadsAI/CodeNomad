import { serverEvents } from "../lib/server-events"
import { getRootClient } from "./opencode-client"
import { createShellApi, createShellStore, type ShellRefreshEvent } from "./shell-store"
import { serverApi } from "../lib/api-client"

const shellStore = createShellStore((instanceId) => createShellApi(getRootClient(instanceId),
  (directory, workspaceID) => {
    if (workspaceID !== undefined) return Promise.reject(new Error("Background shell inventory requires a public directory location"))
    return serverApi.fetchBackgroundShells(instanceId, directory)
  }))

serverEvents.on("instance.event", (event) => {
  if (event.type !== "instance.event") return
  void shellStore.refreshForEvent(event.instanceId, event.event as ShellRefreshEvent)
})

serverEvents.on("instance.eventStatus", (event) => {
  if (event.type !== "instance.eventStatus" || event.status !== "connected") return
  void shellStore.refreshForEvent(event.instanceId, { type: "server.connected" })
})

export { shellStore }
