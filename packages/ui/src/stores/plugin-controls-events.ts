import type { WorkspaceEventPayload } from "../../../server/src/api-types"
import { serverEvents } from "../lib/server-events"
import { pluginControlsCache } from "./plugin-controls"

type InstanceEvent = Extract<WorkspaceEventPayload, { type: "instance.event" }>

serverEvents.on("instance.event", (event) => {
  const payload = event as InstanceEvent
  if (payload.event.type !== "config.updated" && payload.event.type !== "plugin.updated") return
  if (payload.event.type === "config.updated") {
    // A config event does not identify whether its changed document was global.
    // Mark every worktree snapshot stale, but let visible consumers demand reads.
    pluginControlsCache.invalidateInstance(payload.instanceId)
    return
  }
  const directory = payload.event.location?.directory
  if (directory) {
    pluginControlsCache.invalidateLocation(payload.instanceId, { directory })
    return
  }
  pluginControlsCache.invalidateInstance(payload.instanceId)
})

serverEvents.on("instance.eventStatus", (event) => {
  if (event.type === "instance.eventStatus" && event.status === "connected") {
    pluginControlsCache.invalidateInstance(event.instanceId)
  }
})

// Renderer-to-backend reconnects are independent of the native subscription.
// The event transport has no replay; visible demand reconciles these snapshots,
// while hidden worktrees remain stale until their next activation.
serverEvents.onOpen(() => pluginControlsCache.invalidateAll())

serverEvents.on("workspace.stopped", (event) => {
  if (event.type === "workspace.stopped") pluginControlsCache.clearInstance(event.workspaceId)
})
