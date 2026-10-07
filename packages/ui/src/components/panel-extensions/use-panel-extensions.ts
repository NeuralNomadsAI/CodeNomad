import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js"
import type { PanelExtensionSummary } from "../../../../server/src/api-types"
import { panelExtensionsApi } from "../../lib/panel-extensions-api"
import { serverEvents } from "../../lib/server-events"

export function usePanelExtensions(instanceId: Accessor<string>, active: Accessor<boolean>) {
  const [entries, setEntries] = createSignal<PanelExtensionSummary[]>([])
  const [failed, setFailed] = createSignal(false)
  const [verified, setVerified] = createSignal(false)
  const [activating, setActivating] = createSignal(false)
  let generation = 0, controller: AbortController | undefined
  let connected = true
  let disposed = false
  const clear = () => { generation++; controller?.abort(); setVerified(false) }
  const refresh = async () => {
    clear()
    if (!active() || !connected) return
    const current = generation, id = instanceId()
    controller = new AbortController()
    try {
      const entries = await panelExtensionsApi.list(controller.signal)
      if (current === generation && id === instanceId() && active()) { setEntries(entries); setFailed(false); setVerified(true) }
    } catch { if (current === generation && active()) { setEntries([]); setFailed(true) } }
  }
  const activate = async (entry: PanelExtensionSummary, enabled: boolean) => {
    if (disposed || activating() || !verified() || !active() || !connected) return
    const id = instanceId()
    const current = () => !disposed && id === instanceId() && active() && connected
    setActivating(true); setFailed(false)
    try {
      await panelExtensionsApi.activate(entry.manifest.id, entry.digest, enabled)
      if (current()) await refresh()
    } catch { if (current()) { await refresh(); if (current()) setFailed(true) } }
    finally { if (!disposed) setActivating(false) }
  }
  createEffect(() => { instanceId(); active(); setEntries([]); void refresh() })
  onCleanup(serverEvents.on("storage.stateChanged", event => {
    if ("owner" in event && event.owner === "panelExtensions") void refresh()
  }))
  onCleanup(serverEvents.onTransportStatus(status => {
    connected = status === "connected"
    if (!connected) clear(); else void refresh()
  }))
  onCleanup(() => { disposed = true; clear() })
  return { entries, failed, verified, refresh, activating, activate }
}
export type PanelExtensionsController = ReturnType<typeof usePanelExtensions>
