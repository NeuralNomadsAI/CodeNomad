import { batch } from "solid-js"
import type {
  MessageInfo,
  MessagePartRemovedEvent,
  MessagePartDeltaEvent,
  MessagePartUpdatedEvent,
  MessageRemovedEvent,
  MessageUpdateEvent,
} from "../types/message"
import type {
  EventSessionCompacted,
  EventSessionDiff,
  EventSessionError,
  EventSessionIdle,
  EventSessionUpdated,
  EventSessionStatus,
} from "@opencode-ai/sdk"
import type { MessageStatus } from "./message-v2/types"

import { getLogger } from "../lib/logger"
import { requestData } from "../lib/opencode-api"
import {
  getPermissionId,
  getPermissionKind,
  getPermissionSessionId,
  getRequestIdFromPermissionReply,
} from "../types/permission"
import type { PermissionReplyEventPropertiesLike, PermissionRequestLike } from "../types/permission"
import { getQuestionId, getQuestionSessionId, getRequestIdFromQuestionReply } from "../types/question"
import type { QuestionRequest } from "../types/question"
import type { EventQuestionReplied, EventQuestionRejected } from "@opencode-ai/sdk/v2"
import { showToastNotification, type ToastHandle, ToastVariant } from "../lib/notifications"
import { sendOsNotification } from "../lib/os-notifications"
import { preferences } from "./preferences"
import {
  instances,
  addPermissionToQueue,
  removePermissionFromQueue,
  addQuestionToQueue,
  removeQuestionFromQueue,
} from "./instances"
import { showAlertDialog } from "./alerts"
import {
  createClientSession,
  mapSdkSessionRetry,
  mapSdkSessionStatus,
  type Session,
  type SessionRetryState,
  type SessionStatus,
} from "../types/session"
import { ensureSessionParentExpanded, sessions, setSessions, syncInstanceSessionIndicator, withSession } from "./session-state"
import { normalizeMessagePart } from "./message-v2/normalizers"
import { updateSessionInfo } from "./message-v2/session-info"
import { tGlobal } from "../lib/i18n"
import { handleConversationAssistantPartUpdated } from "./conversation-speech"
import {
  appendAssistantStreamChunk,
  clearAssistantStreamMessage,
  clearAssistantStreamPart,
  clearAssistantStreamSession,
  getAssistantStreamPreviewText,
} from "./assistant-stream"
import type { AssistantStreamChunkEvent } from "../lib/event-transport-contract"

import { loadMessages } from "./session-api"
import { getOrCreateWorktreeClient, getRootClient, getWorktreeSlugForDirectory, getWorktreeSlugForSession } from "./worktrees"
import {
  applyPartUpdateV2,
  applyPartDeltaV2,
  replaceMessageIdV2,
  reconcilePendingQuestionsV2,
  upsertMessageInfoV2,
  upsertPermissionV2,
  upsertQuestionV2,
  removeMessagePartV2,
  removeMessageV2,
  removePermissionV2,
  removeQuestionV2,
  setSessionRevertV2,
} from "./message-v2/bridge"
import { messageStoreBus } from "./message-v2/bus"
import type { InstanceMessageStore } from "./message-v2/instance-store"

const log = getLogger("sse")
const pendingSessionFetches = new Map<string, Promise<void>>()
let activeRetryToast: ToastHandle | null = null

function isSameRetryState(left: SessionRetryState | null | undefined, right: SessionRetryState | null | undefined): boolean {
  const a = left ?? null
  const b = right ?? null
  if (a === b) return true
  if (!a || !b) return false
  return a.attempt === b.attempt && a.message === b.message && a.next === b.next
}

const pendingSessionInfoUpdates = new Set<string>()
let sessionInfoFlushQueued = false
const pendingPartDeltas = new Map<string, {
  instanceId: string
  messageId: string
  partId: string
  field: string
  delta: string
}>()
let partDeltaFlushTask: number | null = null

