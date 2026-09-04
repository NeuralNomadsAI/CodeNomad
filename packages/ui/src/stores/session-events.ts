import type {
  PermissionAsked,
  PermissionReplied,
  SessionCompactionEnded,
  SessionCreated,
  SessionExecutionFailed,
  SessionIdle,
  SessionRevertCleared,
  SessionRevertCommitted,
  SessionRevertStaged,
  SessionStatusUpdated,
  TuiToastShow,
} from "@opencode-ai/client"
import { getLogger } from "../lib/logger"
import type { EventSessionDeleted, NativeSessionEvent } from "../lib/sse-manager"
import {
  getPermissionId,
  getPermissionKind,
  getPermissionSessionId,
  getRequestIdFromPermissionReply,
} from "../types/permission"
import type { PermissionRequest } from "../types/permission"
import { showToastNotification, type ToastHandle, ToastVariant } from "../lib/notifications"
import { sendOsNotification } from "../lib/os-notifications"
import { preferences } from "./preferences"
import {
  instances,
  markPermissionReplied,
  hasRepliedPermission,
  reconcilePendingSessionIndicators,
  setPendingFormAddedHandler,
} from "./instances"
import { showAlertDialog } from "./alerts"
import {
  createClientSession,
  getIdleSinceForStatusTransition,
  mapSdkSessionRetry,
  mapSdkSessionStatus,
  type Session,
  type SessionRetryState,
  type SessionStatus,
} from "../types/session"
import { ensureSessionAncestorsExpanded, getAuthoritativelyDeletedSessionIdsForInstance, prependSessionListId, removeSessionListId, sessions, setSessionStatus, setSessions, syncInstanceSessionIndicator, withSession } from "./session-state"
import { mergeFetchedSessionRuntimeState } from "./session-generation-recovery"
import { tGlobal } from "../lib/i18n"

import { fetchSessions, loadMessages, removeSessionRuntimeState } from "./session-api"
import { getRootClient } from "./opencode-client"
import { getWorktrees } from "./worktrees"
import {
  setSessionRevertV2,
} from "./message-v2/bridge"
import { messageStoreBus } from "./message-v2/bus"
import { handleConversationAssistantPartUpdated } from "./conversation-speech"

const log = getLogger("sse")
const pendingSessionFetches = new Map<string, {
  status: SessionStatus
  retry?: SessionRetryState | null
}>()
const nativeLifecycleGenerations = new Map<string, number>()
let activeRetryToast: ToastHandle | null = null

function advanceNativeLifecycle(instanceId: string, sessionId: string): number {
  const key = `${instanceId}\0${sessionId}`
  const generation = (nativeLifecycleGenerations.get(key) ?? 0) + 1
  nativeLifecycleGenerations.set(key, generation)
  return generation
}

function isCurrentNativeLifecycle(instanceId: string, sessionId: string, generation: number): boolean {
  return nativeLifecycleGenerations.get(`${instanceId}\0${sessionId}`) === generation
}

function speakCompletedAssistantText(instanceId: string, sessionId: string): void {
  const store = messageStoreBus.getOrCreate(instanceId)
  const messageId = store.getLastAssistantMessageId(sessionId)
  const message = messageId ? store.getMessage(messageId) : undefined
  if (!messageId || message?.status !== "complete") return
  const info = store.getMessageInfo(messageId)
  for (const partId of message.partIds) {
    handleConversationAssistantPartUpdated(instanceId, message.parts[partId].data, info)
  }
}

