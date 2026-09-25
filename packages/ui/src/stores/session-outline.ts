import { createEffect, createMemo, createSignal, onCleanup, type Accessor } from "solid-js"
import type { OutlineEntry, OutlineCheckpoint } from "../../../server/src/opencode/session-pruning/navigation-contract"
import { serverApi } from "../lib/api-client"
import { tGlobal } from "../lib/i18n"
import { getOpenCodeInstanceGeneration, getOpenCodeMessageRevision, getOpenCodeMutationRevision } from "./opencode-data"
import { sessions } from "./session-state"
import { hasCompleteOutlineToolMetadata, normalizePersistedOutline, type PersistedOutline } from "./session-outline-persistence"

interface OutlineScan {
  entries: OutlineEntry[]
  cursor?: { after: number; through: number }
  complete: boolean
  total: number
  messageRevision: number
  checkpoints: OutlineCheckpoint[]
  sourceOffset: number
}
interface OutlineSnapshot { entries: OutlineEntry[]; checkpoints: OutlineCheckpoint[]; scan?: OutlineScan; persisted?: PersistedOutline }
// SessionView can be unmounted when changing sessions. Retain structural indexes
// metadata snapshots, fenced by instance generation/content revision/revert.
// No message payloads, network requests or hidden-view timers live in this cache.
const snapshots = new Map<string, OutlineSnapshot>()
const restored = new Map<string, { value: PersistedOutline; generation: number; revision: number }>()
const [outlineCacheRevision, setOutlineCacheRevision] = createSignal(0)
export { outlineCacheRevision }
export function seedSessionOutlineIndexes(instanceId: string, indexes: Record<string, PersistedOutline> = {}) {
  for (const [sessionID, value] of Object.entries(indexes)) {
    const key = JSON.stringify([instanceId, sessionID])
    if (!restored.has(key)) restored.set(key, { value, generation: getOpenCodeInstanceGeneration(instanceId),
      revision: getOpenCodeMutationRevision(instanceId, sessionID) })
  }
  let count = [...restored.values()].reduce((sum, seed) => sum + seed.value.entries.length, 0)
  for (const [key, seed] of restored) {
    if (restored.size <= 16 && count <= 200_000) break
    restored.delete(key); count -= seed.value.entries.length
  }
}
export function captureSessionOutlineIndexes(instanceId: string, excluded: ReadonlySet<string> = new Set()): Record<string, PersistedOutline> | undefined {
  const result: Record<string, PersistedOutline> = Object.create(null)
  for (const [key, seed] of restored) {
    const [owner, id] = JSON.parse(key)
    if (owner === instanceId && seed.generation === getOpenCodeInstanceGeneration(instanceId)
      && seed.revision === getOpenCodeMutationRevision(instanceId, id)) result[id] = seed.value
  }
  for (const [key, snapshot] of snapshots) {
    const [owner, id, generation, revision] = JSON.parse(key)
    if (owner !== instanceId) continue
    if (generation === getOpenCodeInstanceGeneration(instanceId) && revision === getOpenCodeMutationRevision(instanceId, id)
      && snapshot.persisted) result[id] = snapshot.persisted
  }
  for (const [id, value] of Object.entries(result)) {
    const session = sessions().get(instanceId)?.get(id)
    if (excluded.has(id) || (session && (session.location?.directory !== value.directory || session.projectID !== value.projectID
      || session.revert?.messageID !== value.revert))) delete result[id]
  }
  return Object.keys(result).length ? result : undefined
}
function trimSnapshots() {
  let entries = [...snapshots.values()].reduce((sum, value) => sum + value.entries.length + (value.scan?.complete ? 0 : value.scan?.entries.length ?? 0), 0)
  for (const [key, value] of snapshots) {
    if (snapshots.size <= 16 && entries <= 200_000) break
    if (snapshots.size === 1) break
    snapshots.delete(key)
    entries -= value.entries.length + (value.scan?.complete ? 0 : value.scan?.entries.length ?? 0)
  }
}

