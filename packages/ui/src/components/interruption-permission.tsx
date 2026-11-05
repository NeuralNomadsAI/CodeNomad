import { Show, createSignal, type JSX } from "solid-js"
import type { PermissionRequest } from "../types/permission"
import { getPermissionDisplayTitle, getPermissionKind } from "../types/permission"
import { sendPermissionResponse } from "../stores/instances"
import { useI18n } from "../lib/i18n"
import { createPermissionDiffReviews } from "./permission-diff-review"
import { PermissionFallbackDiff } from "./permission-fallback-diff"
import { getPermissionDiffPayload, isPermissionApprovalBlocked } from "./tool-call/permission-block"
import { PERMISSION_REJECT_REASON_MAX_LENGTH } from "./tool-call/permission-constants"
import { isSessionActionInterrupted } from "../stores/session-action-queue"

export function InterruptionPermission(props: { instanceId: string; permission: PermissionRequest; replyBlocked?: boolean; replyDescriptionId?: string; replyNotice?: JSX.Element }) {
  const { t } = useI18n()
  const [reason, setReason] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal("")
  const [politeError, setPoliteError] = createSignal(false)
  const review = createPermissionDiffReviews(() => props.instanceId, () => [props.permission])
  const blocked = () => isPermissionApprovalBlocked(getPermissionDiffPayload(props.permission), review(props.permission)?.reviewed() ?? false)
  async function respond(decision: "once" | "always" | "reject") {
    if (busy() || props.replyBlocked || (decision !== "reject" && blocked())) return
    const request = props.permission
    setBusy(true)
    setError("")
    try {
      await sendPermissionResponse(props.instanceId, request.sessionID, request.id, decision,
        decision === "reject" ? reason().trim() || undefined : undefined)
    } catch (cause) {
      setPoliteError(isSessionActionInterrupted(cause))
      setError(cause instanceof Error ? cause.message : t("permissionApproval.errors.unableToUpdatePermission"))
    } finally { setBusy(false) }
  }
  return <div class="tool-call-permission">
    <div class="interruption-permission-content">
    {props.replyNotice}
    <div class="tool-call-permission-title"><strong>{getPermissionKind(props.permission)}</strong><code>{getPermissionDisplayTitle(props.permission)}</code></div>
    <Show when={review(props.permission)} keyed>{value => <PermissionFallbackDiff review={value} />}</Show>
    <textarea class="tool-call-permission-reject-textarea" rows={1} value={reason()}
      aria-label={t("permissionApproval.rejectReason.placeholder")} placeholder={t("permissionApproval.rejectReason.placeholder")}
      maxLength={PERMISSION_REJECT_REASON_MAX_LENGTH} disabled={busy()} onInput={event => setReason(event.currentTarget.value)} />
    </div>
    <div class="tool-call-permission-buttons window-footer">
      <button type="button" class="selector-button selector-button-secondary" aria-describedby={props.replyDescriptionId} disabled={busy() || props.replyBlocked} onClick={() => void respond("reject")}>{t("permissionApproval.actions.deny")}</button>
      <button type="button" class="selector-button selector-button-secondary" aria-describedby={props.replyDescriptionId} disabled={busy() || props.replyBlocked || blocked()} onClick={() => void respond("always")}>{t("permissionApproval.actions.alwaysAllow")}</button>
      <button type="button" class="selector-button selector-button-primary" aria-describedby={props.replyDescriptionId} disabled={busy() || props.replyBlocked || blocked()} onClick={() => void respond("once")}>{t("permissionApproval.actions.allowOnce")}</button>
    </div>
    <Show when={error()}><p role={politeError() ? "status" : "alert"} aria-live={politeError() ? "polite" : undefined} class="tool-call-permission-error">{error()}</p></Show>
  </div>
}