function handleNativeSessionEvent(instanceId: string, event: NativeSessionEvent): void {
  switch (event.type) {
    case "form.created":
    case "form.replied":
    case "form.cancelled":
      return
    case "session.renamed":
      if (!sessions().get(instanceId)?.has(event.data.sessionID)) void fetchSessionInfo(instanceId, event.data.sessionID, event.location?.directory)
      withSession(instanceId, event.data.sessionID, (session) => { session.title = event.data.title })
      return
    case "session.agent.selected":
      if (!sessions().get(instanceId)?.has(event.data.sessionID)) void fetchSessionInfo(instanceId, event.data.sessionID, event.location?.directory)
      withSession(instanceId, event.data.sessionID, (session) => { session.agent = event.data.agent })
      return
    case "session.model.selected":
      if (!sessions().get(instanceId)?.has(event.data.sessionID)) void fetchSessionInfo(instanceId, event.data.sessionID, event.location?.directory)
      withSession(instanceId, event.data.sessionID, (session) => {
        session.model = { providerId: event.data.model.providerID, modelId: event.data.model.id }
      })
      return
    case "session.usage.updated":
      withSession(instanceId, event.data.sessionID, (session) => {
        session.cost = event.data.cost as unknown as number
        session.tokens = event.data.tokens as Session["tokens"]
      })
      return
    case "session.moved":
      handleSessionMoved(instanceId, event.data.sessionID, event.data.location.directory)
      return
    case "session.forked":
      void fetchSessionInfo(instanceId, event.data.sessionID, event.location?.directory)
      return
    case "session.compaction.started":
      advanceNativeLifecycle(instanceId, event.data.sessionID)
      ensureSessionStatus(instanceId, event.data.sessionID, "compacting", event.location?.directory)
      return
    case "session.compaction.failed":
      void reconcileTerminalNativeSessionStatus(instanceId, event.data.sessionID, {
        failed: true,
        directory: event.location?.directory,
      })
      return
    case "session.execution.interrupted":
      void reconcileTerminalNativeSessionStatus(instanceId, event.data.sessionID, {
        failed: true,
        interrupted: true,
        refreshMessages: true,
        directory: event.location?.directory,
      })
      return
    case "session.execution.succeeded":
      void reconcileTerminalNativeSessionStatus(instanceId, event.data.sessionID, {
        failed: false,
        directory: event.location?.directory,
      })
      return
  }

  if (!event.type.startsWith("session.")) return
  const sessionId = "sessionID" in event.data ? event.data.sessionID : undefined
  if (!sessionId) return
  if (
    event.type === "session.execution.started" ||
    event.type === "session.step.started" ||
    event.type === "session.step.streamed" ||
    event.type.startsWith("session.text.") ||
    event.type.startsWith("session.reasoning.") ||
    event.type.startsWith("session.tool.")
  ) {
    advanceNativeLifecycle(instanceId, sessionId)
    ensureSessionStatus(instanceId, sessionId, "working", event.location?.directory)
  }
}

async function reconcileTerminalNativeSessionStatus(
  instanceId: string,
  sessionId: string,
  options: { failed: boolean; interrupted?: boolean; refreshMessages?: boolean; directory?: string },
): Promise<void> {
  const generation = advanceNativeLifecycle(instanceId, sessionId)
  let activeSessions: Record<string, unknown> | null = null
  try {
    activeSessions = await getRootClient(instanceId).session.active()
  } catch (error) {
    log.warn("Failed to reconcile terminal session state", { instanceId, sessionId, error })
  }
  if (!isCurrentNativeLifecycle(instanceId, sessionId, generation)) return

  if (activeSessions && Object.prototype.hasOwnProperty.call(activeSessions, sessionId)) {
    withSession(instanceId, sessionId, (session) => { session.generationRecovery = null })
    const existing = sessions().get(instanceId)?.get(sessionId)
    if (existing) setSessionStatus(instanceId, sessionId, "working", { force: true })
    else ensureSessionStatus(instanceId, sessionId, "working", options.directory)
    return
  }

  if (options.interrupted) {
    withSession(instanceId, sessionId, (session) => { session.generationRecovery = "interrupted" })
  }
  setTerminalNativeSessionStatus(instanceId, sessionId, options.failed, options.directory)
  if (options.refreshMessages) {
    void loadMessages(instanceId, sessionId, { force: true }).catch((error) => {
      log.warn("Failed to refresh interrupted session messages", { instanceId, sessionId, error })
    })
  }
}

function setTerminalNativeSessionStatus(instanceId: string, sessionId: string, failed: boolean, directory?: string): void {
  const existing = sessions().get(instanceId)?.get(sessionId)
  if (existing) setSessionStatus(instanceId, sessionId, "idle", { force: true })
  else ensureSessionStatus(instanceId, sessionId, "idle", directory)
  if (failed) messageStoreBus.getOrCreate(instanceId).failPendingSends(sessionId)
  speakCompletedAssistantText(instanceId, sessionId)
}

