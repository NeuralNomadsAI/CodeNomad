import { createEffect, createSignal, on, onCleanup, type Accessor } from "solid-js"
import type { SessionFavorites, SessionFavoritesSnapshot } from "../../../server/src/api-types"
import { serverApi } from "../lib/api-client"
import { serverEvents } from "../lib/server-events"

export function useSessionFavorites(instanceId: Accessor<string>) {
  const [records, setRecords] = createSignal<SessionFavorites>({})
  const [ready, setReady] = createSignal(false)
  const [pending, setPending] = createSignal(new Set<string>())
  let publish = (_snapshot: SessionFavoritesSnapshot) => {}
  let refresh = (_reconcile?: boolean): Promise<void> => Promise.resolve()
  let generation = 0
  createEffect(on(instanceId, id => {
    const owner = ++generation
    setRecords({})
    setReady(false)
    setPending(new Set<string>())
    const controller = new AbortController()
    let reading: Promise<void> | undefined, dirty = false, reconcile = false, epoch = 0
    let published: SessionFavoritesSnapshot | undefined
    const retired = new Set<string>()
    publish = snapshot => {
      if (!snapshot || typeof snapshot.source !== "string" || !Number.isSafeInteger(snapshot.revision)
        || !snapshot.records || typeof snapshot.records !== "object" || Array.isArray(snapshot.records)) throw new Error("Invalid favorites snapshot")
      if (owner !== generation || retired.has(snapshot.source)) return
      if (published?.source === snapshot.source && snapshot.revision <= published.revision) return
      if (published && published.source !== snapshot.source) retired.add(published.source)
      published = snapshot
      if (JSON.stringify(snapshot.records) !== JSON.stringify(records())) setRecords(snapshot.records)
      setReady(true)
    }
    const read = (reconcileOnRead = false) => {
      dirty = true
      reconcile ||= reconcileOnRead
      epoch++
      return reading ??= (async () => {
        do {
          dirty = false
          const requested = epoch
          const shouldReconcile = reconcile
          reconcile = false
          try {
            const data = await serverApi.readSessionFavoritesInBackground(id, controller.signal, shouldReconcile)
            if (requested === epoch) publish(data)
          } catch { /* Keep the last successful view until a new event or reconnect. */ }
        } while (dirty && owner === generation)
      })().finally(() => { reading = undefined })
    }
    refresh = read
    const offEvent = serverEvents.on("storage.stateChanged", event => {
      if (event.type === "storage.stateChanged" && event.owner === "sessionFavorites") void read()
    })
    const offOpen = serverEvents.onOpen(() => read(true))
    const offNative = serverEvents.on("instance.event", event => {
      if (event.type === "instance.event" && event.instanceId === id && event.event.type === "server.connected") void read(true)
    })
    void read(true)
    onCleanup(() => { generation++; controller.abort(); offEvent(); offOpen(); offNative() })
  }))

  const save = async (id: string, favorite: boolean) => {
    if (pending().has(id)) return
    const owner = generation
    setPending(previous => new Set(previous).add(id))
    try {
      const snapshot = await serverApi.saveSessionFavorite(instanceId(), id, favorite)
      if (owner === generation) {
        publish(snapshot)
        void refresh()
      }
    } finally {
      if (owner === generation) setPending(previous => { const next = new Set(previous); next.delete(id); return next })
    }
  }
  return { records, ready, pending, save }
}
