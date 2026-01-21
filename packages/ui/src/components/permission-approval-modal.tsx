import { For, Show, createMemo, createSignal, createEffect, onCleanup, type Component } from "solid-js"
import type { PermissionRequestLike } from "../types/permission"
import { getPermissionCallId, getPermissionDisplayTitle, getPermissionKind, getPermissionMessageId, getPermissionSessionId } from "../types/permission"
import { getQuestionCallId, getQuestionMessageId, getQuestionSessionId, type QuestionRequest } from "../types/question"
import {
  activeInterruption,
  getPermissionQueue,
  getQuestionQueue,
  getQuestionEnqueuedAtForInstance,
} from "../stores/instances"
import { ensureSessionParentExpanded, loadMessages, sessions as sessionStateSessions, setActiveSessionFromList } from "../stores/sessions"
import { messageStoreBus } from "../stores/message-v2/bus"
import ToolCall from "./tool-call"

interface PermissionApprovalModalProps {
  instanceId: string
  isOpen: boolean
  onClose: () => void
}

type ResolvedToolCall = {
  messageId: string
  sessionId: string
  toolPart: Extract<import("../types/message").ClientPart, { type: "tool" }>
  messageVersion: number
  partVersion: number
}

function resolveToolCallFromPermission(
  instanceId: string,
  permission: PermissionRequestLike,
): ResolvedToolCall | null {
  const sessionId = getPermissionSessionId(permission)
  const messageId = getPermissionMessageId(permission)
  if (!sessionId || !messageId) return null

  const store = messageStoreBus.getInstance(instanceId)
  if (!store) return null

  const record = store.getMessage(messageId)
  if (!record) return null

  const metadata = ((permission as any).metadata || {}) as Record<string, unknown>
  const directPartId =
    (permission as any).partID ??
    (permission as any).partId ??
    (metadata as any).partID ??
    (metadata as any).partId ??
    undefined

  const callId = getPermissionCallId(permission)

  const findToolPart = (partId: string) => {
    const partRecord = record.parts?.[partId]
    const part = partRecord?.data
    if (!part || part.type !== "tool") return null
    return {
      toolPart: part as ResolvedToolCall["toolPart"],
      partVersion: partRecord.revision ?? 0,
    }
  }

  if (typeof directPartId === "string" && directPartId.length > 0) {
    const resolved = findToolPart(directPartId)
    if (resolved) {
      return {
        messageId,
        sessionId,
        toolPart: resolved.toolPart,
        messageVersion: record.revision,
        partVersion: resolved.partVersion,
      }
    }
  }

  if (callId) {
    for (const partId of record.partIds) {
      const partRecord = record.parts?.[partId]
      const part = partRecord?.data as any
      if (!part || part.type !== "tool") continue
      const partCallId = part.callID ?? part.callId ?? part.toolCallID ?? part.toolCallId ?? undefined
      if (partCallId === callId && typeof part.id === "string" && part.id.length > 0) {
        return {
          messageId,
          sessionId,
          toolPart: part as ResolvedToolCall["toolPart"],
          messageVersion: record.revision,
          partVersion: partRecord.revision ?? 0,
        }
      }
    }
  }

  return null
}

function resolveToolCallFromQuestion(instanceId: string, request: QuestionRequest): ResolvedToolCall | null {
  const sessionId = getQuestionSessionId(request)
  const messageId = getQuestionMessageId(request)
  if (!sessionId || !messageId) return null

  const store = messageStoreBus.getInstance(instanceId)
  if (!store) return null

  const record = store.getMessage(messageId)
  if (!record) return null

  const callId = getQuestionCallId(request)
  if (!callId) return null

  for (const partId of record.partIds) {
    const partRecord = record.parts?.[partId]
    const part = partRecord?.data as any
    if (!part || part.type !== "tool") continue
    const partCallId = part.callID ?? part.callId ?? part.toolCallID ?? part.toolCallId ?? undefined
    if (partCallId !== callId) continue

    if (typeof part.id !== "string" || part.id.length === 0) continue
    return {
      messageId,
      sessionId,
      toolPart: part as ResolvedToolCall["toolPart"],
      messageVersion: record.revision,
      partVersion: partRecord?.revision ?? 0,
    }
  }

  return null
}