function handleSessionMoved(sourceInstanceId: string, sessionId: string, directory: string): void {
  const normalized = directory.replace(/\\/g, "/").toLowerCase()
  const targetInstanceId = Array.from(instances().values()).find((instance) => {
    const directories = [instance.folder, ...getWorktrees(instance.id).map((worktree) => worktree.directory)]
    return directories.some((candidate) => candidate.replace(/\\/g, "/").toLowerCase() === normalized)
  })?.id

  if (!targetInstanceId || targetInstanceId === sourceInstanceId) {
    void fetchSessions(sourceInstanceId, { reset: true })
    return
  }

  const moved = sessions().get(sourceInstanceId)?.get(sessionId)
  setSessions((previous) => {
    const next = new Map(previous)
    const source = new Map(next.get(sourceInstanceId) ?? [])
    source.delete(sessionId)
    if (source.size) next.set(sourceInstanceId, source)
    else next.delete(sourceInstanceId)
    if (moved) {
      const target = new Map(next.get(targetInstanceId) ?? [])
      target.set(sessionId, { ...moved, instanceId: targetInstanceId, location: { directory } })
      next.set(targetInstanceId, target)
    }
    return next
  })
  removeSessionListId(sourceInstanceId, sessionId)
  if (moved && !moved.parentId) prependSessionListId(targetInstanceId, sessionId)
  messageStoreBus.getOrCreate(sourceInstanceId).clearSession(sessionId)
  void Promise.allSettled([
    fetchSessions(sourceInstanceId, { reset: true }),
    fetchSessions(targetInstanceId, { reset: true }),
  ]).then(() => {
    setSessions((previous) => {
      const current = previous.get(sourceInstanceId)
      if (!current?.has(sessionId)) return previous
      const next = new Map(previous)
      const source = new Map(current)
      source.delete(sessionId)
      if (source.size) next.set(sourceInstanceId, source)
      else next.delete(sourceInstanceId)
      return next
    })
    removeSessionListId(sourceInstanceId, sessionId)
  })
}

function shouldSendOsNotification(kind: "needsInput" | "idle"): boolean {
  if (typeof document === "undefined") return false
  const pref = preferences()
  if (!pref.osNotificationsEnabled) return false
  if (!pref.osNotificationsAllowWhenVisible && document.visibilityState === "visible") return false
  if (kind === "needsInput") return Boolean(pref.notifyOnNeedsInput)
  if (kind === "idle") return Boolean(pref.notifyOnIdle)
  return false
}

function isChildSession(instanceId: string, sessionId: string): boolean | null {
  const session = sessions().get(instanceId)?.get(sessionId)
  if (!session) return null
  return session.parentId !== null && session.parentId !== undefined
}

function shouldSendOsNotificationForSession(
  kind: "needsInput" | "idle",
  instanceId: string,
  sessionId: string | undefined | null,
): boolean {
  if (!shouldSendOsNotification(kind)) return false
  if (!sessionId) return true

  const child = isChildSession(instanceId, sessionId)

  // Avoid notification spam from spawned child/subagent sessions arriving before hydration.
  if (child === null) return false
  if (child) return false

  return true
}

function getInstanceDisplayName(instanceId: string): string {
  const instanceFolder = instances().get(instanceId)?.folder ?? instanceId
  return instanceFolder.split(/[\\/]/).filter(Boolean).pop() ?? instanceFolder
}

function getSessionTitle(instanceId: string, sessionId: string | undefined | null): string {
  if (!sessionId) return ""
  const session = sessions().get(instanceId)?.get(sessionId)
  const title = session?.title?.trim()
  return title && title.length > 0 ? title : sessionId
}

function fireOsNotification(payload: { title: string; body: string }) {
  void sendOsNotification(payload).catch((error) => {
    log.warn("Failed to send OS notification", error)
  })
}

queueMicrotask(() => {
  setPendingFormAddedHandler((instanceId, form) => {
    if (!shouldSendOsNotificationForSession("needsInput", instanceId, form.sessionID)) return
    fireOsNotification({
      title: getInstanceDisplayName(instanceId),
      body: tGlobal("settings.notifications.events.needsInput"),
    })
  })
})

const ALLOWED_TOAST_VARIANTS = new Set<ToastVariant>(["info", "success", "warning", "error"])

