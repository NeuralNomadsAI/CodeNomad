import { Dialog } from "@kobalte/core/dialog"
import { createSignal, onCleanup, onMount, Show } from "solid-js"
import { useI18n } from "../../lib/i18n"
import { BUNDLES_CONFIRM_GUARD_MS, type BundlesConfirmation, type BundlesLifecycle, type BundlesMount,
  type BundlesPrepared, type BundlesAck } from "../../../../server/src/panel-extensions/bundles-lifecycle"

/** Trusted host-only entry. Posting the ACK completes before preparation or rendering starts. */
export function acknowledgeBundlesRequest(lifecycle: BundlesLifecycle, owner: BundlesMount,
  prepare: (signal: AbortSignal) => Promise<BundlesPrepared>, reply: (ack: BundlesAck) => void): BundlesAck {
  const { ack, afterAck } = lifecycle.request(owner, prepare)
  reply(ack)
  if (ack.outcome === "confirming") setTimeout(afterAck, 0)
  return ack
}

/** Mounted only by a trusted host; its payload is the server-built safe display projection. */
export function BundlesConfirmationView(props: { view: BundlesConfirmation; lifecycle: BundlesLifecycle; owner: BundlesMount }) {
  const { t } = useI18n()
  const [ready, setReady] = createSignal(false)
  const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
  let cancel: HTMLButtonElement | undefined, shownAt = Infinity, timer: ReturnType<typeof setTimeout> | undefined
  const dismiss = () => props.lifecycle.cancel(props.owner, props.view.planID)
  onMount(() => {
    shownAt = Date.now()
    props.lifecycle.displayed(props.owner, props.view.planID)
    timer = setTimeout(() => setReady(true), BUNDLES_CONFIRM_GUARD_MS)
  })
  onCleanup(() => clearTimeout(timer))
  return <Dialog open modal onOpenChange={open => { if (!open) dismiss() }}>
    <Dialog.Portal>
      <Dialog.Overlay class="modal-overlay z-[60]" />
      <Dialog.Content class="alert-dialog window-shell modal-surface fixed left-1/2 top-1/2 z-[1310] w-full max-w-md -translate-x-1/2 -translate-y-1/2 border border-base shadow-2xl"
        onOpenAutoFocus={event => { event.preventDefault(); cancel?.focus() }}
        onCloseAutoFocus={event => { event.preventDefault(); if (returnFocus?.isConnected) returnFocus.focus() }}>
        <div class="window-header"><Dialog.Title class="window-title">{t("integrations.confirmation.title")}</Dialog.Title></div>
        <div class="window-body space-y-2">
          <p><bdi>{t(`integrations.confirmation.${props.view.action}`)}</bdi>: <bdi>{props.view.integration}</bdi> — <bdi>{props.view.version}</bdi></p>
          <p>{t(`instanceServiceStatus.plugins.scope.${props.view.scope}`)}</p>
          <p>{t("integrations.conversation")} <bdi>{props.view.conversation}</bdi></p>
          <Show when={props.view.document}><p>{t("integrations.application")}: <bdi>{props.view.document}</bdi></p></Show>
          <Dialog.Description>{t("integrations.confirmation.machine")}</Dialog.Description>
          <Show when={props.view.action === "attach"}><p>{t("integrations.warning")}</p></Show>
        </div>
        <div class="window-footer">
          <button ref={cancel} type="button" class="button-secondary" onClick={dismiss}>{t("alertDialog.actions.cancel")}</button>
          <button type="button" class="button-primary" disabled={!ready()} onClick={() => {
            if (Date.now() - shownAt >= BUNDLES_CONFIRM_GUARD_MS) props.lifecycle.confirm(props.owner, props.view.planID)
          }}>{t("alertDialog.actions.confirm")}</button>
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog>
}