const PermissionApprovalModal: Component<PermissionApprovalModalProps> = (props) => {
  const [loadingSession, setLoadingSession] = createSignal<string | null>(null)

  const permissionQueue = createMemo(() => getPermissionQueue(props.instanceId))
  const questionQueue = createMemo(() => getQuestionQueue(props.instanceId))
  const active = createMemo(() => activeInterruption().get(props.instanceId) ?? null)

  type InterruptionItem =
    | { kind: "permission"; id: string; sessionId: string; createdAt: number; payload: PermissionRequestLike }
    | { kind: "question"; id: string; sessionId: string; createdAt: number; payload: QuestionRequest }

  const orderedQueue = createMemo<InterruptionItem[]>(() => {
    const permissions = permissionQueue().map((permission) => ({
      kind: "permission" as const,
      id: permission.id,
      sessionId: getPermissionSessionId(permission) || "",
      createdAt: (permission as any)?.time?.created ?? Date.now(),
      payload: permission,
    }))

    const questions = questionQueue().map((question) => ({
      kind: "question" as const,
      id: question.id,
      sessionId: getQuestionSessionId(question) || "",
      createdAt: getQuestionEnqueuedAtForInstance(props.instanceId, question.id),
      payload: question,
    }))

    return [...permissions, ...questions].sort((a, b) => a.createdAt - b.createdAt)
  })

  const hasRequests = createMemo(() => orderedQueue().length > 0)

  const closeOnEscape = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault()
      props.onClose()
    }
  }

  createEffect(() => {
    if (!props.isOpen) return
    document.addEventListener("keydown", closeOnEscape)
    onCleanup(() => document.removeEventListener("keydown", closeOnEscape))
  })

  createEffect(() => {
    if (!props.isOpen) return
    if (orderedQueue().length === 0) {
      props.onClose()
    }
  })

  function handleBackdropClick(event: MouseEvent) {
    if (event.target === event.currentTarget) {
      props.onClose()
    }
  }

  async function handleLoadSession(sessionId: string) {
    if (!sessionId) return
    setLoadingSession(sessionId)
    try {
      await loadMessages(props.instanceId, sessionId)
    } finally {
      setLoadingSession((current) => (current === sessionId ? null : current))
    }
  }

  function handleGoToSession(sessionId: string) {
    if (!sessionId) return

    const session = sessionStateSessions().get(props.instanceId)?.get(sessionId)
    const parentId = session?.parentId ?? session?.id
    if (parentId) {
      ensureSessionParentExpanded(props.instanceId, parentId)
    }

    setActiveSessionFromList(props.instanceId, sessionId)
    props.onClose()
  }

  return (
    <Show when={props.isOpen}>
      <div class="permission-center-modal-backdrop" onClick={handleBackdropClick}>
        <div class="permission-center-modal" role="dialog" aria-modal="true" aria-labelledby="permission-center-title">
          <div class="permission-center-modal-header">
            <div class="permission-center-modal-title-row">
              <h2 id="permission-center-title" class="permission-center-modal-title">
                Requests
              </h2>
              <Show when={orderedQueue().length > 0}>
                <span class="permission-center-modal-count">{orderedQueue().length}</span>
              </Show>
            </div>
            <button type="button" class="permission-center-modal-close" onClick={props.onClose} aria-label="Close">
              ✕
            </button>
          </div>

          <div class="permission-center-modal-body">
            <Show when={hasRequests()} fallback={<div class="permission-center-empty">No pending requests.</div>}>
              <div class="permission-center-list" role="list">
                <For each={orderedQueue()}>
                  {(item) => {
                    const isActive = () => active()?.kind === item.kind && active()?.id === item.id
                    const sessionId = () => item.sessionId

                    const resolved = createMemo(() => {
                      if (item.kind === "permission") {
                        return resolveToolCallFromPermission(props.instanceId, item.payload)
                      }
                      return resolveToolCallFromQuestion(props.instanceId, item.payload)
                    })

                    const showFallback = () => !resolved()

                    const kindLabel = () => (item.kind === "permission" ? "Permission" : "Question")

                    const primaryTitle = () => {
                      if (item.kind === "permission") {
                        return getPermissionDisplayTitle(item.payload)
                      }
                      const first = item.payload.questions?.[0]?.question
                      return typeof first === "string" && first.trim().length > 0 ? first : "Question"
                    }

                    const secondaryTitle = () => {
                      if (item.kind === "permission") {
                        return getPermissionKind(item.payload)
                      }
                      const count = item.payload.questions?.length ?? 0
                      return count === 1 ? "1 question" : `${count} questions`
                    }

                    return (
                      <div
                        class={`permission-center-item${isActive() ? " permission-center-item-active" : ""}`}
                        role="listitem"
                      >
                        <div class="permission-center-item-header">
                          <div class="permission-center-item-heading">
                            <span class={`permission-center-item-chip permission-center-item-chip-${item.kind}`}>{kindLabel()}</span>
                            <span class="permission-center-item-kind">{secondaryTitle()}</span>
                            <Show when={isActive()}>
                              <span class="permission-center-item-chip">Active</span>
                            </Show>
                          </div>

                          <div class="permission-center-item-actions">
                            <button
                              type="button"
                              class="permission-center-item-action"
                              onClick={(e) => {
                                e.stopPropagation()
                                handleGoToSession(sessionId())
                              }}
                            >
                              Go to Session
                            </button>
                            <Show when={showFallback()}>
                              <button
                                type="button"
                                class="permission-center-item-action"
                                disabled={loadingSession() === sessionId()}
                                onClick={(e) => {
                                  e.stopPropagation()
                                  handleLoadSession(sessionId())
                                }}
                              >
                                {loadingSession() === sessionId() ? "Loading…" : "Load Session"}
                              </button>
                            </Show>
                          </div>
                        </div>

                        <Show
                          when={resolved()}
                          fallback={
                            <div class="permission-center-fallback">
                              <div class="permission-center-fallback-title">
                                <code>{primaryTitle()}</code>
                              </div>
                              <div class="permission-center-fallback-hint">Load session for more information.</div>
                            </div>
                          }
                        >
                          {(data) => (
                            <ToolCall
                              toolCall={data().toolPart}
                              toolCallId={data().toolPart.id}
                              messageId={data().messageId}
                              messageVersion={data().messageVersion}
                              partVersion={data().partVersion}
                              instanceId={props.instanceId}
                              sessionId={data().sessionId}
                            />
                          )}
                        </Show>
                      </div>
                    )
                  }}
                </For>
              </div>
            </Show>
          </div>
        </div>
      </div>
    </Show>
  )
}

export default PermissionApprovalModal
