import { Show, createSignal, createMemo, createEffect, onCleanup, type Component } from "solid-js"
import type { PermissionRequestLike } from "../types/permission"
import { getPermissionQueue, activePermissionId, sendPermissionResponse } from "../stores/instances"
import { ToolCallDiffViewer } from "./diff-viewer"
import { useTheme } from "../lib/theme"
import { getRelativePath } from "./tool-call/utils"
import { getLogger } from "../lib/logger"

const log = getLogger("session")

interface PermissionApprovalModalProps {
  instanceId: string
  isOpen: boolean
  onClose: () => void
}

const PermissionApprovalModal: Component<PermissionApprovalModalProps> = (props) => {
  const { isDark } = useTheme()
  const [submitting, setSubmitting] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)

  const queue = createMemo(() => getPermissionQueue(props.instanceId))
  const activePermId = createMemo(() => activePermissionId().get(props.instanceId) ?? null)
  
  const activePermission = createMemo((): PermissionRequestLike | null => {
    const id = activePermId()
    if (!id) return null
    return queue().find((p) => p.id === id) ?? null
  })

  const hasActivePermission = createMemo(() => activePermission() !== null)

  createEffect(() => {
    const permission = activePermission()
    if (!permission) {
      setSubmitting(false)
      setError(null)
    }
  })

  // Keyboard shortcuts
  createEffect(() => {
    if (!props.isOpen || !hasActivePermission()) return

    const handler = (event: KeyboardEvent) => {
      if (submitting()) return
      
      if (event.key === "Enter") {
        event.preventDefault()
        handleResponse("once")
      } else if (event.key === "a" || event.key === "A") {
        event.preventDefault()
        handleResponse("always")
      } else if (event.key === "d" || event.key === "D") {
        event.preventDefault()
        handleResponse("reject")
      } else if (event.key === "Escape") {
        event.preventDefault()
        props.onClose()
      }
    }

    document.addEventListener("keydown", handler)
    onCleanup(() => document.removeEventListener("keydown", handler))
  })

  async function handleResponse(response: "once" | "always" | "reject") {
    const permission = activePermission()
    if (!permission) return

    setSubmitting(true)
    setError(null)

    try {
      const sessionId = (permission as any).sessionID || ""
      await sendPermissionResponse(props.instanceId, sessionId, permission.id, response)
      
      // Wait a moment for queue to update before closing
      setTimeout(() => {
        const remaining = getPermissionQueue(props.instanceId)
        if (remaining.length === 0) {
          props.onClose()
        }
      }, 100)
    } catch (err) {
      log.error("Failed to send permission response", err)
      setError(err instanceof Error ? err.message : "Failed to send response")
    } finally {
      setSubmitting(false)
    }
  }

  function handleBackdropClick(event: MouseEvent) {
    if (event.target === event.currentTarget) {
      props.onClose()
    }
  }

  const diffPayload = createMemo(() => {
    const permission = activePermission()
    if (!permission) return null

    const metadata = ((permission as any).metadata || {}) as Record<string, unknown>
    const diffValue = typeof metadata.diff === "string" ? metadata.diff : null
    if (!diffValue || diffValue.trim().length === 0) return null

    const diffPath = 
      typeof metadata.filePath === "string" ? metadata.filePath :
      typeof metadata.path === "string" ? metadata.path :
      undefined

    return { diffText: diffValue, filePath: diffPath }
  })

  return (
    <Show when={props.isOpen}>
      <div class="permission-approval-modal-backdrop" onClick={handleBackdropClick}>
        <div class="permission-approval-modal" role="dialog" aria-modal="true" aria-labelledby="permission-modal-title">
          <Show when={hasActivePermission()} fallback={
            <div class="permission-modal-empty">
              <p class="text-center text-gray-500">No pending permissions</p>
            </div>
          }>
            <div class="permission-modal-header">
              <h2 id="permission-modal-title" class="permission-modal-title">
                Permission Required
              </h2>
              <Show when={queue().length > 1}>
                <span class="permission-modal-count">
                  {queue().indexOf(activePermission()!) + 1} of {queue().length}
                </span>
              </Show>
            </div>

            <div class="permission-modal-body">
              <div class="permission-modal-type">
                {activePermission()!.type}
              </div>
              <div class="permission-modal-message">
                <code>{activePermission()!.title}</code>
              </div>

              <Show when={diffPayload()}>
                {(payload) => (
                  <div class="permission-modal-diff">
                    <div class="permission-modal-diff-label">
                      Requested changes · {payload().filePath ? getRelativePath(payload().filePath!) : ""}
                    </div>
                    <div class="permission-modal-diff-viewer">
                      <ToolCallDiffViewer
                        diffText={payload().diffText}
                        filePath={payload().filePath}
                        theme={isDark() ? "dark" : "light"}
                        mode="split"
                        onRendered={() => {}}
                      />
                    </div>
                  </div>
                )}
              </Show>

              <Show when={error()}>
                <div class="permission-modal-error" role="alert">
                  {error()}
                </div>
              </Show>
            </div>

            <div class="permission-modal-footer">
              <div class="permission-modal-buttons">
                <button
                  type="button"
                  class="permission-modal-button permission-modal-button-once"
                  disabled={submitting()}
                  onClick={() => handleResponse("once")}
                >
                  Allow Once
                </button>
                <button
                  type="button"
                  class="permission-modal-button permission-modal-button-always"
                  disabled={submitting()}
                  onClick={() => handleResponse("always")}
                >
                  Always Allow
                </button>
                <button
                  type="button"
                  class="permission-modal-button permission-modal-button-deny"
                  disabled={submitting()}
                  onClick={() => handleResponse("reject")}
                >
                  Deny
                </button>
              </div>
              <div class="permission-modal-shortcuts">
                <span class="permission-modal-shortcut">
                  <kbd class="kbd">Enter</kbd> Allow once
                </span>
                <span class="permission-modal-shortcut">
                  <kbd class="kbd">A</kbd> Always
                </span>
                <span class="permission-modal-shortcut">
                  <kbd class="kbd">D</kbd> Deny
                </span>
                <span class="permission-modal-shortcut">
                  <kbd class="kbd">Esc</kbd> Close
                </span>
              </div>
            </div>
          </Show>
        </div>
      </div>
    </Show>
  )
}

export default PermissionApprovalModal
