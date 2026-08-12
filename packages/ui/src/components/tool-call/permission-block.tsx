import { Show, createEffect, createSignal, type Accessor, type JSXElement } from "solid-js"
import type { PermissionRequest } from "../../types/permission"
import { getPermissionDisplayTitle, getPermissionKind } from "../../types/permission"
import { getPermissionSessionId } from "../../types/permission"
import { useI18n } from "../../lib/i18n"
import { isPermissionDiffTooLarge, PERMISSION_REJECT_REASON_MAX_LENGTH } from "./permission-constants"
import type { DiffPayload, DiffRenderOptions } from "./types"
import { getRelativePath, limitToolTitleForRender } from "./utils"

type PermissionResponse = "once" | "always" | "reject"

export type PermissionToolBlockProps = {
  permission: Accessor<PermissionRequest | undefined>
  active: Accessor<boolean>
  submitting: Accessor<boolean>
  error: Accessor<string | null>
  onRespond: (permission: PermissionRequest, sessionId: string, response: PermissionResponse, message?: string) => void | Promise<void>
  onApprovalBlockedChange?: (blocked: boolean) => void
  renderDiff: (payload: DiffPayload, options?: DiffRenderOptions) => JSXElement | null
  fallbackSessionId: Accessor<string>
}

export function PermissionToolBlock(props: PermissionToolBlockProps) {
  const { t } = useI18n()
  const [rejectReason, setRejectReason] = createSignal("")
  const [accessedDiff, setAccessedDiff] = createSignal("")

  createEffect(() => {
    const permission = props.permission()
    const diff = (() => {
      const metadata = (permission?.metadata ?? {}) as Record<string, unknown>
      return typeof metadata.diff === "string" ? metadata.diff : ""
    })()
    setRejectReason("")
    if (!permission || accessedDiff() !== diff) setAccessedDiff("")
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

  const approvalBlocked = () => isPermissionDiffTooLarge(diffPayload()?.diffText) && accessedDiff() !== diffPayload()?.diffText
  createEffect(() => props.onApprovalBlockedChange?.(approvalBlocked()))

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
              <code>{limitToolTitleForRender(getPermissionDisplayTitle(permission()))}</code>
            </div>
            <Show when={diffPayload()}>
              {(payload) => (
                <div class="tool-call-permission-diff">
                  {props.renderDiff(payload(), {
                    variant: "permission-diff",
                    disableScrollTracking: true,
                    onFullDiffAccess: setAccessedDiff,
                    label: payload().filePath
                      ? t("toolCall.permission.requestedDiff.withPath", { path: getRelativePath(payload().filePath || "") })
                      : t("toolCall.permission.requestedDiff.label"),
                  })}
                </div>
              )}
            </Show>
            <Show when={approvalBlocked()}>
              <div class="tool-call-diagnostic-message" role="status">{t("toolCall.permission.fullDiffRequired")}</div>
            </Show>
            <Show when={!props.active()}>
              <p class="tool-call-permission-queued-text">{t("toolCall.permission.queuedText")}</p>
            </Show>
            <div class="tool-call-permission-reject-reason">
              <textarea
                id={`permission-reject-reason-${permission().id}`}
                class="tool-call-permission-reject-textarea"
                value={rejectReason()}
                rows={1}
                maxLength={PERMISSION_REJECT_REASON_MAX_LENGTH}
                placeholder={t("toolCall.permission.rejectReason.placeholder")}
                aria-label={t("toolCall.permission.rejectReason.placeholder")}
                disabled={props.submitting()}
                onInput={(event) => setRejectReason(event.currentTarget.value)}
              />
            </div>
            <div class="tool-call-permission-actions">
              <div class="tool-call-permission-buttons">
                <button
                  type="button"
                  class="tool-call-permission-button"
                  disabled={props.submitting() || approvalBlocked()}
                  onClick={() => respond("once")}
                >
                  {t("toolCall.permission.actions.allowOnce")}
                </button>
                <button
                  type="button"
                  class="tool-call-permission-button"
                  disabled={props.submitting() || approvalBlocked()}
                  onClick={() => respond("always")}
                >
                  {t("toolCall.permission.actions.alwaysAllow")}
                </button>
                <button type="button" class="tool-call-permission-button" disabled={props.submitting()} onClick={confirmReject}>
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
            <Show when={props.error()}>
              <div class="tool-call-permission-error">{props.error()}</div>
            </Show>
          </div>
        </div>
      )}
    </Show>
  )
}
