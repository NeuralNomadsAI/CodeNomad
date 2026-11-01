import { Dialog } from "@kobalte/core/dialog"
import { For, Show, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js"
import type { IntegrationAttachResponse, IntegrationDetachResponse, IntegrationHostOffer, IntegrationHostsResponse, IntegrationView } from "../../../server/src/integration-types"
import { integrationAttachmentRequest } from "../lib/integrations-api"
import { useI18n } from "../lib/i18n"
import { HttpResponseError } from "../lib/retryable-file-search"
import { integrationEpoch, integrations } from "../stores/integrations"

interface Target { id: string; title?: string; metadata?: Record<string, unknown> }
interface Offer { integration: IntegrationView; host: IntegrationHostOffer }
interface Capture { instanceId: string; directory: string; session: Target; identity: string; epoch: string }
const attachable = (entry: IntegrationView) => entry.family === "native" && entry.state === "ok"
  && entry.status?.host?.state !== "unsupported" && (entry.status?.connection?.offers ?? 0) > 0

/** Shared trusted picker for conversation and Plugins entry points. Offers are read only on explicit open. */
export function createIntegrationAttachment(props: {
  instanceId: string; directory: string; session?: Target | null; active?: boolean
}) {
  const { t } = useI18n()
  const state = createMemo(() => integrations.state(props.instanceId, props.directory))
  const response = () => { const value = state(); return value.status === "ready" ? value.response : undefined }
  const entries = () => { const value = state(); return value.status === "ready" && !value.stale ? value.response.integrations : [] }
  const available = () => props.active !== false && Boolean(props.session) && entries().some(attachable)
  const unsupported = () => response()?.integrations.some(entry => entry.family === "native" && entry.state === "ok" && entry.status?.host?.state === "unsupported")
  const identity = createMemo(() => JSON.stringify([props.instanceId, props.directory, props.session?.id, props.active !== false]))
  // Maps notify every reader; equality here isolates this view from other workspaces and sessions.
  const epoch = createMemo(() => integrationEpoch(props.instanceId, props.session?.id))
  const [capture, setCapture] = createSignal<Capture>()
  const [offers, setOffers] = createSignal<Offer[]>([])
  const [selected, setSelected] = createSignal<Offer>()
  const [pending, setPending] = createSignal(false)
  const [error, setError] = createSignal<string>()
  // Captured action receipts survive native echoes; they describe an action, never a live binding.
  const [operation, setOperation] = createSignal<Offer>()
  const [outcome, setOutcome] = createSignal<"attached" | "detached" | "none">()
  let controller: AbortController | undefined
  let cancel: HTMLButtonElement | undefined
  const close = () => { controller?.abort(); setCapture(undefined); setOperation(undefined); setOutcome(undefined); setError(undefined); setOffers([]); setSelected(undefined); setPending(false) }
  createEffect(() => {
    const instanceId = props.instanceId, directory = props.directory
    if (props.active === false || !directory) return
    onCleanup(integrations.demand(instanceId, directory))
  })
  createEffect(on(identity, close))
  createEffect(on(epoch, () => {
    if (!operation()) { close(); return }
    controller?.abort()
    setOffers([]); setSelected(undefined)
  }, { defer: true }))
  onCleanup(close)
  const owns = (value: Capture) => props.active !== false && value.identity === identity() && capture() === value
  const current = (value: Capture) => owns(value) && value.epoch === epoch() && !controller?.signal.aborted
  const fail = (failure: unknown) => t(failure instanceof HttpResponseError && failure.status === 403 ? "integrations.error.placement"
    : failure instanceof HttpResponseError && failure.code === "unsupported" ? "integrations.unsupported" : "integrations.error.retry")
  const open = async (integrationId?: string) => {
    const session = props.session
    if (!available() || !session) return
    const candidates = entries().filter(entry => attachable(entry) && (!integrationId || entry.id === integrationId))
    if (!candidates.length) return
    close()
    const value: Capture = { instanceId: props.instanceId, directory: props.directory, session: { ...session }, identity: identity(), epoch: epoch() }
    controller = new AbortController()
    const signal = controller.signal
    setCapture(value); setError(undefined); setPending(true)
    try {
      const rows = await Promise.all(candidates.map(async integration => {
        if (!current(value)) return []
        const result = await integrationAttachmentRequest<IntegrationHostsResponse>(value.instanceId, value.directory, integration.id, "hosts", signal)
        return result.offers.map(host => ({ integration, host }))
      }))
      if (!current(value)) return
      setOffers(rows.flat())
    } catch (failure) { if (current(value)) setError(fail(failure)) }
    finally { if (current(value)) setPending(false) }
  }
  const reattach = (offer: Offer) => {
    const hint = capture()?.session.metadata?.["codenomad.integrationAttachment"]
    if (!hint || typeof hint !== "object") return false
    const value = hint as Record<string, unknown>
    return value.integration === offer.integration.id && value.label === offer.host.label && typeof value.attachedAt === "number"
  }
  const mutate = async (action: "attach" | "detach") => {
    const value = capture(), offer = action === "attach" ? selected() : operation()
    if (!value || !offer || !owns(value) || pending()) return
    if (action === "attach" ? !current(value) || offer.host.protocol !== "ok" : outcome() !== "attached") return
    setOperation(offer); setOffers([]); setSelected(undefined)
    setPending(true); setError(undefined)
    try {
      const result = await integrationAttachmentRequest<IntegrationAttachResponse | IntegrationDetachResponse>(value.instanceId, value.directory,
        // Finish the admitted write across native echoes; navigation still fences its feedback.
        offer.integration.id, action, new AbortController().signal, { sessionID: value.session.id, ...(action === "attach" ? { offerID: offer.host.offerID } : {}) })
      if (!owns(value)) return
      if (result.outcome === "attached" || result.outcome === "detached" || result.outcome === "none") setOutcome(result.outcome)
      else setError(t(`integrations.outcome.${result.outcome}`))
    } catch (failure) { if (owns(value)) setError(fail(failure)) }
    finally { if (owns(value)) setPending(false) }
  }
  const picker = () => <Show when={capture()}>{value => <Dialog open modal onOpenChange={next => { if (!next) close() }}>
    <Dialog.Portal><Dialog.Overlay class="modal-overlay z-[1300]" />
      <Dialog.Content class="window-shell integration-attachment" onOpenAutoFocus={event => { event.preventDefault(); cancel?.focus() }}>
        <header class="window-header"><Dialog.Title class="window-title">{t("integrations.attach")}</Dialog.Title></header>
        <div class="window-body integration-attachment-body">
          <p><strong>{t("integrations.conversation")}</strong> <bdi>{value().session.title || t("sessionList.session.untitled")}</bdi></p>
          <Dialog.Description>{t(operation() ? "integrations.machine" : "integrations.warning")}</Dialog.Description>
          <Show when={!operation()}><p>{t("integrations.machine")}</p></Show>
          <Show when={operation()} fallback={
            <Show when={!pending()} fallback={<p role="status">{t("integrations.loading")}</p>}>
              <Show when={offers().length > 0} fallback={<p>{t("integrations.empty")}</p>}>
                <div class="integration-attachment-offers" role="group" aria-label={t("integrations.application")}>
                  <For each={offers()}>{offer => <button type="button" class="window-action" aria-pressed={selected() === offer}
                    disabled={offer.host.protocol !== "ok"} onClick={() => setSelected(offer)}>
                    <strong><bdi>{offer.integration.app.name}</bdi></strong>
                    <span><bdi>{offer.host.label}</bdi></span>
                    <Show when={offer.host.document}><span><bdi>{offer.host.document}</bdi></span></Show>
                    <Show when={reattach(offer)}><span>{t("integrations.reattach", { label: offer.host.label })}</span></Show>
                  </button>}</For>
                </div>
              </Show>
            </Show>
          }>{captured => <>
            <p><strong><bdi>{captured().integration.app.name}</bdi></strong> <bdi>{captured().host.label}</bdi> <bdi>{captured().host.document}</bdi></p>
            <Show when={pending()}><p role="status">{t("integrations.working")}</p></Show>
            <Show when={outcome()}>{result => <p role="status">{t(result() === "attached" ? "integrations.observed" : "integrations.detachedObserved", { label: captured().host.label })}</p>}</Show>
          </>}</Show>
          <p role="alert">{error() ?? ""}</p>
        </div>
        <footer class="window-footer">
          <button ref={cancel} type="button" class="button-secondary" onClick={close}>{t(outcome() ? "alertDialog.actions.ok" : "alertDialog.actions.cancel")}</button>
          <Show when={!operation()}><button type="button" class="button-primary" disabled={pending() || !selected()} onClick={() => void mutate("attach")}>
            {t(selected() && reattach(selected()!) ? "integrations.reattachConfirm" : "integrations.confirm")}
          </button></Show>
          <Show when={outcome() === "attached"}><button type="button" class="button-primary" disabled={pending()} onClick={() => void mutate("detach")}>{t("integrations.detach")}</button></Show>
        </footer>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog>}</Show>
  return { available, unsupported, entries, response, state, open, picker, canAttach: (id: string) => available() && entries().some(entry => entry.id === id && attachable(entry)) }
}
