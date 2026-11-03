import { Dialog } from "@kobalte/core/dialog"
import { For, Show, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js"
import type { IntegrationAttachResponse, IntegrationDetachResponse, IntegrationHostOffer, IntegrationHostsResponse, IntegrationView } from "../../../server/src/integration-types"
import { INTEGRATION_ATTACHMENT_METADATA_KEY } from "../../../server/src/integration-types"
import { integrationAttachmentRequest } from "../lib/integrations-api"
import { useI18n } from "../lib/i18n"
import { HttpResponseError } from "../lib/retryable-file-search"
import { integrationBindings, integrationEpoch, integrations } from "../stores/integrations"
import type { IntegrationBindingTarget } from "../stores/integration-bindings-store"
import { claimIntegrationConfirmation, INTEGRATION_CONFIRM_DELAY_MS } from "./integration-confirmation"

interface Target { id: string; title?: string; metadata?: Record<string, unknown> }
interface Offer { integration: IntegrationView; host: IntegrationHostOffer }
interface Capture { instanceId: string; directory: string; session: Target; identity: string; epoch: string; openedAt: number; release: () => void; returnFocus: () => void }
const attachable = (entry: IntegrationView) => entry.family === "native" && entry.state === "ok"
  && entry.status?.host?.state !== "unsupported" && (entry.status?.connection?.offers ?? 0) > 0

/** A CodeNomad route refused the request before any application effect; anything else after sending is uncertain. */
const refusedBeforeEffect = (failure: unknown) => failure instanceof HttpResponseError && failure.status >= 400 && failure.status < 500

/**
 * The attachment of the displayed conversation, one per Status tab: the trusted picker (offers are read only on an
 * explicit open), the authoritative binding read of each native integration, the one-click local Detach (D24) and
 * the uncertain receipts of submitted actions. Nothing is ever replayed.
 */
export function createIntegrationAttachment(props: {
  instanceId: string; directory: string; session?: Target | null; active?: boolean
  /** Messages after an action, for the Status announcements. */
  onMessage?: (message: string) => void
}) {
  const { t } = useI18n()
  const state = createMemo(() => integrations.state(props.instanceId, props.directory))
  const response = () => { const value = state(); return value.status === "ready" ? value.response : undefined }
  const entries = () => { const value = state(); return value.status === "ready" && !value.stale ? value.response.integrations : [] }
  const identity = createMemo(() => JSON.stringify([props.instanceId, props.directory, props.session?.id, props.active !== false]))
  const bindingEntries = () => response()?.integrations.filter(entry => entry.family === "native" && entry.configured) ?? []
  const target = (integrationId: string): IntegrationBindingTarget => ({ instanceId: props.instanceId, directory: props.directory, sessionID: props.session?.id ?? "", integrationId })
  const bindingDemand = createMemo(() => JSON.stringify([identity(), bindingEntries().map(entry => entry.id)]))
  createEffect(on(bindingDemand, () => {
    if (props.active === false || !props.session || !props.directory) return
    const releases = bindingEntries().map(entry => integrationBindings.demand(target(entry.id)))
    onCleanup(() => releases.forEach(release => release()))
  }))
  const binding = (integrationId: string) => props.session ? integrationBindings.state(target(integrationId)) : { state: "unknown" as const }
  const attached = (integrationId: string) => binding(integrationId).state === "attached"
  // Maps notify every reader; equality here isolates this view from other workspaces and sessions.
  const epoch = createMemo(() => integrationEpoch(props.instanceId, props.session?.id))
  const [capture, setCapture] = createSignal<Capture>()
  const [offers, setOffers] = createSignal<Offer[]>([])
  const [selected, setSelected] = createSignal<Offer>()
  const [pending, setPending] = createSignal(false)
  const [ready, setReady] = createSignal(false)
  const [error, setError] = createSignal<string>()
  // Captured action receipts survive native echoes; they describe an action, never a live binding.
  const [operation, setOperation] = createSignal<Offer>()
  const [outcome, setOutcome] = createSignal<"attached">()
  // Submitted actions whose effect is unknown, per integration, for the identity that sent them.
  const [receipts, setReceipts] = createSignal<ReadonlyMap<string, string>>(new Map())
  const [detaching, setDetaching] = createSignal<ReadonlySet<string>>(new Set())
  let controller: AbortController | undefined
  let readyTimer: ReturnType<typeof setTimeout> | undefined
  let cancel: HTMLButtonElement | undefined
  let viewGeneration = 0
  let disposed = false
  const close = () => {
    controller?.abort(); clearTimeout(readyTimer); capture()?.release()
    setCapture(undefined); setOperation(undefined); setOutcome(undefined); setError(undefined); setOffers([]); setSelected(undefined); setPending(false); setReady(false)
  }
  const receipt = (integrationId: string, owner: string) => setReceipts(current => new Map(current).set(integrationId, owner))
  const clearReceipt = (integrationId: string) => setReceipts(current => { const next = new Map(current); next.delete(integrationId); return next })
  createEffect(on(identity, () => { viewGeneration++; close(); setReceipts(new Map()) }))
  createEffect(on(epoch, () => {
    if (!operation()) { close(); return }
    controller?.abort()
    setOffers([]); setSelected(undefined)
  }, { defer: true }))
  onCleanup(() => { disposed = true; close() })
  const owns = (value: Capture) => props.active !== false && value.identity === identity() && capture() === value
  const current = (value: Capture) => owns(value) && value.epoch === epoch() && !controller?.signal.aborted
  const fail = (failure: unknown) => t(failure instanceof HttpResponseError && failure.status === 403 ? "integrations.error.placement"
    : failure instanceof HttpResponseError && failure.code === "unsupported" ? "integrations.state.unsupported" : "integrations.error.retry")
  const canOpen = (integrationId: string) => props.active !== false && Boolean(props.session)
    && entries().some(entry => entry.id === integrationId && attachable(entry))
  const open = async (integrationId: string) => {
    const session = props.session
    const integration = entries().find(entry => entry.id === integrationId)
    if (!session || !integration || !canOpen(integrationId) || capture()) return
    const release = claimIntegrationConfirmation()
    if (!release) return
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    const generation = ++viewGeneration
    const signature = JSON.stringify(entries())
    const value: Capture = { instanceId: props.instanceId, directory: props.directory, session: { ...session }, identity: identity(), epoch: epoch(),
      openedAt: Date.now(), release,
      returnFocus: () => {
        if (!disposed && !capture() && generation === viewGeneration && value.identity === identity() && value.epoch === epoch() && signature === JSON.stringify(entries())
          && opener?.isConnected && opener.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true }) && !opener.closest('[inert], [aria-hidden="true"]') && !opener.matches(":disabled")) opener.focus({ preventScroll: true })
      } }
    controller = new AbortController()
    const signal = controller.signal
    setCapture(value); setError(undefined); setPending(true)
    readyTimer = setTimeout(() => { if (capture() === value) setReady(true) }, INTEGRATION_CONFIRM_DELAY_MS)
    try {
      const result = await integrationAttachmentRequest<IntegrationHostsResponse>(value.instanceId, value.directory, integration.id, "hosts", signal)
      if (!current(value)) return
      setOffers(result.offers.map(host => ({ integration, host })))
      const only = result.offers.length === 1 && result.offers[0]!.protocol === "ok" ? result.offers[0] : undefined
      if (only) setSelected({ integration, host: only })
    } catch (failure) { if (current(value)) setError(fail(failure)) }
    finally { if (current(value)) setPending(false) }
  }
  const hintLabel = (integrationId: string) => {
    const value = props.session?.metadata?.[INTEGRATION_ATTACHMENT_METADATA_KEY]
    if (!value || typeof value !== "object") return undefined
    const hint = value as Record<string, unknown>
    return hint.integration === integrationId && typeof hint.label === "string" && typeof hint.attachedAt === "number" ? hint.label : undefined
  }
  const reattach = (offer: Offer) => hintLabel(offer.integration.id) === offer.host.label
  const attach = async () => {
    const value = capture(), offer = selected()
    if (!value || !offer || !owns(value) || pending() || !ready() || Date.now() - value.openedAt < INTEGRATION_CONFIRM_DELAY_MS) return
    if (!current(value) || offer.host.protocol !== "ok") return
    const bindingTarget = target(offer.integration.id)
    if (integrationBindings.busy(bindingTarget)) return
    setOperation(offer); setOffers([]); setSelected(undefined)
    setPending(true); setError(undefined)
    await integrationBindings.run(bindingTarget, async () => { try {
      const result = await integrationAttachmentRequest<IntegrationAttachResponse>(value.instanceId, value.directory,
        // Finish the admitted write across native echoes; navigation still fences its feedback.
        offer.integration.id, "attach", new AbortController().signal, { sessionID: value.session.id, offerID: offer.host.offerID })
      if (!owns(value)) return
      if (result.outcome === "attached") setOutcome(result.outcome)
      else if (["busy", "gone", "refused"].includes(result.outcome)) {
        const message = t(`integrations.outcome.${result.outcome}`)
        setError(message); props.onMessage?.(message)
      } else { receipt(offer.integration.id, value.identity); setError(fail(undefined)) }
    } catch (failure) {
      if (!refusedBeforeEffect(failure)) receipt(offer.integration.id, value.identity)
      if (owns(value)) setError(fail(failure))
    }
    finally { if (owns(value)) setPending(false) } })
  }
  /** D24: one explicit click, at most one `detachHost` for the displayed conversation only. */
  const detach = async (integrationId: string) => {
    const captured = identity(), bindingTarget = target(integrationId)
    if (props.active === false || !props.session || !attached(integrationId) || integrationBindings.busy(bindingTarget)
      || detaching().has(integrationId) || receipts().has(integrationId)) return
    setDetaching(current => new Set(current).add(integrationId))
    try {
      await integrationBindings.run(bindingTarget, async () => {
        try {
          const result = await integrationAttachmentRequest<IntegrationDetachResponse>(bindingTarget.instanceId, bindingTarget.directory, integrationId,
            "detach", new AbortController().signal, { sessionID: bindingTarget.sessionID })
          if (result?.outcome !== "detached" && result?.outcome !== "none") receipt(integrationId, captured)
        } catch (failure) {
          if (!refusedBeforeEffect(failure)) receipt(integrationId, captured)
          else if (identity() === captured) props.onMessage?.(fail(failure))
        }
      })
    } finally { setDetaching(current => { const next = new Set(current); next.delete(integrationId); return next }) }
  }
  /** A new authoritative read; it settles an uncertain receipt. */
  const refresh = (integrationId: string) => {
    if (!props.session || props.active === false) return
    clearReceipt(integrationId)
    void integrationBindings.refresh(target(integrationId))
    void integrations.refreshDemanded(props.instanceId)
  }
  const picker = () => <Show when={capture()} keyed>{value => <Dialog open modal onOpenChange={next => { if (!next) close() }}>
    <Dialog.Portal><Dialog.Overlay class="modal-overlay z-[1300]" />
      <Dialog.Content class="window-shell integration-attachment" onOpenAutoFocus={event => { event.preventDefault(); cancel?.focus() }}
        onCloseAutoFocus={event => { event.preventDefault(); value.returnFocus() }}>
        <header class="window-header"><Dialog.Title class="window-title">{t("integrations.attachTitle")}</Dialog.Title></header>
        <div class="window-body integration-attachment-body">
          <p><strong>{t("integrations.conversation")}</strong> <bdi>{value.session.title || t("sessionList.session.untitled")}</bdi></p>
          <Show when={operation()} fallback={
            <Show when={!pending()} fallback={<p role="status">{t("integrations.loading")}</p>}>
              <Show when={offers().length > 0} fallback={<p>{t("integrations.empty")}</p>}>
                <Show when={selected()}>{offer => <Dialog.Description>{t("integrations.attachConfirm", {
                  label: offer().host.document ?? offer().host.label,
                  app: [offer().integration.app.name, offer().host.appVersion].filter(Boolean).join(" ") })}</Dialog.Description>}</Show>
                <p>{t("integrations.machine")}</p>
                <div class="integration-attachment-offers" role="group" aria-label={t("integrations.application")}>
                  <For each={offers()}>{offer => <button type="button" class="window-action" aria-pressed={selected()?.host.offerID === offer.host.offerID}
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
            <Show when={outcome()}><p role="status">{t("integrations.observed", { label: captured().host.label })}</p></Show>
          </>}</Show>
          <p role="alert">{error() ?? ""}</p>
        </div>
        <footer class="window-footer">
          <button ref={cancel} type="button" class="button-secondary" onClick={close}>{t(outcome() ? "alertDialog.actions.ok" : "alertDialog.actions.cancel")}</button>
          <Show when={!operation()}><button type="button" class="button-primary" disabled={pending() || !selected() || !ready()} onClick={() => void attach()}>
            {t(selected() && reattach(selected()!) ? "integrations.reattachConfirm" : "integrations.confirm")}
          </button></Show>
        </footer>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog>}</Show>
  const available = () => props.active !== false && Boolean(props.session) && entries().some(attachable)
  const unsupported = () => response()?.integrations.some(entry => entry.family === "native" && entry.state === "ok" && entry.status?.host?.state === "unsupported")
  const indicator = () => <Show when={props.active !== false && props.session}>
    <div class="integration-bindings"><For each={bindingEntries()}>{entry => {
      const label = () => { const value = binding(entry.id); return value.state === "attached" ? value.label : undefined }
      return <Show when={label()}><div class="integration-binding" data-integration-binding={entry.id}>
        <span class="integration-binding-label"><bdi>{entry.app.name}</bdi>: <bdi>{label()}</bdi></span>
        <button type="button" class="window-text-button" onClick={() => void detach(entry.id)}>{t("integrations.detach")}</button>
      </div></Show>
    }}</For></div>
  </Show>
  return {
    available, unsupported, indicator, canAttach: canOpen, openAny: () => { const first = entries().find(attachable); if (first) void open(first.id) },
    entries, response, state, open, picker, canOpen, detach, refresh, binding, hintLabel,
    /** A mutation for the displayed conversation is in flight. */
    busy: (integrationId: string) => integrationBindings.busy(target(integrationId)) || detaching().has(integrationId),
    /** A submitted action's effect is unknown until the next explicit read. */
    uncertain: (integrationId: string) => receipts().get(integrationId) === identity(),
  }
}
