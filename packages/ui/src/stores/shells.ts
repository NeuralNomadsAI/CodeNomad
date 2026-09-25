import { serverEvents } from "../lib/server-events"
import { getRootClient } from "./opencode-client"
import { createShellApi, createShellStore, type ShellRefreshEvent } from "./shell-store"

const shellStore = createShellStore((instanceId) => createShellApi(getRootClient(instanceId)))

serverEvents.on("instance.event", (event) => {
  if (event.type !== "instance.event" || !event.event.type.startsWith("shell.")) return
  void shellStore.refreshForEvent(event.instanceId, event.event as ShellRefreshEvent)
})

serverEvents.on("instance.eventStatus", (event) => {
  if (event.type !== "instance.eventStatus" || event.status !== "connected") return
  void shellStore.refreshForEvent(event.instanceId, { type: "server.connected" })
})

export { shellStore }