async function fetchSessionInfo(instanceId: string, sessionId: string, directory?: string): Promise<Session | null> {
  const instance = instances().get(instanceId)
  if (!instance?.client) return null

  const client = getRootClient(instanceId)
  void directory

  try {
    const info = await client.session.get({ sessionID: sessionId })
    const fetched = createClientSession(info, instanceId)

    let updatedInstanceSessions: Map<string, Session> | undefined
    let shouldExpandAncestors = false

    setSessions((prev) => {
      const next = new Map(prev)
      const instanceSessions = next.get(instanceId) ?? new Map<string, Session>()
      const existing = instanceSessions.get(sessionId)
      const compacting = existing?.status === "compacting"
      const candidate: Session = {
        ...fetched,
        agent: existing?.agent ?? fetched.agent,
        model: existing?.model ?? fetched.model,
        status: compacting ? "compacting" : fetched.status,
        retry: compacting ? null : fetched.retry,
        idleSince: getIdleSinceForStatusTransition(existing?.status, compacting ? "compacting" : fetched.status, existing?.idleSince),
        pendingPermission: existing?.pendingPermission ?? fetched.pendingPermission,
        pendingForm: existing?.pendingForm ?? false,
        runtimeStatusKnown: compacting || existing?.runtimeStatusKnown || false,
      }
      const merged = mergeFetchedSessionRuntimeState(
        candidate,
        existing,
        existing,
        getAuthoritativelyDeletedSessionIdsForInstance(instanceId).has(sessionId),
      )
      if (!merged) return prev
      instanceSessions.set(sessionId, merged)
      next.set(instanceId, instanceSessions)
      updatedInstanceSessions = instanceSessions

      if (merged.parentId && merged.status === "working" && (existing?.status ?? "idle") !== "working") {
        shouldExpandAncestors = true
      }
      return next
    })

    syncInstanceSessionIndicator(instanceId, updatedInstanceSessions)
    reconcilePendingSessionIndicators(instanceId)

    if (shouldExpandAncestors) ensureSessionAncestorsExpanded(instanceId, sessionId)

    return fetched
  } catch (error) {
    log.error("Failed to fetch session info", error)
    return null
  }
}

function ensureSessionStatus(
  instanceId: string,
  sessionId: string,
  status: SessionStatus,
  directory?: string,
  retry?: SessionRetryState | null,
) {
  const existing = sessions().get(instanceId)?.get(sessionId)
  if (existing) {
    setSessionStatus(instanceId, sessionId, status, { retry })
    return
  }

  const key = `${instanceId}:${sessionId}`
  const existingFetch = pendingSessionFetches.get(key)
  if (existingFetch) {
    existingFetch.status = status
    existingFetch.retry = retry
    return
  }

  const pendingState = { status, retry }
  const pending = (async () => {
    const fetched = await fetchSessionInfo(instanceId, sessionId, directory)
    if (!fetched) return
    setSessionStatus(instanceId, sessionId, pendingState.status, { retry: pendingState.retry })
  })()

  pendingSessionFetches.set(key, pendingState)
  void pending.finally(() => {
    if (pendingSessionFetches.get(key) === pendingState) pendingSessionFetches.delete(key)
  })
}

