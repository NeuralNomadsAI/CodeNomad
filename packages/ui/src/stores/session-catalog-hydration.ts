import { batch } from "solid-js"
import type { PersistedSessionCatalogEntry } from "./session-catalog-persistence"
import { getAuthoritativelyDeletedSessionIdsForInstance, setSessions, setSessionPage } from "./session-state"

const seeded = new WeakMap<PersistedSessionCatalogEntry[], Set<string>>()

export function seedSessionCatalog(instanceId: string, catalog: PersistedSessionCatalogEntry[] | undefined): void {
  if (!catalog || seeded.get(catalog)?.has(instanceId)) return
  const bindings = seeded.get(catalog) ?? new Set<string>()
  bindings.add(instanceId)
  seeded.set(catalog, bindings)
  const deleted = getAuthoritativelyDeletedSessionIdsForInstance(instanceId)
  const candidates: string[] = []
  batch(() => {
    setSessions(previous => {
      const current = new Map(previous.get(instanceId) ?? [])
      for (const row of catalog) {
        if (current.has(row.id) || deleted.has(row.id)) continue
        current.set(row.id, { ...row, instanceId, status: "idle", runtimeStatusKnown: false, catalogSnapshot: true })
        candidates.push(row.id)
      }
      return new Map(previous).set(instanceId, current)
    })
    // Keep candidate IDs until scope is known. getSessionListIds projects only
    // actual display roots and reacts when directory-only metadata arrives.
    if (candidates.length) setSessionPage(instanceId, candidates, true, false)
  })
}
