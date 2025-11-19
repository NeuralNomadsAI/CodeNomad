import type {
  MessagePartRemovedEvent,
  MessagePartUpdatedEvent,
  MessageRemovedEvent,
  MessageUpdateEvent,
} from "../types/message"
import type {
  EventPermissionReplied,
  EventPermissionUpdated,
  EventSessionCompacted,
  EventSessionError,
  EventSessionIdle,
  EventSessionUpdated,
  Permission,
} from "@opencode-ai/sdk"

import { showToastNotification, ToastVariant } from "../lib/notifications"
import { preferences } from "./preferences"
import { instances, addPermissionToQueue, removePermissionFromQueue, refreshPermissionsForSession, getPermissionQueue } from "./instances"
import {
  sessions,
  setSessions,
  withSession,
} from "./session-state"
import {
  bumpPartVersion,
  computeDisplayParts,
  getSessionIndex,
  initializePartVersion,
  normalizeMessagePart,
  rebuildSessionIndex,
  updateSessionInfo,
} from "./session-messages"
import { loadMessages } from "./session-api"
import { setSessionCompactionState } from "./session-compaction"

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

function handleMessageUpdate(instanceId: string, event: MessageUpdateEvent | MessagePartUpdatedEvent): void {
  const instanceSessions = sessions().get(instanceId)
  if (!instanceSessions) return

  if (event.type === "message.part.updated") {
    const rawPart = event.properties?.part
    if (!rawPart) return

    const part = normalizeMessagePart(rawPart)

    const session = instanceSessions.get(part.sessionID)
    if (!session) return

    const index = getSessionIndex(instanceId, part.sessionID)
    let messageIndex = index.messageIndex.get(part.messageID)
    let replacedTemp = false

    if (messageIndex === undefined) {
      for (let i = 0; i < session.messages.length; i++) {
        const msg = session.messages[i]
        if (msg.sessionId === part.sessionID && msg.status === "sending") {
          messageIndex = i
          replacedTemp = true
          break
        }
      }
    }

    if (messageIndex === undefined) {
      const newMessage: any = {
        id: part.messageID,
        sessionId: part.sessionID,
        type: "assistant" as const,
        parts: [part],
        timestamp: Date.now(),
        status: "streaming" as const,
        version: 0,
      }

      initializePartVersion(part)
      newMessage.displayParts = computeDisplayParts(newMessage, preferences().showThinkingBlocks)

      let insertIndex = session.messages.length
      for (let i = session.messages.length - 1; i >= 0; i--) {
        if (session.messages[i].id < newMessage.id) {
          insertIndex = i + 1
          break
        }
      }

      session.messages.splice(insertIndex, 0, newMessage)
      rebuildSessionIndex(instanceId, part.sessionID, session.messages)
    } else {
      const message = session.messages[messageIndex]
      if (typeof message.version !== "number") {
        message.version = 0
      }

      let filteredSynthetics = false
      if (message.parts.some((partItem: any) => partItem.synthetic === true)) {
        message.parts = message.parts.filter((partItem: any) => partItem.synthetic !== true)
        filteredSynthetics = true
        message.parts.forEach((partItem: any) => {
          if (partItem.type === "text") {
            partItem.renderCache = undefined
          }
        })
      }

      let baseParts: any[]
      if (replacedTemp) {
        baseParts = message.parts.filter((partItem: any) => partItem.type !== "text")
        message.parts = baseParts
        baseParts.forEach((partItem: any) => {
          if (partItem.type === "text") {
            partItem.renderCache = undefined
          }
        })
      } else {
        baseParts = message.parts
      }

      let partMap = index.partIndex.get(message.id)
      if (!partMap) {
        partMap = new Map()
        index.partIndex.set(message.id, partMap)
      }

      let shouldIncrementVersion = filteredSynthetics || replacedTemp
      const partIndex = partMap.get(part.id)

      if (partIndex === undefined) {
        initializePartVersion(part)
        baseParts.push(part)
        if (part.id && typeof part.id === "string") {
          partMap.set(part.id, baseParts.length - 1)
        }
        shouldIncrementVersion = true
        if (part.type === "text") {
          part.renderCache = undefined
        }
      } else {
        const previousPart = baseParts[partIndex]
        const textUnchanged =
          !filteredSynthetics &&
          !replacedTemp &&
          part.type === "text" &&
          previousPart?.type === "text" &&
          previousPart.text === part.text

        if (textUnchanged) {
          return
        }

        bumpPartVersion(previousPart, part)
        baseParts[partIndex] = part
        if (part.type !== "text" || !previousPart || previousPart.text !== part.text) {
          shouldIncrementVersion = true
          if (part.type === "text") {
            part.renderCache = undefined
          }
        }
      }

      const oldId = message.id
      message.id = replacedTemp ? part.messageID : message.id
      message.status = message.status === "sending" ? "streaming" : message.status
      message.parts = baseParts

      if (shouldIncrementVersion) {
        message.version += 1
        message.displayParts = computeDisplayParts(message, preferences().showThinkingBlocks)
      } else if (
        !message.displayParts ||
        message.displayParts.showThinking !== preferences().showThinkingBlocks ||
        message.displayParts.version !== message.version
      ) {
        message.displayParts = computeDisplayParts(message, preferences().showThinkingBlocks)
      }

      if (oldId !== message.id) {
        index.messageIndex.delete(oldId)
        index.messageIndex.set(message.id, messageIndex)
        const existingPartMap = index.partIndex.get(oldId)
        if (existingPartMap) {
          index.partIndex.delete(oldId)
          index.partIndex.set(message.id, existingPartMap)
        }
      }

      if (filteredSynthetics || replacedTemp) {
        const refreshed = new Map<string, number>()
        message.parts.forEach((partItem, idx) => {
          if (partItem.id && typeof partItem.id === "string") {
            refreshed.set(partItem.id, idx)
          }
        })
        index.partIndex.set(message.id, refreshed)
      }
    }

    withSession(instanceId, part.sessionID, () => {
      /* mutations already applied above */
    })

    updateSessionInfo(instanceId, part.sessionID)
    refreshPermissionsForSession(instanceId, part.sessionID)
  } else if (event.type === "message.updated") {
    const info = event.properties?.info
    if (!info) return

    const session = instanceSessions.get(info.sessionID)
    if (!session) return

    const index = getSessionIndex(instanceId, info.sessionID)
    let messageIndex = index.messageIndex.get(info.id)

    if (messageIndex === undefined) {
      let tempMessageIndex = -1
      for (let i = 0; i < session.messages.length; i++) {
        const msg = session.messages[i]
        if (
          msg.sessionId === info.sessionID &&
          msg.type === (info.role === "user" ? "user" : "assistant") &&
          msg.status === "sending"
        ) {
          tempMessageIndex = i
          break
        }
      }

      if (tempMessageIndex === -1) {
        for (let i = 0; i < session.messages.length; i++) {
          const msg = session.messages[i]
          if (msg.sessionId === info.sessionID && msg.status === "sending") {
            tempMessageIndex = i
            break
          }
        }
      }

      if (tempMessageIndex > -1) {
        const message = session.messages[tempMessageIndex]
        if (typeof message.version !== "number") {
          message.version = 0
        }

        const oldId = message.id
        message.id = info.id
        message.type = (info.role === "user" ? "user" : "assistant") as "user" | "assistant"
        message.timestamp = info.time?.created || Date.now()
        message.status = "complete" as const
        message.version += 1
        message.displayParts = computeDisplayParts(message, preferences().showThinkingBlocks)

        if (oldId !== message.id) {
          index.messageIndex.delete(oldId)
          index.messageIndex.set(message.id, tempMessageIndex)
          const existingPartMap = index.partIndex.get(oldId)
          if (existingPartMap) {
            index.partIndex.delete(oldId)
            index.partIndex.set(message.id, existingPartMap)
          }
        }
      } else {
        const newMessage: any = {
          id: info.id,
          sessionId: info.sessionID,
          type: (info.role === "user" ? "user" : "assistant") as "user" | "assistant",
          parts: [],
          timestamp: info.time?.created || Date.now(),
          status: "complete" as const,
          version: 0,
        }

        newMessage.displayParts = computeDisplayParts(newMessage, preferences().showThinkingBlocks)

        let insertIndex = session.messages.length
        for (let i = session.messages.length - 1; i >= 0; i--) {
          if (session.messages[i].id < newMessage.id) {
            insertIndex = i + 1
            break
          }
        }

        session.messages.splice(insertIndex, 0, newMessage)
        rebuildSessionIndex(instanceId, info.sessionID, session.messages)
      }
    } else {
      const message = session.messages[messageIndex]
      if (typeof message.version !== "number") {
        message.version = 0
      }
      message.status = "complete" as const
      message.version += 1
      message.displayParts = computeDisplayParts(message, preferences().showThinkingBlocks)
    }

    session.messagesInfo.set(info.id, info)
    withSession(instanceId, info.sessionID, () => {
      /* ensure reactivity */
    })

    updateSessionInfo(instanceId, info.sessionID)
    refreshPermissionsForSession(instanceId, info.sessionID)
  }
}