function handleSessionUpdate(
  instanceId: string,
  event: SessionCreated | SessionRevertStaged | SessionRevertCleared | SessionRevertCommitted,
): void {
  if (event.type !== "session.created") {
    const revert = event.type === "session.revert.staged" ? event.data.revert : null
    setSessionRevertV2(instanceId, event.data.sessionID, revert)
    withSession(instanceId, event.data.sessionID, (session) => {
      session.revert = revert ?? undefined
    })
    return
  }

  const info = {
    ...event.data,
    id: event.data.sessionID,
    time: { created: event.created, updated: event.created },
  }
  if (getAuthoritativelyDeletedSessionIdsForInstance(instanceId).has(info.id)) return

  const instanceSessions = sessions().get(instanceId) ?? new Map<string, Session>()

  const existingSession = instanceSessions.get(info.id)

  if (!existingSession) {
    const newSession = {
      id: info.id,
      instanceId,
      title: info.title || tGlobal("sessionList.session.untitled"),
      parentId: info.parentID || null,
      agent: info.agent ?? "",
      model: info.model
        ? { providerId: info.model.providerID, modelId: info.model.id }
        : { providerId: "", modelId: "" },
      status: "idle",
      retry: null,
      idleSince: null,
      version: info.version || "0",
      projectID: (info as any).projectID ?? "",
      metadata: info.metadata,
      cost: (info as any).cost ?? 0,
      tokens: (info as any).tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      location: (info as any).location ?? { directory: instances().get(instanceId)?.folder ?? "" },
      time: info.time
        ? { ...info.time }
        : {
            created: Date.now(),
            updated: Date.now(),
          },
    } as Session

    let updatedInstanceSessions: Map<string, Session> | undefined

    setSessions((prev) => {
      const next = new Map(prev)
      const instanceSessions = next.get(instanceId) ?? new Map<string, Session>()
      instanceSessions.set(newSession.id, newSession)
      next.set(instanceId, instanceSessions)
      updatedInstanceSessions = instanceSessions
      return next
    })

    syncInstanceSessionIndicator(instanceId, updatedInstanceSessions)
    if (!newSession.parentId) {
      prependSessionListId(instanceId, newSession.id)
    }

    log.info(`[SSE] New session created: ${info.id}`, newSession)
  } else {
    const mergedTime = {
      ...existingSession.time,
      ...(info.time ?? {}),
    }
    const updatedSession = {
      ...existingSession,
      title: info.title || existingSession.title,
      parentId: info.parentID ?? existingSession.parentId,
      metadata: info.metadata ?? existingSession.metadata,
      status: existingSession.status ?? "idle",
      retry: existingSession.retry ?? null,
      time: mergedTime,
    }

    let updatedInstanceSessions: Map<string, Session> | undefined

    setSessions((prev) => {
      const next = new Map(prev)
      const instanceSessions = next.get(instanceId) ?? new Map<string, Session>()
      instanceSessions.set(existingSession.id, updatedSession)
      next.set(instanceId, instanceSessions)
      updatedInstanceSessions = instanceSessions
      return next
    })

    syncInstanceSessionIndicator(instanceId, updatedInstanceSessions)
  }
  reconcilePendingSessionIndicators(instanceId)
}

function handleSessionDeleted(instanceId: string, event: EventSessionDeleted): void {
  const sessionId = event.data?.sessionID
  if (!sessionId) return

  log.info(`[SSE] Session deleted: ${sessionId}`)
  nativeLifecycleGenerations.delete(`${instanceId}\0${sessionId}`)
  removeSessionRuntimeState(instanceId, sessionId)
}

function handleSessionIdle(instanceId: string, event: SessionIdle): void {
  const sessionId = event.data.sessionID
  if (!sessionId) return

  advanceNativeLifecycle(instanceId, sessionId)
  if (shouldSendOsNotificationForSession("idle", instanceId, sessionId)) {
    const title = getInstanceDisplayName(instanceId)
    const label = getSessionTitle(instanceId, sessionId)
    const body = label ? `Session "${label}" is idle` : "Session is idle"
    fireOsNotification({ title, body })
  }

  ensureSessionStatus(instanceId, sessionId, "idle", event.location?.directory)
  speakCompletedAssistantText(instanceId, sessionId)
  log.info(`[SSE] Session idle: ${sessionId}`)
}

function handleSessionStatus(instanceId: string, event: SessionStatusUpdated): void {
  const sessionId = event.data.sessionID
  if (!sessionId) return

  advanceNativeLifecycle(instanceId, sessionId)
  const rawStatus = event.data.status
  const status = mapSdkSessionStatus(rawStatus)
  const retry = mapSdkSessionRetry(rawStatus)
  ensureSessionStatus(instanceId, sessionId, status, event.location?.directory, retry)
  if (retry) {
    const remainingSeconds = Math.max(0, Math.round((retry.next - Date.now()) / 1000))
    const countdown =
      remainingSeconds > 0
        ? tGlobal("sessionList.status.retryingIn", { seconds: String(remainingSeconds) })
        : tGlobal("sessionList.status.retrying")
    const label = getSessionTitle(instanceId, sessionId)
    activeRetryToast?.dismiss()
    activeRetryToast = showToastNotification({
      title: label || getInstanceDisplayName(instanceId),
      message: tGlobal("sessionList.status.retryToast", {
        countdown,
        message: retry.message,
        attempt: String(retry.attempt),
      }),
      variant: "error",
      duration: 7000,
    })
  }
  log.info(`[SSE] Session status updated: ${sessionId}`, { status })
}

