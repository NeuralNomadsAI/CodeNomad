import { For, Show, createMemo, createSignal, createEffect, onCleanup, type Component } from "solid-js"
import type { PermissionRequestLike } from "../types/permission"
import { getPermissionCallId, getPermissionDisplayTitle, getPermissionKind, getPermissionMessageId, getPermissionSessionId } from "../types/permission"
import { activePermissionId, getPermissionQueue } from "../stores/instances"
import { loadMessages, setActiveSession } from "../stores/sessions"
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

const PermissionApprovalModal: Component<PermissionApprovalModalProps> = (props) => {
  const [loadingSession, setLoadingSession] = createSignal<string | null>(null)

  const queue = createMemo(() => getPermissionQueue(props.instanceId))
  const activePermId = createMemo(() => activePermissionId().get(props.instanceId) ?? null)

  const orderedQueue = createMemo(() => {
    const current = queue()
    const activeId = activePermId()
    if (!activeId) return current
    const index = current.findIndex((entry) => entry.id === activeId)
    if (index <= 0) return current
    const active = current[index]
    if (!active) return current
    return [active, ...current.slice(0, index), ...current.slice(index + 1)]
  })

  const hasPermissions = createMemo(() => queue().length > 0)

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
    if (queue().length === 0) {
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
    setActiveSession(props.instanceId, sessionId)
    props.onClose()
  }

  return (
    <Show when={props.isOpen}>
      <div class="permission-center-modal-backdrop" onClick={handleBackdropClick}>
        <div class="permission-center-modal" role="dialog" aria-modal="true" aria-labelledby="permission-center-title">
          <div class="permission-center-modal-header">
            <div class="permission-center-modal-title-row">
              <h2 id="permission-center-title" class="permission-center-modal-title">
                Permissions
              </h2>
              <Show when={queue().length > 0}>
                <span class="permission-center-modal-count">{queue().length}</span>
              </Show>
            </div>
            <button type="button" class="permission-center-modal-close" onClick={props.onClose} aria-label="Close">
              ✕
            </button>
          </div>

          <div class="permission-center-modal-body">
            <Show when={hasPermissions()} fallback={<div class="permission-center-empty">No pending permissions.</div>}>
              <div class="permission-center-list" role="list">
                <For each={orderedQueue()}>
                  {(permission) => {
                    const sessionId = getPermissionSessionId(permission) || ""
                    const isActive = () => permission.id === activePermId()
                    const resolved = createMemo(() => resolveToolCallFromPermission(props.instanceId, permission))

                    const showFallback = () => !resolved()

                    return (
                      <div
                        class={`permission-center-item${isActive() ? " permission-center-item-active" : ""}`}
                        role="listitem"
                      >
                        <div class="permission-center-item-header">
                          <div class="permission-center-item-heading">
                            <span class="permission-center-item-kind">{getPermissionKind(permission)}</span>
                            <Show when={isActive()}>
                              <span class="permission-center-item-chip">Active</span>
                            </Show>
                          </div>

                          <div class="permission-center-item-actions">
                            <button
                              type="button"
                              class="permission-center-item-action"
                              onClick={() => handleGoToSession(sessionId)}
                            >
                              Go to Session
                            </button>
                            <Show when={showFallback()}>
                              <button
                                type="button"
                                class="permission-center-item-action"
                                disabled={loadingSession() === sessionId}
                                onClick={() => handleLoadSession(sessionId)}
                              >
                                {loadingSession() === sessionId ? "Loading…" : "Load Session"}
                              </button>
                            </Show>
                          </div>
                        </div>

                        <Show
                          when={resolved()}
                          fallback={
                            <div class="permission-center-fallback">
                              <div class="permission-center-fallback-title">
                                <code>{getPermissionDisplayTitle(permission)}</code>
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
