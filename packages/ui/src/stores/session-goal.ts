import { GOAL_CHANGED_EVENT, GOAL_COMMAND, type GoalCommandAction } from "../../../server/src/opencode/goal-contract"
import { serverApi } from "../lib/api-client"
import { createEventRefreshScheduler } from "../lib/event-refresh-scheduler"
import { tGlobal } from "../lib/i18n"
import { showToastNotification } from "../lib/notifications"
import { getOpencodeErrorMessage } from "../lib/opencode-api"
import { serverEvents } from "../lib/server-events"
import { executeCustomCommand } from "./session-actions"
import { createSessionGoalStore } from "./session-goal-store"
import { getProjectAvailability, requireProjectAvailability } from "./project-capability"
import { captureInstanceRequestAuthority } from "./session-api"

// The signal leaves the shared background budget's queue or aborts the request once the Session is hidden.
const goalStore = createSessionGoalStore(async (instanceId, sessionId, signal) => {
  requireProjectAvailability(instanceId, "executionSettings")
  const current = captureInstanceRequestAuthority(instanceId)
  const result = await serverApi.fetchSessionGoal(instanceId, sessionId, signal)
  if (!current()) throw new DOMException("", "AbortError")
  requireProjectAvailability(instanceId, "executionSettings")
  return result
})
export const sessionGoals = { ...goalStore,
  demand: (instanceId: string, sessionId: string) => getProjectAvailability(instanceId, "executionSettings").allowed
    ? goalStore.demand(instanceId, sessionId) : () => {},
}

// Changes published while the stream was down are lost: re-read what is shown.
const reconnects = createEventRefreshScheduler(instanceId => sessionGoals.refreshDemanded(instanceId))

serverEvents.on("instance.event", (event) => {
  if (event.type !== "instance.event") return
  if (!getProjectAvailability(event.instanceId, "executionSettings").allowed) return
  const native = event.event as { type: string; data?: { sessionID?: unknown } }
  if (native.type === GOAL_CHANGED_EVENT) sessionGoals.applyChanged(event.instanceId, native.data)
  else if (native.type === "session.deleted" && typeof native.data?.sessionID === "string") sessionGoals.forget(event.instanceId, native.data.sessionID)
  else if (native.type === "server.connected") reconnects.schedule(event.instanceId, "urgent")
})

serverEvents.on("instance.eventStatus", (event) => {
  if (event.type === "instance.eventStatus" && event.status === "connected") reconnects.schedule(event.instanceId, "urgent")
})

serverEvents.onOpen(() => void sessionGoals.refreshDemanded())

serverEvents.on("workspace.stopped", (event) => {
  if (event.type !== "workspace.stopped") return
  reconnects.cancel(event.workspaceId)
  sessionGoals.clearInstance(event.workspaceId)
})

/** `/goal pause|resume|clear` for the Session through the composer's command path; failures show a notice. */
export function runSessionGoalCommand(instanceId: string, sessionId: string, action: GoalCommandAction): Promise<void> {
  if (!getProjectAvailability(instanceId, "executionSettings").allowed) return Promise.resolve()
  return sessionGoals.run(instanceId, sessionId, async () => {
    try {
      await executeCustomCommand(instanceId, sessionId, GOAL_COMMAND, action)
    } catch (error) {
      showToastNotification({ category: "sessions", title: tGlobal("instanceShell.goal.error"),
        message: getOpencodeErrorMessage(error, tGlobal("instanceShell.goal.error")), variant: "error" })
    }
  })
}