function flushPendingSessionInfoUpdates() {
  sessionInfoFlushQueued = false
  if (pendingSessionInfoUpdates.size === 0) {
    return
  }

  const pending = Array.from(pendingSessionInfoUpdates)
  pendingSessionInfoUpdates.clear()

  batch(() => {
    for (const entry of pending) {
      const [instanceId, sessionId] = entry.split(":")
      if (!instanceId || !sessionId) continue
      updateSessionInfo(instanceId, sessionId)
    }
  })
}

function scheduleSessionInfoUpdate(instanceId: string, sessionId: string) {
  if (!instanceId || !sessionId) {
    return
  }

  pendingSessionInfoUpdates.add(`${instanceId}:${sessionId}`)
  if (sessionInfoFlushQueued) {
    return
  }

  sessionInfoFlushQueued = true
  queueMicrotask(flushPendingSessionInfoUpdates)
}

function makeQueuedPartDeltaKey(instanceId: string, messageId: string, partId: string, field: string) {
  return `${instanceId}:${messageId}:${partId}:${field}`
}

function clearScheduledPartDeltaFlush() {
  if (partDeltaFlushTask === null) {
    return
  }

  window.clearTimeout(partDeltaFlushTask)
  partDeltaFlushTask = null
}

function flushQueuedPartDeltas(
  predicate?: (entry: { instanceId: string; messageId: string; partId: string; field: string; delta: string }) => boolean,
) {
  if (pendingPartDeltas.size === 0) {
    return
  }

  const entries: Array<{ instanceId: string; messageId: string; partId: string; field: string; delta: string }> = []

  for (const [key, entry] of pendingPartDeltas) {
    if (predicate && !predicate(entry)) {
      continue
    }
    entries.push(entry)
    pendingPartDeltas.delete(key)
  }

  if (entries.length === 0) {
    return
  }

  if (pendingPartDeltas.size === 0) {
    clearScheduledPartDeltaFlush()
  }

  batch(() => {
    for (const entry of entries) {
      applyPartDeltaV2(entry.instanceId, {
        messageId: entry.messageId,
        partId: entry.partId,
        field: entry.field,
        delta: entry.delta,
      })
    }
  })
}

function flushQueuedPartDeltasForMessage(instanceId: string, messageId: string) {
  flushQueuedPartDeltas((entry) => entry.instanceId === instanceId && entry.messageId === messageId)
}

function flushQueuedPartDeltasForPart(instanceId: string, messageId: string, partId: string) {
  flushQueuedPartDeltas((entry) => entry.instanceId === instanceId && entry.messageId === messageId && entry.partId === partId)
}

/** Cadence for flushing coalesced deltas to the store (ms).
 * 48ms (~3 frames) keeps heavy store-driven re-renders (Markdown, block
 * layout) throttled while still delivering timely updates. */
const DELTA_FLUSH_INTERVAL_MS = 48

function scheduleQueuedPartDeltaFlush() {
  if (partDeltaFlushTask !== null) {
    return
  }

  partDeltaFlushTask = window.setTimeout(() => {
    partDeltaFlushTask = null
    flushQueuedPartDeltas()
  }, DELTA_FLUSH_INTERVAL_MS)
}

