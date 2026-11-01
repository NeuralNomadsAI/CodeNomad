import { createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import type { IntegrationInstallHostResponse, IntegrationView } from "../../../server/src/integration-types"
import { integrationAttachmentRequest } from "../lib/integrations-api"
import { useI18n } from "../lib/i18n"
import { showToastNotification } from "../lib/notifications"
import { HttpResponseError } from "../lib/retryable-file-search"
import { showConfirmDialog } from "../stores/alerts"
import { integrationEpoch, integrations } from "../stores/integrations"

/** Location-scoped explicit consent; the session is only a navigation fence, never installer input. */
export function createIntegrationHostInstallation(props: {
  instanceId: string; directory: string; sessionId?: string; active?: boolean; entries: () => IntegrationView[]
}) {
  const { t } = useI18n()
  const [pending, setPending] = createSignal(false)
  const identity = createMemo(() => JSON.stringify([props.instanceId, props.directory, props.sessionId, props.active !== false]))
  const epoch = createMemo(() => integrationEpoch(props.instanceId, props.sessionId))
  const eligible = (id: string) => props.active !== false ? props.entries().find(entry => entry.id === id
    && entry.family === "native" && entry.state === "ok" && entry.status?.host?.state !== "unsupported"
    && entry.status?.host?.state !== "unknown" && entry.status?.host?.action && entry.status.version) : undefined
  const signature = (id: string) => JSON.stringify(eligible(id))
  let confirmation: AbortController | undefined
  let disposed = false
  let focusGeneration = 0
  let target: { id: string; identity: string; epoch: string; signature: string } | undefined
  const cancel = () => { confirmation?.abort(); confirmation = undefined; target = undefined }
  createEffect(() => {
    const owner = identity(), generation = epoch(), entries = props.entries()
    if (target && (target.identity !== owner || target.epoch !== generation || target.signature !== signature(target.id))) { focusGeneration++; cancel() }
    void entries
  })
  onCleanup(() => { disposed = true; cancel() })
  const open = async (id: string) => {
    const entry = eligible(id)
    if (!entry || pending() || confirmation) return
    const instanceId = props.instanceId, directory = props.directory, owner = identity()
    const captured = { id, identity: owner, epoch: epoch(), signature: signature(id) }
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    const generation = ++focusGeneration
    target = captured
    confirmation = new AbortController()
    const signal = confirmation.signal
    const action = entry.status!.host!.action!
    const accepted = await showConfirmDialog(t("integrations.installHost.warning", { app: entry.app.name, version: entry.status!.version }), {
      title: t(`integrations.installHost.${action}`), detail: t("integrations.installHost.machine"),
      confirmLabel: t(`integrations.installHost.${action}`), variant: "warning",
      returnFocus: () => {
        if (!disposed && generation === focusGeneration && identity() === owner && epoch() === captured.epoch && signature(id) === captured.signature
          && opener?.isConnected && opener.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true }) && !opener.closest('[inert], [aria-hidden="true"]') && !opener.matches(":disabled")) opener.focus({ preventScroll: true })
      },
    }, signal)
    const current = accepted && !signal.aborted && target === captured && identity() === owner
      && epoch() === captured.epoch && signature(id) === captured.signature
    cancel()
    if (!current) return
    setPending(true)
    try {
      // Once admitted, cancellation/navigation cannot promise rollback. Never replay this request.
      const result = await integrationAttachmentRequest<IntegrationInstallHostResponse>(instanceId, directory, id, "install-host", new AbortController().signal, {})
      if (!["installed", "updated", "unchanged", "refused", "failed"].includes(result?.outcome)) throw new Error("Invalid installation result")
      if (!disposed && identity() === owner) showToastNotification({ category: "opencode", variant: ["refused", "failed"].includes(result.outcome) ? "error" : "success",
        message: t(`integrations.installHost.${result.outcome}`) })
    } catch (error) {
      if (!disposed && identity() === owner) showToastNotification({ category: "opencode", variant: "error", message: t(
        error instanceof HttpResponseError && error.code === "unsupported" ? "integrations.installHost.unsupported" : "integrations.installHost.error") })
    } finally { setPending(false); void integrations.refreshDemanded(instanceId) }
  }
  return { pending, action: (id: string) => !pending() ? eligible(id)?.status?.host?.action : undefined, open }
}