function handleSessionCompacted(instanceId: string, event: SessionCompactionEnded): void {
  const sessionID = event.data.sessionID
  if (!sessionID) return

  log.info(`[SSE] Session compacted: ${sessionID}`)
  advanceNativeLifecycle(instanceId, sessionID)

  const existing = sessions().get(instanceId)?.get(sessionID)
  if (existing) setSessionStatus(instanceId, sessionID, "working", { force: true })
  else ensureSessionStatus(instanceId, sessionID, "working", event.location?.directory)

  const instanceSessions = sessions().get(instanceId)
  const session = instanceSessions?.get(sessionID)
  const label = session?.title?.trim() ? session.title : sessionID
  const instanceFolder = instances().get(instanceId)?.folder ?? instanceId
  const instanceName = instanceFolder.split(/[\\/]/).filter(Boolean).pop() ?? instanceFolder
  const displayLabel = label ? `"${label}"` : sessionID

  showToastNotification({
    title: instanceName,
    message: tGlobal("sessionEvents.sessionCompactedToast", { label: displayLabel }),
    variant: "info",
    duration: 10000,
  })
}

function handleSessionError(instanceId: string, event: SessionExecutionFailed): void {
  const error = event.data.error
  const sessionId = event.data.sessionID
  if (sessionId) {
    void reconcileTerminalNativeSessionStatus(instanceId, sessionId, {
      failed: true,
      directory: event.location?.directory,
    })
  }
  log.error(`[SSE] Session error:`, error)

  let message = tGlobal("sessionEvents.sessionError.unknown")

  if (error) {
    if ("data" in error && error.data && typeof error.data === "object" && "message" in error.data) {
      message = error.data.message as string
    } else if ("message" in error && typeof error.message === "string") {
      message = error.message
    }
  }

  showAlertDialog(tGlobal("sessionEvents.sessionError.message", { message }), {
    title: tGlobal("sessionEvents.sessionError.title"),
    variant: "error",
  })
}

function handleTuiToast(_instanceId: string, event: TuiToastShow): void {
  const payload = event.data
  if (!payload || typeof payload.message !== "string" || typeof payload.variant !== "string") return
  if (!payload.message.trim()) return

  const variant: ToastVariant = ALLOWED_TOAST_VARIANTS.has(payload.variant as ToastVariant)
    ? (payload.variant as ToastVariant)
    : "info"

  showToastNotification({
    title: typeof payload.title === "string" ? payload.title : undefined,
    message: payload.message,
    variant,
    duration: typeof payload.duration === "number" ? payload.duration : undefined,
  })
}

function handlePermissionUpdated(instanceId: string, event: PermissionAsked): void {
  const permission = event.data as PermissionRequest
  if (!permission) return
  const permissionId = getPermissionId(permission)
  if (!permissionId) return
  if (hasRepliedPermission(instanceId, permissionId)) {
    log.info(`[SSE] Ignoring stale permission request after local reply: ${permissionId}`)
    return
  }
  log.info(`[SSE] Permission request: ${permissionId} (${getPermissionKind(permission)})`)

  const sessionId = getPermissionSessionId(permission)

  if (shouldSendOsNotificationForSession("needsInput", instanceId, sessionId)) {
    const title = getInstanceDisplayName(instanceId)
    const label = getSessionTitle(instanceId, sessionId)
    const body = label ? `Session "${label}" needs permission` : "Session needs permission"
    fireOsNotification({ title, body })
  }
}

function handlePermissionReplied(instanceId: string, event: PermissionReplied): void {
  const requestId = getRequestIdFromPermissionReply(event.data)
  if (!requestId) return

  log.info(`[SSE] Permission replied: ${requestId}`)
  markPermissionReplied(instanceId, requestId)
}

export {
  handleNativeSessionEvent,
  handlePermissionReplied,
  handlePermissionUpdated,
  handleSessionCompacted,
  handleSessionDeleted,
  handleSessionError,
  handleSessionIdle,
  handleSessionStatus,
  handleSessionUpdate,
  handleTuiToast,
}