function queueMessagePartDelta(instanceId: string, event: MessagePartDeltaEvent) {
  const props = event.properties
  if (!props) return

  const { messageID, partID, field, delta } = props
  if (!messageID || !partID || !field || typeof delta !== "string" || delta.length === 0) return

  const key = makeQueuedPartDeltaKey(instanceId, messageID, partID, field)
  const existing = pendingPartDeltas.get(key)
  if (existing) {
    existing.delta += delta
  } else {
    pendingPartDeltas.set(key, {
      instanceId,
      messageId: messageID,
      partId: partID,
      field,
      delta,
    })
  }

  scheduleQueuedPartDeltaFlush()
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

interface TuiToastEvent {
  type: "tui.toast.show"
  properties: {
    title?: string
    message: string
    variant: "info" | "success" | "warning" | "error"
    duration?: number
  }
}

const ALLOWED_TOAST_VARIANTS = new Set<ToastVariant>(["info", "success", "warning", "error"])

function applySessionStatus(instanceId: string, sessionId: string, status: SessionStatus, retry?: SessionRetryState | null) {
  let parentToExpand: string | null = null

  withSession(instanceId, sessionId, (session) => {
    const current = session.status ?? "idle"
    const nextRetry = retry ?? null
    if (current === status && isSameRetryState(session.retry, nextRetry)) return false

    // While compacting, only allow transitions to "idle" (abort / session end)
    // or staying in "compacting".  Block "compacting -> working" so the
    // compaction UI isn't prematurely replaced by the normal busy indicator.
    if (current === "compacting" && status !== "compacting" && status !== "idle") {
      return false
    }

    session.status = status
    session.retry = status === "working" ? nextRetry : null

    // Auto-expand the parent thread when a child session starts working.
    // Users can still collapse it; we only expand on the transition.
    if (session.parentId && status === "working" && current !== "working") {
      parentToExpand = session.parentId
    }
  })

  if (parentToExpand) {
    ensureSessionParentExpanded(instanceId, parentToExpand)
  }
}

async function fetchSessionInfo(instanceId: string, sessionId: string, directory?: string): Promise<Session | null> {
  const instance = instances().get(instanceId)
  if (!instance?.client) return null

  const slugFromDirectory = getWorktreeSlugForDirectory(instanceId, directory)
  const slug = slugFromDirectory ?? getWorktreeSlugForSession(instanceId, sessionId)
  const client = getOrCreateWorktreeClient(instanceId, slug)
  const rootClient = getRootClient(instanceId)

  try {
    const info = await requestData<any>(
      client.session.get({ sessionID: sessionId }),
      "session.get",
    )

    let fetchedStatus: SessionStatus = "idle"
    let fetchedRetry: SessionRetryState | null = null
    try {
      let statuses: Record<string, any> = {}
      try {
        statuses = await requestData<Record<string, any>>(rootClient.session.status(), "session.status")
      } catch {
        statuses = await requestData<Record<string, any>>(client.session.status(), "session.status")
      }
      // Session status is global-ish; prefer the root context when available.
      // (OpenCode may scope status by directory in older builds.)
      // If root fails, fall back to the worktree-scoped client.
      //
      // Note: requestData throws on error, so we catch below.
      const rawStatus = (info as any)?.status ?? statuses?.[sessionId]
      const hasType = rawStatus && typeof rawStatus === "object" && typeof rawStatus.type === "string"
      fetchedStatus = hasType ? mapSdkSessionStatus(rawStatus) : "idle"
      fetchedRetry = hasType ? mapSdkSessionRetry(rawStatus) : null
    } catch (error) {
      log.error("Failed to fetch session status", error)
    }

    const fetched = createClientSession(info, instanceId, "", { providerId: "", modelId: "" }, fetchedStatus)
    fetched.retry = fetchedRetry

    let updatedInstanceSessions: Map<string, Session> | undefined
    let shouldExpandParent: string | null = null

    setSessions((prev) => {
      const next = new Map(prev)
      const instanceSessions = next.get(instanceId) ?? new Map<string, Session>()
      const existing = instanceSessions.get(sessionId)
      const merged: Session = {
        ...fetched,
        agent: existing?.agent ?? fetched.agent,
        model: existing?.model ?? fetched.model,
        status: existing?.status === "compacting" && fetched.status !== "idle" ? "compacting" : fetched.status,
        retry: existing?.status === "compacting" && fetched.status !== "idle" ? null : fetched.retry,
        pendingPermission: existing?.pendingPermission ?? fetched.pendingPermission,
        pendingQuestion: existing?.pendingQuestion ?? false,
      }
      instanceSessions.set(sessionId, merged)
      next.set(instanceId, instanceSessions)
      updatedInstanceSessions = instanceSessions

      if (merged.parentId && merged.status === "working" && (existing?.status ?? "idle") !== "working") {
        shouldExpandParent = merged.parentId
      }
      return next
    })

    syncInstanceSessionIndicator(instanceId, updatedInstanceSessions)

    if (shouldExpandParent) {
      ensureSessionParentExpanded(instanceId, shouldExpandParent)
    }

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
  const instanceSessions = sessions().get(instanceId)
  const existing = instanceSessions?.get(sessionId)
  if (existing) {
    if ((existing.status ?? "idle") === status && isSameRetryState(existing.retry, retry)) {
      return
    }
    applySessionStatus(instanceId, sessionId, status, retry)
    return
  }

  const key = `${instanceId}:${sessionId}`
  if (pendingSessionFetches.has(key)) {
    return
  }

  const pending = (async () => {
    const fetched = await fetchSessionInfo(instanceId, sessionId, directory)
    if (!fetched) return
    applySessionStatus(instanceId, sessionId, status, retry)
  })()

  pendingSessionFetches.set(key, pending)
  void pending.finally(() => pendingSessionFetches.delete(key))
}

type MessageRole = "user" | "assistant"


function resolveMessageRole(info?: MessageInfo | null): MessageRole {
  return info?.role === "user" ? "user" : "assistant"
}

function findPendingSyntheticMessageId(
  store: InstanceMessageStore,
  sessionId: string,
  role: MessageRole,
): string | undefined {
  return store.getPendingSyntheticMessageId(sessionId, role)
}

function handleMessageUpdate(instanceId: string, event: MessageUpdateEvent | MessagePartUpdatedEvent): void {
  const instanceSessions = sessions().get(instanceId)

  if (event.type === "message.part.updated") {
    const rawPart = event.properties?.part
    if (!rawPart) return
 
    const part = normalizeMessagePart(rawPart)
    const messageInfo = (event as any)?.properties?.message as MessageInfo | undefined
 
    const fallbackSessionId = typeof messageInfo?.sessionID === "string" ? messageInfo.sessionID : undefined
    const fallbackMessageId = typeof messageInfo?.id === "string" ? messageInfo.id : undefined
 
    const sessionId = typeof part.sessionID === "string" ? part.sessionID : fallbackSessionId
    const messageId = typeof part.messageID === "string" ? part.messageID : fallbackMessageId
    if (!sessionId || !messageId) return
    if (typeof part.id === "string" && part.id.length > 0) {
      flushQueuedPartDeltasForPart(instanceId, messageId, part.id)
    } else {
      flushQueuedPartDeltasForMessage(instanceId, messageId)
    }
    if (part.type === "compaction") {
      ensureSessionStatus(instanceId, sessionId, "compacting", (event as any)?.directory)
    }

    const store = messageStoreBus.getOrCreate(instanceId)
    const role: MessageRole = resolveMessageRole(messageInfo)
    const createdAt = typeof messageInfo?.time?.created === "number" ? messageInfo.time.created : Date.now()
    const previousText =
      role === "assistant" && part.type === "text"
        ? (() => {
            const existingRecord = store.getMessage(messageId)
            const existingPart = existingRecord?.parts[part.id]?.data as { text?: unknown } | undefined
            return typeof existingPart?.text === "string" ? existingPart.text : ""
          })()
        : ""
    const previousPreviewText =
      role === "assistant" && part.type === "text"
        ? getAssistantStreamPreviewText(instanceId, sessionId, messageId, part.id) ?? ""
        : ""
    const previousVisibleText =
      previousPreviewText.length > previousText.length ? previousPreviewText : previousText


    batch(() => {
      let record = store.getMessage(messageId)
      if (!record) {
        const pendingId = findPendingSyntheticMessageId(store, sessionId, role)
        if (pendingId && pendingId !== messageId) {
          // PERF: Never clear parts during ID swap. The synthetic (optimistic) parts
          // stay visible until the server parts arrive via applyPartUpdateV2.
          // Clearing them causes a visible flash in WebView2 because the ID change
          // forces a component re-mount, and empty parts render as blank.
          replaceMessageIdV2(instanceId, pendingId, messageId, { clearParts: false })
          record = store.getMessage(messageId)
        }
      }

      if (!record) {
        store.upsertMessage({
          id: messageId,
          sessionId,
          role,
          status: "streaming",
          createdAt,
          updatedAt: createdAt,
          isEphemeral: true,
        })
      }

      if (messageInfo) {
        upsertMessageInfoV2(instanceId, messageInfo, { status: "streaming" })
      }

      applyPartUpdateV2(instanceId, { ...part, sessionID: sessionId, messageID: messageId })
      handleConversationAssistantPartUpdated(instanceId, { ...part, sessionID: sessionId, messageID: messageId }, messageInfo)

       if (
        role === "assistant" &&
        part.type === "text" &&
        typeof part.text === "string" &&
        part.text.length > previousVisibleText.length &&
        part.text.startsWith(previousVisibleText)
      ) {
        appendAssistantStreamChunk(instanceId, {
          type: "assistant.stream.chunk",
          properties: {
            sessionID: sessionId,
            messageID: messageId,
            partID: part.id,
            field: "text",
            delta: part.text.slice(previousVisibleText.length),
          },
        })
      } else if (
        role === "assistant" &&
        part.type === "text" &&
        typeof part.text === "string" &&
        previousPreviewText.length > 0 &&
        part.text.length >= previousPreviewText.length &&
        part.text.startsWith(previousPreviewText)
      ) {
        clearAssistantStreamPart(instanceId, sessionId, messageId, part.id)
      } else if (
        role === "assistant" &&
        part.type === "text" &&
        previousPreviewText.length > 0
      ) {
        // Server sent a correction/replacement that diverges from the preview.
        // Clear stale preview so the canonical text takes over.
        clearAssistantStreamPart(instanceId, sessionId, messageId, part.id)
      }

      if (part.type === "tool" && part.tool === "question") {
        // Questions can arrive before their tool part exists; re-link now.
        reconcilePendingQuestionsV2(instanceId, sessionId)
      }

      scheduleSessionInfoUpdate(instanceId, sessionId)
    })
  } else if (event.type === "message.updated") {
    const info = event.properties?.info
    if (!info) return

    const sessionId = typeof info.sessionID === "string" ? info.sessionID : undefined
    const messageId = typeof info.id === "string" ? info.id : undefined
    if (!sessionId || !messageId) return
    flushQueuedPartDeltasForMessage(instanceId, messageId)
    // Defer preview clear to after the current synchronous batch completes.
    // Using queueMicrotask (not requestAnimationFrame) so the clear runs within
    // the same JS task — avoiding a one-frame flicker where preview text could
    // reappear between the rAF callback and the next paint.
    queueMicrotask(() => clearAssistantStreamMessage(instanceId, sessionId, messageId))

    const timeInfo = (info.time ?? {}) as { created?: number; updated?: number; end?: number }
    const nextUpdated =
      typeof timeInfo.end === "number" && timeInfo.end > 0
        ? timeInfo.end
        : typeof timeInfo.updated === "number" && timeInfo.updated > 0
          ? timeInfo.updated
          : typeof timeInfo.created === "number" && timeInfo.created > 0
            ? timeInfo.created
            : Date.now()

    batch(() => {
      withSession(instanceId, sessionId, (session) => {
        const currentUpdated = session.time?.updated ?? 0
        if (nextUpdated <= currentUpdated) return false
        session.time = { ...(session.time ?? {}), updated: nextUpdated }
      })

      const store = messageStoreBus.getOrCreate(instanceId)

      const role: MessageRole = info.role === "user" ? "user" : "assistant"
      const hasError = Boolean((info as any).error)
      const status: MessageStatus = hasError ? "error" : "complete"

      let record = store.getMessage(messageId)
      if (!record) {
        const pendingId = findPendingSyntheticMessageId(store, sessionId, role)
        if (pendingId && pendingId !== messageId) {
          replaceMessageIdV2(instanceId, pendingId, messageId, { clearParts: false })
          record = store.getMessage(messageId)
        }
      }

      if (!record) {
        const createdAt = info.time?.created ?? Date.now()
        const endAt = (info.time as { end?: number } | undefined)?.end
        store.upsertMessage({
          id: messageId,
          sessionId,
          role,
          status,
          createdAt,
          updatedAt: endAt ?? createdAt,
        })
      }

      upsertMessageInfoV2(instanceId, info, { status, bumpRevision: true, isEphemeral: false })

      scheduleSessionInfoUpdate(instanceId, sessionId)
    })
  }
}

function handleMessagePartDelta(instanceId: string, event: MessagePartDeltaEvent): void {
  queueMessagePartDelta(instanceId, event)
}

function handleAssistantStreamChunk(instanceId: string, event: AssistantStreamChunkEvent): void {
  const props = event.properties
  if (!props?.sessionID || !props.messageID || !props.partID) {
    return
  }

  // Guard: ignore chunks for sessions that don't exist or are already idle
  // (a stale/delayed chunk could otherwise create ghost ephemeral messages).
  const instanceSessions = sessions().get(instanceId)
  const session = instanceSessions?.get(props.sessionID)
  if (!session || session.status === "idle") {
    return
  }

  const store = messageStoreBus.getOrCreate(instanceId)
  let record = store.getMessage(props.messageID)

  // When the message/part doesn't exist yet, create lightweight ephemeral
  // placeholders.  Wrap both mutations in a batch so SolidJS flushes them
  // atomically — avoiding separate reactive cascades for each mutation.
  if (!record || !record.parts[props.partID]) {
    batch(() => {
      if (!record) {
        store.upsertMessage({
          id: props.messageID,
          sessionId: props.sessionID,
          role: "assistant",
          status: "streaming",
          createdAt: Date.now(),
          updatedAt: Date.now(),
          isEphemeral: true,
          bumpRevision: false,
        })
        record = store.getMessage(props.messageID)
      }

      if (record && !record.parts[props.partID]) {
        applyPartUpdateV2(instanceId, {
          id: props.partID,
          type: "text",
          text: "",
          sessionID: props.sessionID,
          messageID: props.messageID,
        } as any)
      }
    })
  }

  appendAssistantStreamChunk(instanceId, event)
}

function handleSessionUpdate(instanceId: string, event: EventSessionUpdated): void {
  const info = event.properties?.info

  if (!info) return

  const instanceSessions = sessions().get(instanceId) ?? new Map<string, Session>()

  const existingSession = instanceSessions.get(info.id)

  if (!existingSession) {
    const newSession = {
      id: info.id,
      instanceId,
      title: info.title || tGlobal("sessionList.session.untitled"),
      parentId: info.parentID || null,
      agent: "",
      model: {
        providerId: "",
        modelId: "",
      },
      status: "idle",
      retry: null,
      version: info.version || "0",
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
    setSessionRevertV2(instanceId, info.id, info.revert ?? null)

    log.info(`[SSE] New session created: ${info.id}`, newSession)
  } else {
    const mergedTime = {
      ...existingSession.time,
      ...(info.time ?? {}),
    }
    const updatedSession = {
      ...existingSession,
      title: info.title || existingSession.title,
      status: existingSession.status ?? "idle",
      retry: existingSession.retry ?? null,
      time: mergedTime,
      revert: info.revert
        ? {
            messageID: info.revert.messageID,
            partID: info.revert.partID,
            snapshot: info.revert.snapshot,
            diff: info.revert.diff,
          }
        : existingSession.revert,
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
    setSessionRevertV2(instanceId, info.id, info.revert ?? null)
  }
}

function handleSessionDiff(instanceId: string, event: EventSessionDiff): void {
  const sessionId = event.properties?.sessionID
  if (!sessionId) return

  const diffs = event.properties?.diff
  if (!Array.isArray(diffs)) return

  const existing = sessions().get(instanceId)?.get(sessionId)
  if (existing) {
    withSession(instanceId, sessionId, (session) => {
      session.diff = diffs
    })
    return
  }

  // A diff event can arrive before we have hydrated the session list.
  // Best-effort: fetch the session record so the diff has somewhere to live.
  void (async () => {
    await fetchSessionInfo(instanceId, sessionId, (event as any)?.directory)
    withSession(instanceId, sessionId, (session) => {
      session.diff = diffs
    })
  })().catch((error) => log.warn("Failed to hydrate session for diff event", { instanceId, sessionId, error }))
}

function handleSessionIdle(instanceId: string, event: EventSessionIdle): void {
  const sessionId = event.properties?.sessionID
  if (!sessionId) return

  if (shouldSendOsNotificationForSession("idle", instanceId, sessionId)) {
    const title = getInstanceDisplayName(instanceId)
    const label = getSessionTitle(instanceId, sessionId)
    const body = label ? `Session "${label}" is idle` : "Session is idle"
    fireOsNotification({ title, body })
  }

  ensureSessionStatus(instanceId, sessionId, "idle", (event as any)?.directory)

  // Clean up any lingering assistant-stream preview entries for this session.
  // On Tauri this also happens on session switch (App.tsx), but on browser
  // hosts this is the only cleanup path.
  clearAssistantStreamSession(instanceId, sessionId)

  // Safety net: if any ephemeral "sending"/"sent" messages still exist for
  // this session they are orphans (the real server messages never arrived or
  // replaced them).  Reload the full message list so the UI reflects reality.
  const store = messageStoreBus.getOrCreate(instanceId)
  const messageIds = store.getSessionMessageIds(sessionId) ?? []
  const hasOrphanedEphemeral = messageIds.some((id) => {
    const record = store.getMessage(id)
    return record?.isEphemeral && (record.status === "sending" || record.status === "sent")
  })
  if (hasOrphanedEphemeral) {
    log.info(`[SSE] Session idle with orphaned ephemeral messages, reloading: ${sessionId}`)
    loadMessages(instanceId, sessionId, true).catch((error) =>
      log.error("Failed to reload messages after idle with orphaned ephemerals", error),
    )
  }

  log.info(`[SSE] Session idle: ${sessionId}`)
}

function handleSessionStatus(instanceId: string, event: EventSessionStatus): void {
  const sessionId = event.properties?.sessionID
  if (!sessionId) return

  const rawStatus = event.properties.status
  const status = mapSdkSessionStatus(rawStatus)
  const retry = mapSdkSessionRetry(rawStatus)
  ensureSessionStatus(instanceId, sessionId, status, (event as any)?.directory, retry)
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

function handleSessionCompacted(instanceId: string, event: EventSessionCompacted): void {
  const sessionID = event.properties?.sessionID
  if (!sessionID) return

  log.info(`[SSE] Session compacted: ${sessionID}`)

  const existing = sessions().get(instanceId)?.get(sessionID)
  if (existing) {
    withSession(instanceId, sessionID, (session) => {
      session.status = "working"
      session.retry = null
    })
  } else {
    ensureSessionStatus(instanceId, sessionID, "working", (event as any)?.directory)
  }

  loadMessages(instanceId, sessionID, true).catch((error) => log.error("Failed to reload session after compaction", error))

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

function handleSessionError(_instanceId: string, event: EventSessionError): void {
  const error = event.properties?.error
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

function handleMessageRemoved(instanceId: string, event: MessageRemovedEvent): void {
  const { sessionID, messageID } = event.properties
  if (!sessionID || !messageID) return

  log.info(`[SSE] Message removed from session ${sessionID}`, { messageID })
  flushQueuedPartDeltasForMessage(instanceId, messageID)
  clearAssistantStreamMessage(instanceId, sessionID, messageID)
  removeMessageV2(instanceId, messageID)
  scheduleSessionInfoUpdate(instanceId, sessionID)
}

function handleMessagePartRemoved(instanceId: string, event: MessagePartRemovedEvent): void {
  const { sessionID, messageID, partID } = event.properties
  if (!sessionID || !messageID || !partID) return

  log.info(`[SSE] Message part removed from session ${sessionID}`, { messageID, partID })
  flushQueuedPartDeltasForPart(instanceId, messageID, partID)
  clearAssistantStreamPart(instanceId, sessionID, messageID, partID)
  removeMessagePartV2(instanceId, messageID, partID)
  scheduleSessionInfoUpdate(instanceId, sessionID)
}

function handleTuiToast(_instanceId: string, event: TuiToastEvent): void {
  const payload = event?.properties
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

function handlePermissionUpdated(instanceId: string, event: { type: string; properties?: PermissionRequestLike } | any): void {
  const permission = event?.properties as PermissionRequestLike | undefined
  if (!permission) return

  log.info(`[SSE] Permission request: ${getPermissionId(permission)} (${getPermissionKind(permission)})`)
  addPermissionToQueue(instanceId, permission)
  upsertPermissionV2(instanceId, permission)

  const sessionId = getPermissionSessionId(permission)

  if (shouldSendOsNotificationForSession("needsInput", instanceId, sessionId)) {
    const title = getInstanceDisplayName(instanceId)
    const label = getSessionTitle(instanceId, sessionId)
    const body = label ? `Session "${label}" needs permission` : "Session needs permission"
    fireOsNotification({ title, body })
  }
}

function handlePermissionReplied(instanceId: string, event: { type: string; properties?: PermissionReplyEventPropertiesLike } | any): void {
  const properties = event?.properties as PermissionReplyEventPropertiesLike | undefined
  const requestId = getRequestIdFromPermissionReply(properties)
  if (!requestId) return

  log.info(`[SSE] Permission replied: ${requestId}`)
  removePermissionFromQueue(instanceId, requestId)
  removePermissionV2(instanceId, requestId)
}

function handleQuestionAsked(instanceId: string, event: { type: string; properties?: QuestionRequest } | any): void {
  const request = event?.properties as QuestionRequest | undefined
  if (!request) return

  log.info(`[SSE] Question asked: ${getQuestionId(request)}`)
  addQuestionToQueue(instanceId, request)
  upsertQuestionV2(instanceId, request)

  const sessionId = getQuestionSessionId(request)

  if (shouldSendOsNotificationForSession("needsInput", instanceId, sessionId)) {
    const title = getInstanceDisplayName(instanceId)
    const label = getSessionTitle(instanceId, sessionId)
    const body = label ? `Session "${label}" needs input` : "Session needs input"
    fireOsNotification({ title, body })
  }
}

function handleQuestionAnswered(
  instanceId: string,
  event: { type: string; properties?: EventQuestionReplied["properties"] | EventQuestionRejected["properties"] } | any,
): void {
  const properties = event?.properties as EventQuestionReplied["properties"] | EventQuestionRejected["properties"] | undefined
  const requestId = getRequestIdFromQuestionReply(properties)
  if (!requestId) return

  log.info(`[SSE] Question answered: ${requestId}`)
  removeQuestionFromQueue(instanceId, requestId)
  removeQuestionV2(instanceId, requestId)
}

export {
  handleAssistantStreamChunk,
  handleMessagePartRemoved,
  handleMessageRemoved,
  handleMessagePartDelta,
  handleMessageUpdate,
  handlePermissionReplied,
  handlePermissionUpdated,
  handleQuestionAsked,
  handleQuestionAnswered,
  handleSessionCompacted,
  handleSessionDiff,
  handleSessionError,
  handleSessionIdle,
  handleSessionStatus,
  handleSessionUpdate,
  handleTuiToast,
}
