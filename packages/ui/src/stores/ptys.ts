import { serverEvents } from "../lib/server-events"
import { getRootClient } from "./opencode-client"
import { createPtyApi, createPtyStore } from "./pty-store"

const ptyStore = createPtyStore((instanceId) => createPtyApi(getRootClient(instanceId)))

serverEvents.on("instance.event", (event) => {
  if (event.type !== "instance.event") return
  void ptyStore.refreshForEvent(event.instanceId, event.event)
})

serverEvents.on("instance.eventStatus", (event) => {
  if (event.type !== "instance.eventStatus" || event.status !== "connected") return
  void ptyStore.refreshForEvent(event.instanceId, { type: "server.connected" })
})

export { ptyStore }
