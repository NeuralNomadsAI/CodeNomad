import { createSignal } from "solid-js"
import type { SessionArchiveFilter, SessionFamilySort } from "./session-tree"
import type { SessionFavorites } from "../../../server/src/api-types"

function createView() {
  return {
    query: createSignal(""),
    sort: createSignal<SessionFamilySort>("activity"),
    directory: createSignal(""),
    main: createSignal(true),
    children: createSignal(false),
    archive: createSignal<SessionArchiveFilter>("active"),
    favoritesOnly: createSignal(false),
    favoriteRecords: {} as SessionFavorites,
    ids: [] as string[],
    projected: false,
  }
}

const byInstance = new Map<string, ReturnType<typeof createView>>()

export function getSessionListView(instanceId: string) {
  let view = byInstance.get(instanceId)
  if (!view) byInstance.set(instanceId, view = createView())
  return view
}

export function clearSessionListView(instanceId: string) {
  byInstance.delete(instanceId)
}
