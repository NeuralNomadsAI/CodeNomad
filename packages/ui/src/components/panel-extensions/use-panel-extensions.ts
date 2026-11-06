import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js"
import type { PanelExtensionSummary } from "../../../../server/src/api-types"
import { panelExtensionsApi } from "../../lib/panel-extensions-api"
import { captureBackendOperation } from "../../lib/backend-operation"
import { backendEvents as serverEvents } from "../../lib/server-events"

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
    const operation = captureBackendOperation(id, controller.signal, () => !disposed)
    if (!operation.current()) return
    try {
      const entries = await panelExtensionsApi.list(operation.signal)
      if (operation.current() && current === generation && id === instanceId() && active()) { setEntries(entries); setFailed(false); setVerified(true) }
    } catch { if (operation.current() && current === generation && active()) { setEntries([]); setFailed(true) } }
  }
  const activate = async (entry: PanelExtensionSummary, enabled: boolean) => {
    if (disposed || activating() || !verified() || !active() || !connected) return
    const id = instanceId()
    const operation = captureBackendOperation(id)
    const current = () => operation.current() && !disposed && id === instanceId() && active() && connected
    if (!current()) return
    setActivating(true); setFailed(false)
    try {
      await panelExtensionsApi.activate(entry.manifest.id, entry.digest, enabled)
      if (current()) await refresh()
    } catch { if (current()) { await refresh(); if (current()) setFailed(true) } }
    finally { if (!disposed) setActivating(false) }
  }
  createEffect(() => { serverEvents.signalForInstance(instanceId()); active(); setEntries([]); void refresh() })
  onCleanup(serverEvents.forInstance(instanceId).on("storage.stateChanged", event => {
    if ("owner" in event && event.owner === "panelExtensions") void refresh()
  }))
  onCleanup(serverEvents.forInstance(instanceId).onTransportStatus(status => {
    connected = status === "connected"
    if (!connected) clear(); else void refresh()
  }))
  onCleanup(() => { disposed = true; clear() })
  return { entries, failed, verified, refresh, activating, activate,
    captureOperation: () => captureBackendOperation(instanceId(), undefined, () => !disposed && active() && connected) }
}
export type PanelExtensionsController = ReturnType<typeof usePanelExtensions>
