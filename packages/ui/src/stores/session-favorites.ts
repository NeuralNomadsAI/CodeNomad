import { createEffect, createSignal, on, onCleanup, type Accessor } from "solid-js"
import type { SessionFavorites } from "../../../server/src/api-types"
import { serverApi } from "../lib/api-client"
import { serverEvents } from "../lib/server-events"

export function hasProtectedFavorite(data: SessionFavorites, id: string): boolean {
  return Object.hasOwn(data, id) || Object.values(data).some(parents => Array.isArray(parents) && parents.includes(id))
}

export async function allowsFavoriteCleanup(instanceId: string, id: string): Promise<boolean> {
  try { return !hasProtectedFavorite(await serverApi.fetchSessionFavorites(instanceId), id) }
  catch { return false }
}

export function useSessionFavorites(instanceId: Accessor<string>) {
  const [records, setRecords] = createSignal<SessionFavorites>({})
  const [ready, setReady] = createSignal(false)
  const [pending, setPending] = createSignal(new Set<string>())
  let refresh = (): Promise<void> => Promise.resolve()
  let generation = 0
  createEffect(on(instanceId, id => {
    const owner = ++generation
    setRecords({})
    setReady(false)
    setPending(new Set<string>())
    const controller = new AbortController()
    let reading: Promise<void> | undefined, dirty = false, epoch = 0
    const read = () => {
      dirty = true
      epoch++
      return reading ??= (async () => {
        do {
          dirty = false
          const requested = epoch
          try {
            const data = await serverApi.readSessionFavoritesInBackground(id, controller.signal)
            if (owner === generation && requested === epoch) {
              if (JSON.stringify(data) !== JSON.stringify(records())) setRecords(data)
              setReady(true)
            }
          } catch { /* Keep the last successful view until a new event or reconnect. */ }
        } while (dirty && owner === generation)
      })().finally(() => { reading = undefined })
    }
    refresh = read
    const offEvent = serverEvents.on("storage.stateChanged", event => {
      if (event.type === "storage.stateChanged" && (event.owner === "sessionFavorites" || event.owner === "*")) void refresh()
    })
    const offOpen = serverEvents.onOpen(refresh)
    void refresh()
    onCleanup(() => { generation++; controller.abort(); offEvent(); offOpen() })
  }))

  const save = async (id: string, favorite: boolean) => {
    if (pending().has(id)) return
    const owner = generation
    setPending(previous => new Set(previous).add(id))
    try {
      await serverApi.saveSessionFavorite(instanceId(), id, favorite)
      if (owner === generation) await refresh()
    } finally {
      if (owner === generation) setPending(previous => { const next = new Set(previous); next.delete(id); return next })
    }
  }
  return { records, ready, pending, save }
}
