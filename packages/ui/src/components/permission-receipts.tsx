import { For, Show, createEffect, createSignal, onCleanup, untrack } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import type { PermissionReceipt } from "../../../server/src/api-types"
import { serverApi } from "../lib/api-client"
import { serverEvents } from "../lib/server-events"
import { useI18n } from "../lib/i18n"
import {
  cachedPermissionReceipts, invalidatePermissionReceipts, ownsPermissionReceipt, permissionReceiptKey,
  readPermissionReceipts, rememberPermissionReceipts, type PermissionReceiptSnapshot,
} from "../stores/permission-receipt-cache"

interface PermissionReceiptsProps {
  instanceId: string
  sessionId: string
  messageId?: string
  active: boolean
}

// Mounted transcript rows own their reads; receipts never enter native message,
// copy, search or speech projections.
export default function PermissionReceipts(props: PermissionReceiptsProps) {
  const { t } = useI18n()
  const [state, setState] = createStore<{ receipts: PermissionReceipt[] }>({ receipts: [] })
  const [busy, setBusy] = createSignal(false)
  const [failed, setFailed] = createSignal(false)
  const [next, setNext] = createSignal<string>()
  let read: (more?: boolean) => void = () => {}

  createEffect(() => {
    const { instanceId, sessionId, messageId, active } = props
    setState("receipts", [])
    setNext(undefined)
    setFailed(false)
    setBusy(false)
    read = () => {}
    if (!active || !instanceId || !sessionId || sessionId === "__no_session_draft__") return

    const controller = new AbortController()
    let disposed = false
    let running = false
    let trailing = false
    let pages = 1
    let retryMore = false
    const scope = messageId ? { messageId } : { unanchored: true as const }
    const key = permissionReceiptKey(instanceId, sessionId, scope)
    const show = (snapshot: PermissionReceiptSnapshot) => {
      setState("receipts", reconcile([...new Map(snapshot.receipts.map(receipt => [receipt.requestId, receipt])).values()], { key: "requestId" }))
      setNext(snapshot.next)
      pages = snapshot.pages
    }

    const load = async (more = false) => {
      if (disposed) return
      if (running) {
        if (!more) trailing = true
        return
      }
      running = true
      retryMore = more
      setBusy(true)
      setFailed(false)
      try {
        if (!more) {
          // Shared with remounts of this row; an unmount must not cancel it.
          const snapshot = await readPermissionReceipts(instanceId, sessionId, scope, pages)
          if (disposed) return
          show(snapshot)
          return
        }
        const page = await serverApi.fetchPermissionReceipts(instanceId, sessionId, scope, untrack(next), controller.signal)
        if (disposed) return
        const snapshot = {
          receipts: [...untrack(() => state.receipts), ...page.receipts.filter(receipt => ownsPermissionReceipt(receipt, sessionId, scope))],
          next: page.next, pages: pages + 1,
        }
        rememberPermissionReceipts(key, snapshot)
        show(snapshot)
      } catch {
        if (!disposed) setFailed(true)
      } finally {
        running = false
        if (!disposed) {
          setBusy(false)
          if (trailing) {
            trailing = false
            void load()
          }
        }
      }
    }
    read = (more) => {
      const retry = more ?? (untrack(failed) && retryMore)
      if (!retry) invalidatePermissionReceipts(key)
      void load(retry)
    }
    const refresh = () => {
      invalidatePermissionReceipts(key)
      void load()
    }
    const offEvent = serverEvents.on("permission.receiptsChanged", event => {
      if (event.type !== "permission.receiptsChanged" || event.instanceId !== instanceId || event.sessionId !== sessionId) return
      if (!event.messageId || event.messageId === messageId) refresh()
    })
    const offOpen = serverEvents.onOpen(refresh)
    const cached = cachedPermissionReceipts(key)
    if (cached) show(cached)
    else void load()
    onCleanup(() => {
      disposed = true
      controller.abort()
      offEvent()
      offOpen()
    })
  })

  return (
    <Show when={state.receipts.length > 0 || next() || failed()}>
      <section class="permission-receipts" aria-label={t("permissionReceipts.title")} data-permission-message={props.messageId ?? "unanchored"} aria-busy={busy()}>
        <Show when={!props.messageId} fallback={<ReceiptRows receipts={state.receipts} />}>
          <details>
            <summary>{t("permissionReceipts.session", { count: state.receipts.length })}</summary>
            <ReceiptRows receipts={state.receipts} />
            <Show when={next()}>
              <button type="button" class="button-tertiary" disabled={busy()} onClick={() => read(true)}>{t("permissionReceipts.more")}</button>
            </Show>
          </details>
        </Show>
        <Show when={props.messageId && next()}>
          <button type="button" class="button-tertiary" disabled={busy()} onClick={() => read(true)}>{t("permissionReceipts.more")}</button>
        </Show>
        <Show when={failed()}>
          <div class="permission-receipts-error" role="status">
            <span>{t("permissionReceipts.error")}</span>
            <button type="button" class="button-tertiary" disabled={busy()} onClick={() => read()}>{t("permissionReceipts.retry")}</button>
          </div>
        </Show>
      </section>
    </Show>
  )
}

function ReceiptRows(props: { receipts: PermissionReceipt[] }) {
  const { t } = useI18n()
  return <ul class="permission-receipts-list">
    <For each={props.receipts}>{receipt => (
      <li class="permission-receipt" data-permission-request={receipt.requestId} data-decision={receipt.decision}>
        <div class="permission-receipt-heading">
          <strong>{t(`permissionReceipts.${receipt.decision}`)}</strong>
          <span class="permission-receipt-origin">{t(`permissionReceipts.origin.${receipt.origin}`)}</span>
        </div>
        <Show when={receipt.action}><div class="permission-receipt-action">{receipt.action}</div></Show>
        <For each={receipt.resources}>{resource => <code class="permission-receipt-resource">{resource}</code>}</For>
        <Show when={receipt.requestMessage}><p>{receipt.requestMessage}</p></Show>
        <Show when={receipt.reason}><p class="permission-receipt-reason">{receipt.reason}</p></Show>
      </li>
    )}</For>
  </ul>
}