// Metadata has its own lifetime: changing the resident window never evicts it.
// Hiding pauses a scan at its last accepted cursor, rather than starting over.
export function createSessionOutline(props: { instanceId: Accessor<string>; sessionId: Accessor<string>; active: Accessor<boolean> }) {
  const [entries, setEntries] = createSignal<OutlineEntry[]>([])
  const [pending, setPending] = createSignal(false)
  const [error, setError] = createSignal("")
  const [retry, setRetry] = createSignal(0)
  const sessionState = createMemo(() => {
    const session = sessions().get(props.instanceId())?.get(props.sessionId())
    return JSON.stringify([session?.status, session?.revert?.messageID, session?.location?.directory, session?.projectID])
  })
  let identity = ""
  let lastRetry = 0
  let snapshot: OutlineSnapshot
  createEffect(() => {
    const instanceId = props.instanceId(), sessionID = props.sessionId()
    const generation = getOpenCodeInstanceGeneration(instanceId)
    const [, revert, directory, projectID] = JSON.parse(sessionState()) as [string, string | null, string | null, string | null]
    const revision = getOpenCodeMutationRevision(instanceId, sessionID)
    const key = JSON.stringify([instanceId, sessionID, generation, revision, revert, directory, projectID])
    const requested = retry()
    if (key !== identity) {
      identity = key
      const seedKey = JSON.stringify([instanceId, sessionID]), seed = restored.get(seedKey)
      const saved = seed?.generation === generation && seed.revision === revision && seed.value.directory === directory
        && seed.value.projectID === projectID && (seed.value.revert ?? null) === revert ? seed.value : undefined
      const completeToolMetadata = saved ? hasCompleteOutlineToolMetadata(saved) : false
      snapshot = snapshots.get(key) ?? { entries: saved?.entries ?? [], checkpoints: completeToolMetadata ? saved!.checkpoints : [],
        persisted: completeToolMetadata ? saved : undefined }
      if (directory && projectID) restored.delete(seedKey)
      snapshots.delete(key)
      snapshots.set(key, snapshot)
      trimSnapshots()
      setEntries(snapshot.entries); setError("")
    }
    // Status transitions may refresh a completed snapshot, but cannot starve an
    // initial multi-page scan. Its fixed sequence horizon survives those events.
    const messageRevision = getOpenCodeMessageRevision(instanceId, sessionID)
    if (requested !== lastRetry || (snapshot.scan?.complete && messageRevision !== snapshot.scan.messageRevision)) snapshot.scan = undefined
    lastRetry = requested
    if (!props.active()) { setPending(false); return }
    // Restored structure displays immediately. Native checkpoints revalidate all
    // ranges using row stamps/lengths, returning structure only for changed ranges.
    snapshot.scan ??= { entries: [], checkpoints: [], sourceOffset: 0, complete: false, total: 0, messageRevision }
    const work = snapshot.scan, owner = snapshot
    if (work.complete) { setPending(false); return }
    const controller = new AbortController()
    const current = () => !controller.signal.aborted && key === identity
      && generation === getOpenCodeInstanceGeneration(instanceId)
      && revision === getOpenCodeMutationRevision(instanceId, sessionID)
    setPending(true)
    setError("")
    const timer = setTimeout(() => {
      void (async () => {
        do {
          const cursor = work.cursor
          const page = await serverApi.fetchSessionOutline(instanceId, sessionID, cursor, controller.signal, -1,
            owner.checkpoints.length <= 512 ? owner.checkpoints : [])
          if (!current()) return
          if (page.status !== "outline") throw new Error(tGlobal(`session.pruning.${page.reason}`))
          if (cursor && page.cursor && page.cursor.after <= cursor.after) throw new Error(tGlobal("session.pruning.conflict"))
          let delta = 0
          for (const checkpoint of page.checkpoints) {
            if (!checkpoint.changed && !owner.checkpoints.some(value => value.after === checkpoint.after
              && value.through === checkpoint.through && value.digest === checkpoint.digest)) throw new Error(tGlobal("session.pruning.conflict"))
            while (work.sourceOffset < owner.entries.length && owner.entries[work.sourceOffset].seq <= checkpoint.through) {
              const entry = owner.entries[work.sourceOffset++]
              if (!checkpoint.changed && entry.seq > checkpoint.after) work.entries.push(entry)
            }
            while (delta < page.entries.length && page.entries[delta].seq <= checkpoint.through) {
              const entry = page.entries[delta++]
              if (checkpoint.changed && entry.seq > checkpoint.after) work.entries.push(entry)
            }
            const { changed: _, ...saved } = checkpoint
            work.checkpoints.push(saved)
          }
          work.cursor = page.cursor ?? undefined
          work.total = page.total
        } while (work.cursor)
        if (current()) {
          work.complete = true; owner.entries = work.entries; owner.checkpoints = work.checkpoints
          owner.persisted = normalizePersistedOutline({ format: 1, directory, projectID,
            ...(revert ? { revert } : {}), entries: work.entries, checkpoints: work.checkpoints })
          setEntries(work.entries); setError(""); trimSnapshots()
          setOutlineCacheRevision(value => value + 1)
          // Message revisions are not reactive. A terminal status can arrive
          // before this fixed-horizon scan finishes, so schedule one catch-up.
          if (getOpenCodeMessageRevision(instanceId, sessionID) !== work.messageRevision) setRetry(value => value + 1)
        }
      })().catch(failure => {
        if (current()) setError(failure instanceof Error ? failure.message : String(failure))
      }).finally(() => { if (current()) setPending(false) })
    }, 0)
    onCleanup(() => { clearTimeout(timer); controller.abort() })
  })
  return { entries, pending, error, refresh: () => setRetry(value => value + 1) }
}
