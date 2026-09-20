import type { WorkspaceEventPayload } from "../../../server/src/api-types"
import { serverEvents } from "../lib/server-events"
import { pluginControlsCache } from "./plugin-controls"

type InstanceEvent = Extract<WorkspaceEventPayload, { type: "instance.event" }>

serverEvents.on("instance.event", (event) => {
  const payload = event as InstanceEvent
  if (payload.event.type !== "config.updated" && payload.event.type !== "plugin.updated") return
  pluginControlsCache.invalidateInstance(payload.instanceId)
})

serverEvents.on("instance.eventStatus", (event) => {
  if (event.type === "instance.eventStatus" && event.status === "connected") {
    pluginControlsCache.invalidateInstance(event.instanceId)
  }
})

serverEvents.on("workspace.stopped", (event) => {
  if (event.type === "workspace.stopped") pluginControlsCache.clearInstance(event.workspaceId)
})
