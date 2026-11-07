import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js"
import type { PanelExtensionSummary } from "../../../../server/src/api-types"
import { panelExtensionsFor } from "../../lib/panel-extensions-backend"
import { captureBackendOperation } from "../../lib/backend-operation"
import { backendEvents as serverEvents } from "../../lib/server-events"

export function usePanelExtensions(instanceId: Accessor<string>, active: Accessor<boolean>) {
  const [entries, setEntries] = createSignal<PanelExtensionSummary[]>([])
  const [failed, setFailed] = createSignal(false)
  const [verified, setVerified] = createSignal(false)
  const [activating, setActivating] = createSignal(false)
  const [lifetime, setLifetime] = createSignal(1)
  let generation = 0, controller: AbortController | undefined
  let read: { generation: number; again: boolean; promise: Promise<void> } | undefined
  let activation: object | undefined
  let connected = true
  let disposed = false
  const clear = () => {
    generation++; controller?.abort(); read = undefined; activation = undefined
    setVerified(false); setActivating(false)
    setLifetime(generation + 1)
  }
  const refresh = (): Promise<void> => {
    setVerified(false)
    if (!active() || !connected || disposed) return Promise.resolve()
    if (read?.generation === generation) { read.again = true; return read.promise }
    const current = generation, id = instanceId()
    controller = new AbortController()
    const operation = captureBackendOperation(id, controller.signal, () => !disposed)
    if (!operation.current()) return Promise.resolve()
    const owns = () => operation.current() && current === generation && id === instanceId() && active() && connected
    const owned = { generation: current, again: false, promise: Promise.resolve() }
    read = owned
    owned.promise = Promise.resolve().then(async () => {
      do {
        owned.again = false
        try {
          if (!owns()) return
          const entries = await panelExtensionsFor(id, operation.signal).panelExtensionsApi.list(operation.signal)
          if (owns() && !owned.again) { setEntries(entries); setFailed(false); setVerified(true) }
        } catch { if (owns() && !owned.again) { setFailed(true) } }
      } while (owns() && owned.again)
    }).finally(() => { if (read === owned) read = undefined })
    return owned.promise
  }
  const activate = async (entry: PanelExtensionSummary, enabled: boolean) => {
    if (disposed || activating() || !verified() || !active() || !connected) return
    const id = instanceId()
    const epoch = generation, owner = {}
    const operation = captureBackendOperation(id)
    const current = () => operation.current() && !disposed && epoch === generation && id === instanceId() && active() && connected
    if (!current()) return
    activation = owner; setActivating(true); setFailed(false)
    try {
      await panelExtensionsFor(id, operation.signal).panelExtensionsApi.activate(entry.manifest.id, entry.digest, enabled)
      if (current()) await refresh()
    } catch { if (current()) { await refresh(); if (current()) setFailed(true) } }
    finally { if (activation === owner) { activation = undefined; setActivating(false) } }
  }
  createEffect(() => { serverEvents.signalForInstance(instanceId()); active(); clear(); setEntries([]); void refresh() })
  onCleanup(serverEvents.forInstance(instanceId).on("storage.stateChanged", event => {
    if ("owner" in event && event.owner === "panelExtensions") void refresh()
  }))
  onCleanup(serverEvents.forInstance(instanceId).onTransportStatus(status => {
    const next = status === "connected"
    if (connected === next) return
    connected = next
    clear()
    if (connected) void refresh()
  }))
  onCleanup(() => { disposed = true; clear() })
  return { entries, failed, verified, refresh, activating, activate, lifetime,
    captureOperation: () => {
      const id = instanceId()
      const epoch = generation
      const operation = captureBackendOperation(id, undefined, () => !disposed && epoch === generation && id === instanceId() && active() && connected)
      return { ...operation, api: () => panelExtensionsFor(id, operation.signal).panelExtensionsApi }
    } }
}
export type PanelExtensionsController = ReturnType<typeof usePanelExtensions>