function handleSessionUpdate(instanceId: string, event: EventSessionUpdated): void {
  const info = event.properties?.info
  if (!info) return

  const compactingFlag = info.time?.compacting
  const isCompacting = typeof compactingFlag === "number" ? compactingFlag > 0 : Boolean(compactingFlag)
  setSessionCompactionState(instanceId, info.id, isCompacting)

  const instanceSessions = sessions().get(instanceId)
  if (!instanceSessions) return

  const existingSession = instanceSessions.get(info.id)

  if (!existingSession) {
    const newSession = {
      id: info.id,
      instanceId,
      title: info.title || "Untitled",
      parentId: info.parentID || null,
      agent: "",
      model: {
        providerId: "",
        modelId: "",
      },
      version: info.version || "0",
      time: info.time
        ? { ...info.time }
        : {
            created: Date.now(),
            updated: Date.now(),
          },
      messages: [],
      messagesInfo: new Map(),
    } as any

    setSessions((prev) => {
      const next = new Map(prev)
      const updated = new Map(prev.get(instanceId))
      updated.set(newSession.id, newSession)
      next.set(instanceId, updated)
      return next
    })

    console.log(`[SSE] New session created: ${info.id}`, newSession)
  } else {
    const mergedTime = {
      ...existingSession.time,
      ...(info.time ?? {}),
    }
    if (!info.time?.updated) {
      mergedTime.updated = Date.now()
    }

    const updatedSession = {
      ...existingSession,
      title: info.title || existingSession.title,
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

    setSessions((prev) => {
      const next = new Map(prev)
      const updated = new Map(prev.get(instanceId))
      updated.set(existingSession.id, updatedSession)
      next.set(instanceId, updated)
      return next
    })
  }
}

function handleSessionIdle(_instanceId: string, event: EventSessionIdle): void {
  const sessionId = event.properties?.sessionID
  if (!sessionId) return

  console.log(`[SSE] Session idle: ${sessionId}`)
}

function handleSessionCompacted(instanceId: string, event: EventSessionCompacted): void {
  const sessionID = event.properties?.sessionID
  if (!sessionID) return

  console.log(`[SSE] Session compacted: ${sessionID}`)

  setSessionCompactionState(instanceId, sessionID, false)

  withSession(instanceId, sessionID, (session) => {
    const time = { ...(session.time ?? {}) }
    time.compacting = 0
    session.time = time
  })

  loadMessages(instanceId, sessionID, true).catch(console.error)

  const instanceSessions = sessions().get(instanceId)
  const session = instanceSessions?.get(sessionID)
  const label = session?.title?.trim() ? session.title : sessionID
  const instanceFolder = instances().get(instanceId)?.folder ?? instanceId
  const instanceName = instanceFolder.split(/[\\/]/).filter(Boolean).pop() ?? instanceFolder

  showToastNotification({
    title: instanceName,
    message: `Session ${label ? `"${label}"` : sessionID} was compacted`,
    variant: "info",
    duration: 10000,
  })
}

function handleSessionError(_instanceId: string, event: EventSessionError): void {
  const error = event.properties?.error
  console.error(`[SSE] Session error:`, error)

  let message = "Unknown error"

  if (error) {
    if ("data" in error && error.data && typeof error.data === "object" && "message" in error.data) {
      message = error.data.message as string
    } else if ("message" in error && typeof error.message === "string") {
      message = error.message
    }
  }

  alert(`Error: ${message}`)
}

function handleMessageRemoved(instanceId: string, event: MessageRemovedEvent): void {
  const sessionID = event.properties?.sessionID
  if (!sessionID) return

  console.log(`[SSE] Message removed from session ${sessionID}, reloading messages`)
  loadMessages(instanceId, sessionID, true).catch(console.error)
}

function handleMessagePartRemoved(instanceId: string, event: MessagePartRemovedEvent): void {
  const sessionID = event.properties?.sessionID
  if (!sessionID) return

  console.log(`[SSE] Message part removed from session ${sessionID}, reloading messages`)
  loadMessages(instanceId, sessionID, true).catch(console.error)
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

function handlePermissionUpdated(instanceId: string, event: EventPermissionUpdated): void {
  const permission = event.properties
  if (!permission) return

  console.log(`[SSE] Permission updated: ${permission.id} (${permission.type})`)
  addPermissionToQueue(instanceId, permission)
}

/**
 * Updates a tool call to error state when a permission is rejected.
 * 
 * NOTE: We need to manually update the tool call state for "reject" responses because:
 * - For "once"/"always" (approved) permissions, the server executes the tool and sends
 *   message.part.updated events as the tool transitions through states (pending → running → completed/error)
 * - For "reject", the server doesn't execute the tool at all, so there's no execution to report
 * - The server only sends permission.replied event, which doesn't include updated tool state
 * - Therefore, the client must not only update the UI to reflect the rejected state, but update the
     tool call in the message history so the agent doesn't get confused.
 */
function updateToolCallToErrorState(
  instanceId: string,
  sessionID: string,
  messageID: string,
  callID: string
): void {
  
  const instanceSessions = sessions().get(instanceId)
  if (!instanceSessions) {
    return
  }

  const session = instanceSessions.get(sessionID)
  if (!session) {
    return
  }

  const index = getSessionIndex(instanceId, sessionID)
  const messageIndex = index.messageIndex.get(messageID)
  if (messageIndex === undefined) {
    return
  }

  const message = session.messages[messageIndex]
  const partMap = index.partIndex.get(message.id)
  if (!partMap) {
    return
  }

  const partIndex = partMap.get(callID)
  if (partIndex === undefined) {
    return
  }

  const part = message.parts[partIndex]
  if (!part || part.type !== "tool") {
    return
  }

  // Check if the part has a state that can be updated
  const currentState = part.state
  if (!currentState || currentState.status === "pending") {
    return
  }


  // Update tool call state to error - preserve existing input and metadata
  part.state = {
    status: "error",
    error: "The user rejected permission to use this specific tool call. You may try again with different parameters.",
    input: (currentState as any).input || {},
    metadata: (currentState as any).metadata || {},
    time: {
      start: Date.now(),
      end: Date.now()
    }
  }


  // Increment version to trigger re-render
  if (typeof part.version !== "number") {
    part.version = 0
  }
  part.version += 1

  // Increment message version to trigger re-render
  if (typeof message.version !== "number") {
    message.version = 0
  }
  message.version += 1

  // Update display parts
  message.displayParts = computeDisplayParts(message, preferences().showThinkingBlocks)

}

function handlePermissionReplied(instanceId: string, event: EventPermissionReplied): void {
  const { permissionID, response } = event.properties
  
  if (!permissionID) return

  console.log(`[SSE] Permission replied: ${permissionID}`)

  // Find the permission to get sessionID, messageID, and callID
  const permissionQueue = getPermissionQueue(instanceId)
  
  const permission = permissionQueue.find((p: Permission) => p.id === permissionID)
  
  if (!permission) {
    removePermissionFromQueue(instanceId, permissionID)
    return
  }

  // Only handle reject responses for now
  if (response === "reject") {
    const { sessionID, messageID, callID } = permission
    
    if (sessionID && messageID && callID) {
      updateToolCallToErrorState(instanceId, sessionID, messageID, callID)
    }
  }
  
  removePermissionFromQueue(instanceId, permissionID)
}

export {
  handleMessagePartRemoved,
  handleMessageRemoved,
  handleMessageUpdate,
  handlePermissionReplied,
  handlePermissionUpdated,
  handleSessionCompacted,
  handleSessionError,
  handleSessionIdle,
  handleSessionUpdate,
  handleTuiToast,
}
