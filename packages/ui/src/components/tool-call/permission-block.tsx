import { Show, createEffect, createSignal, type Accessor, type JSXElement } from "solid-js"
import type { PermissionRequestLike } from "../../types/permission"
import { getPermissionDisplayTitle, getPermissionKind } from "../../types/permission"
import { getPermissionSessionId } from "../../types/permission"
import { useI18n } from "../../lib/i18n"
import { PERMISSION_REJECT_REASON_MAX_LENGTH } from "./permission-constants"
import type { DiffPayload, DiffRenderOptions } from "./types"
import { getRelativePath } from "./utils"

type PermissionResponse = "once" | "always" | "reject"

export type PermissionToolBlockProps = {
  permission: Accessor<PermissionRequestLike | undefined>
  active: Accessor<boolean>
  submitting: Accessor<boolean>
  error: Accessor<string | null>
  onRespond: (permission: PermissionRequestLike, sessionId: string, response: PermissionResponse, message?: string) => void | Promise<void>
  onRejectReasonOpenChange?: (open: boolean) => void
  renderDiff: (payload: DiffPayload, options?: DiffRenderOptions) => JSXElement | null
  fallbackSessionId: Accessor<string>
}

export function PermissionToolBlock(props: PermissionToolBlockProps) {
  const { t } = useI18n()
  const [showRejectReason, setShowRejectReason] = createSignal(false)
  const [rejectReason, setRejectReason] = createSignal("")

  const setRejectReasonOpen = (open: boolean) => {
    setShowRejectReason(open)
    props.onRejectReasonOpenChange?.(open)
  }

  createEffect(() => {
    props.permission()?.id
    setRejectReasonOpen(false)
    setRejectReason("")
  })

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

  const respond = (response: PermissionResponse, message?: string) => {
    const permission = props.permission()
    if (!permission) return
    const sessionId = getPermissionSessionId(permission) || props.fallbackSessionId()
    props.onRespond(permission, sessionId, response, message)
  }

  const confirmReject = () => {
    respond("reject", rejectReason().trim() || undefined)
  }

  return (
    <Show when={props.permission()}>
      {(permission) => (
        <div class={`tool-call-permission ${props.active() ? "tool-call-permission-active" : "tool-call-permission-queued"}`}>
          <div class="tool-call-permission-header">
            <span class="tool-call-permission-label">
              {props.active() ? t("toolCall.permission.status.required") : t("toolCall.permission.status.queued")}
            </span>
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
                      ? t("toolCall.permission.requestedDiff.withPath", { path: getRelativePath(payload().filePath || "") })
                      : t("toolCall.permission.requestedDiff.label"),
                  })}
                </div>
              )}
            </Show>
            <Show when={!props.active()}>
              <p class="tool-call-permission-queued-text">{t("toolCall.permission.queuedText")}</p>
            </Show>
            <Show
              when={showRejectReason()}
              fallback={
                <div class="tool-call-permission-actions">
                  <div class="tool-call-permission-buttons">
                    <button
                      type="button"
                      class="tool-call-permission-button"
                      disabled={props.submitting()}
                      onClick={() => respond("once")}
                    >
                      {t("toolCall.permission.actions.allowOnce")}
                    </button>
                    <button
                      type="button"
                      class="tool-call-permission-button"
                      disabled={props.submitting()}
                      onClick={() => respond("always")}
                    >
                      {t("toolCall.permission.actions.alwaysAllow")}
                    </button>
                    <button
                      type="button"
                      class="tool-call-permission-button"
                      disabled={props.submitting()}
                      onClick={() => setRejectReasonOpen(true)}
                    >
                      {t("toolCall.permission.actions.deny")}
                    </button>
                  </div>
                  <Show when={props.active()}>
                    <div class="tool-call-permission-shortcuts">
                      <kbd class="kbd">Enter</kbd>
                      <span>{t("toolCall.permission.shortcuts.allowOnce")}</span>
                      <kbd class="kbd">A</kbd>
                      <span>{t("toolCall.permission.shortcuts.alwaysAllow")}</span>
                    </div>
                  </Show>
                </div>
              }
            >
              <div class="tool-call-permission-reject-reason">
                <label class="tool-call-permission-reject-label" for={`permission-reject-reason-${permission().id}`}>
                  {t("toolCall.permission.rejectReason.label")}
                </label>
                <textarea
                  id={`permission-reject-reason-${permission().id}`}
                  class="tool-call-permission-reject-textarea"
                  value={rejectReason()}
                  rows={3}
                  maxLength={PERMISSION_REJECT_REASON_MAX_LENGTH}
                  placeholder={t("toolCall.permission.rejectReason.placeholder")}
                  disabled={props.submitting()}
                  onInput={(event) => setRejectReason(event.currentTarget.value)}
                />
                <p class="tool-call-permission-reject-hint">{t("toolCall.permission.rejectReason.hint")}</p>
                <div class="tool-call-permission-buttons">
                  <button type="button" class="tool-call-permission-button" disabled={props.submitting()} onClick={confirmReject}>
                    {t("toolCall.permission.actions.confirmDeny")}
                  </button>
                  <button
                    type="button"
                    class="tool-call-permission-button"
                    disabled={props.submitting()}
                    onClick={() => {
                      setRejectReasonOpen(false)
                      setRejectReason("")
                    }}
                  >
                    {t("toolCall.permission.actions.cancel")}
                  </button>
                </div>
              </div>
            </Show>
            <Show when={props.error()}>
              <div class="tool-call-permission-error">{props.error()}</div>
            </Show>
          </div>
        </div>
      )}
    </Show>
  )
}
