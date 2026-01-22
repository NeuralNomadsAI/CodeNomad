import { Show, type Accessor, type JSXElement } from "solid-js"
import type { PermissionRequestLike } from "../../types/permission"
import { getPermissionDisplayTitle, getPermissionKind } from "../../types/permission"
import { getPermissionSessionId } from "../../types/permission"
import type { DiffPayload, DiffRenderOptions } from "./types"
import { getRelativePath } from "./utils"

type PermissionResponse = "once" | "always" | "reject"

export type PermissionToolBlockProps = {
  permission: Accessor<PermissionRequestLike | undefined>
  active: Accessor<boolean>
  submitting: Accessor<boolean>
  error: Accessor<string | null>
  onRespond: (permission: PermissionRequestLike, sessionId: string, response: PermissionResponse) => void | Promise<void>
  renderDiff: (payload: DiffPayload, options?: DiffRenderOptions) => JSXElement | null
  fallbackSessionId: Accessor<string>
}

export function PermissionToolBlock(props: PermissionToolBlockProps) {
  const diffPayload = () => {
    const permission = props.permission()
    if (!permission) return null
    const metadata = (permission.metadata ?? {}) as Record<string, unknown>
    const diffValue = typeof metadata.diff === "string" ? (metadata.diff as string) : null
    const diffPathRaw = (() => {
      if (typeof metadata.filePath === "string") {
        return metadata.filePath as string
      }
      if (typeof metadata.path === "string") {
        return metadata.path as string
      }
      return undefined
    })()
    if (!diffValue || diffValue.trim().length === 0) return null
    return { diffText: diffValue, filePath: diffPathRaw } satisfies DiffPayload
  }

  const respond = (response: PermissionResponse) => {
    const permission = props.permission()
    if (!permission) return
    const sessionId = getPermissionSessionId(permission) || props.fallbackSessionId()
    props.onRespond(permission, sessionId, response)
  }

  return (
    <Show when={props.permission()}>
      {(permission) => (
        <div class={`tool-call-permission ${props.active() ? "tool-call-permission-active" : "tool-call-permission-queued"}`}>
          <div class="tool-call-permission-header">
            <span class="tool-call-permission-label">{props.active() ? "Permission Required" : "Permission Queued"}</span>
            <span class="tool-call-permission-type">{getPermissionKind(permission())}</span>
          </div>
          <div class="tool-call-permission-body">
            <div class="tool-call-permission-title">
              <code>{getPermissionDisplayTitle(permission())}</code>
            </div>
            <Show when={diffPayload()}>
              {(payload) => (
                <div class="tool-call-permission-diff">
                  {props.renderDiff(payload(), {
                    variant: "permission-diff",
                    disableScrollTracking: true,
                    label: payload().filePath
                      ? `Requested diff · ${getRelativePath(payload().filePath || "")}`
                      : "Requested diff",
                  })}
                </div>
              )}
            </Show>
            <Show when={!props.active()}>
              <p class="tool-call-permission-queued-text">Waiting for earlier permission responses.</p>
            </Show>
            <div class="tool-call-permission-actions">
              <div class="tool-call-permission-buttons">
                <button
                  type="button"
                  class="tool-call-permission-button"
                  disabled={props.submitting()}
                  onClick={() => respond("once")}
                >
                  Allow Once
                </button>
                <button
                  type="button"
                  class="tool-call-permission-button"
                  disabled={props.submitting()}
                  onClick={() => respond("always")}
                >
                  Always Allow
                </button>
                <button
                  type="button"
                  class="tool-call-permission-button"
                  disabled={props.submitting()}
                  onClick={() => respond("reject")}
                >
                  Deny
                </button>
              </div>
              <Show when={props.active()}>
                <div class="tool-call-permission-shortcuts">
                  <kbd class="kbd">Enter</kbd>
                  <span>Allow once</span>
                  <kbd class="kbd">A</kbd>
                  <span>Always allow</span>
                  <kbd class="kbd">D</kbd>
                  <span>Deny</span>
                </div>
              </Show>
            </div>
            <Show when={props.error()}>
              <div class="tool-call-permission-error">{props.error()}</div>
            </Show>
          </div>
        </div>
      )}
    </Show>
  )
}
