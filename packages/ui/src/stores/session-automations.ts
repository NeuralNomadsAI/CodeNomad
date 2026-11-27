import type { SessionAutomationAction } from "../../../server/src/opencode/automation-contract"
import { backendOf } from "../lib/backend-client"
import { createEventRefreshScheduler } from "../lib/event-refresh-scheduler"
import { tGlobal } from "../lib/i18n"
import { isExecutionTerminalEvent } from "../lib/native-execution-events"
import { showToastNotification } from "../lib/notifications"
import { backendEvents as serverEvents } from "../lib/server-events"
import { createSessionAutomationsStore, formatAutomationMutationError } from "./session-automations-store"

// The signal leaves the shared background budget's queue or aborts the request once the Session is hidden.
export const sessionAutomations = createSessionAutomationsStore(
  (instanceId, sessionId, signal) => backendOf(instanceId).api.fetchSessionAutomations(instanceId, sessionId, signal),
  { signal: id => serverEvents.signalForInstance(id) },
)

// Changes created/updated during a turn or while the stream was down are re-read for demanded Sessions.
const reconnects = createEventRefreshScheduler((instanceId, signal) =>
  signal.aborted ? undefined : sessionAutomations.refreshDemanded(instanceId))

serverEvents.on("instance.event", (event) => {
  if (event.type !== "instance.event") return
  const native = event.event as { type: string; data?: { sessionID?: unknown; shell?: { metadata?: { sessionID?: unknown } } } }
  if (native.type === "session.deleted" && typeof native.data?.sessionID === "string") {
    sessionAutomations.forget(event.instanceId, native.data.sessionID)
  } else if (isExecutionTerminalEvent(native) && typeof native.data?.sessionID === "string") {
    void sessionAutomations.refresh(event.instanceId, native.data.sessionID)
  } else if (native.type === "shell.exited") {
    void sessionAutomations.noteShellExited(event.instanceId)
  } else if (native.type === "session.shell.ended") {
    const shellSessionId = typeof native.data?.sessionID === "string"
      ? native.data.sessionID
      : typeof native.data?.shell?.metadata?.sessionID === "string"
        ? native.data.shell.metadata.sessionID
        : undefined
    if (shellSessionId) void sessionAutomations.refresh(event.instanceId, shellSessionId)
    else void sessionAutomations.noteShellExited(event.instanceId)
  } else if (native.type === "server.connected") {
    reconnects.schedule(event.instanceId, "urgent", serverEvents.signalForInstance(event.instanceId))
  }
})

serverEvents.on("instance.eventStatus", (event) => {
  if (event.type === "instance.eventStatus" && event.status === "connected") {
    reconnects.schedule(event.instanceId, "urgent", serverEvents.signalForInstance(event.instanceId))
  }
})

serverEvents.onOpen(backendId => void sessionAutomations.refreshDemanded(undefined, backendId))

serverEvents.on("workspace.stopped", (event) => {
  if (event.type !== "workspace.stopped") return
  reconnects.cancel(event.workspaceId)
  sessionAutomations.clearInstance(event.workspaceId)
})

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void sessionAutomations.refreshDemanded()
  })
}

/** Pause, resume, or delete one automation owned by the Session; failures show a notice. */
export function runSessionAutomationAction(
  instanceId: string,
  sessionId: string,
  automationId: string,
  action: SessionAutomationAction,
): Promise<boolean> {
  let ok = false
  return sessionAutomations.run(instanceId, sessionId, automationId, async () => {
    try {
      const api = backendOf(instanceId).api
      const result = action === "pause"
        ? await api.pauseSessionAutomation(instanceId, sessionId, automationId)
        : action === "resume"
          ? await api.resumeSessionAutomation(instanceId, sessionId, automationId)
          : await api.deleteSessionAutomation(instanceId, sessionId, automationId)
      if (result.status !== "ok") {
        const fallback = tGlobal("instanceShell.automations.error")
        showToastNotification({
          category: "sessions",
          title: fallback,
          message: result.upstream && result.error ? result.error : fallback,
          variant: "error",
        })
        return
      }
      ok = true
      if (action === "delete") {
        return items => items.filter(item => item.id !== automationId)
      }
      const nextStatus = action === "pause" ? "paused" : "active"
      return items => items.map(item => {
        if (item.id !== automationId) return item
        return result.automation ?? { ...item, status: nextStatus, ...(nextStatus === "paused" ? { nextDueAt: undefined } : {}) }
      })
    } catch (error) {
      const fallback = tGlobal("instanceShell.automations.error")
      showToastNotification({
        category: "sessions",
        title: fallback,
        message: formatAutomationMutationError(error, fallback),
        variant: "error",
      })
    }
  }).then(() => ok)
}
