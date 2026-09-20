import { createEffect, createMemo, createSignal, onCleanup, type Accessor } from "solid-js"
import type { OutlineEntry } from "../../../server/src/opencode/session-pruning/navigation-contract"
import { serverApi } from "../lib/api-client"
import { tGlobal } from "../lib/i18n"
import { getOpenCodeInstanceGeneration, getOpenCodeMessageRevision, getOpenCodeMutationRevision } from "./opencode-data"
import { sessions } from "./session-state"

interface OutlineScan {
  entries: OutlineEntry[]
  cursor?: { after: number; through: number }
  complete: boolean
  total: number
  messageRevision: number
  after: number
}
interface OutlineSnapshot { entries: OutlineEntry[]; scan?: OutlineScan; status: string }
// SessionView can be unmounted when changing sessions. Retain structural indexes
// metadata snapshots, fenced by instance generation/content revision/revert.
// No message payloads, network requests or hidden-view timers live in this cache.
const snapshots = new Map<string, OutlineSnapshot>()
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
    return `${session?.status}\0${session?.revert?.messageID}`
  })
  let identity = ""
  let lastRetry = 0
  let snapshot: OutlineSnapshot
  createEffect(() => {
    const instanceId = props.instanceId(), sessionID = props.sessionId()
    const generation = getOpenCodeInstanceGeneration(instanceId)
    const status = sessionState()
    const revision = getOpenCodeMutationRevision(instanceId, sessionID)
    const key = JSON.stringify([instanceId, sessionID, generation, revision, status.split("\0")[1]])
    const requested = retry()
    if (key !== identity) {
      identity = key
      snapshot = snapshots.get(key) ?? { entries: [], status }
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
    snapshot.status = status
    if (!props.active()) { setPending(false); return }
    // Completed native messages are immutable except fenced destructive edits.
    // Re-read a small tail to include the in-flight message, then append new IDs.
    // A return with no native message events makes no request at all.
    const after = snapshot.entries.at(-33)?.seq ?? -1
    snapshot.scan ??= { entries: snapshot.entries.filter(entry => entry.seq <= after), after,
      complete: false, total: 0, messageRevision }
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
          const page = await serverApi.fetchSessionOutline(instanceId, sessionID, cursor, controller.signal, work.after)
          if (!current()) return
          if (page.status !== "outline") throw new Error(tGlobal(`session.pruning.${page.reason}`))
          if (cursor && page.cursor && page.cursor.after <= cursor.after) throw new Error(tGlobal("session.pruning.conflict"))
          work.entries.push(...page.entries)
          work.cursor = page.cursor ?? undefined
          work.total = page.total
        } while (work.cursor)
        if (current()) { work.complete = true; owner.entries = work.entries; setEntries(work.entries); setError(""); trimSnapshots() }
      })().catch(failure => {
        if (current()) setError(failure instanceof Error ? failure.message : String(failure))
      }).finally(() => { if (current()) setPending(false) })
    }, 0)
    onCleanup(() => { clearTimeout(timer); controller.abort() })
  })
  return { entries, pending, error, refresh: () => setRetry(value => value + 1) }
}
