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
}
interface OutlineSnapshot { entries: OutlineEntry[]; scan?: OutlineScan; status: string }
// SessionView can be unmounted when changing sessions. Keep only four recent
// metadata snapshots, fenced by instance generation/content revision/revert.
// No message payloads, network requests or hidden-view timers live in this cache.
const snapshots = new Map<string, OutlineSnapshot>()

// Metadata has its own lifetime: changing the resident window never evicts it.
// Hiding pauses a scan at its last accepted cursor, rather than starting over.
export function createSessionOutline(props: { instanceId: Accessor<string>; sessionId: Accessor<string>; active: Accessor<boolean> }) {
  const [entries, setEntries] = createSignal<OutlineEntry[]>([])
  const [pending, setPending] = createSignal(false)
  const [error, setError] = createSignal("")
  const [retry, setRetry] = createSignal(0)
  const [progress, setProgress] = createSignal({ loaded: 0, total: 0 })
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
      while (snapshots.size > 4) snapshots.delete(snapshots.keys().next().value!)
      setEntries(snapshot.entries); setError("")
    }
    // Status transitions may refresh a completed snapshot, but cannot starve an
    // initial multi-page scan. Its fixed sequence horizon survives those events.
    const messageRevision = getOpenCodeMessageRevision(instanceId, sessionID)
    if (requested !== lastRetry || (snapshot.scan?.complete &&
      (status !== snapshot.status || messageRevision !== snapshot.scan.messageRevision))) snapshot.scan = undefined
    lastRetry = requested
    snapshot.status = status
    if (!props.active()) { setPending(false); return }
    snapshot.scan ??= { entries: [], complete: false, total: 0, messageRevision }
    const work = snapshot.scan, owner = snapshot
    setProgress({ loaded: work.entries.length, total: work.total })
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
          const page = await serverApi.fetchSessionOutline(instanceId, sessionID, cursor, controller.signal)
          if (!current()) return
          if (page.status !== "outline") throw new Error(tGlobal(`session.pruning.${page.reason}`))
          if (cursor && page.cursor && page.cursor.after <= cursor.after) throw new Error(tGlobal("session.pruning.conflict"))
          work.entries.push(...page.entries)
          work.cursor = page.cursor ?? undefined
          work.total = page.total
          setProgress({ loaded: work.entries.length, total: page.total })
        } while (work.cursor)
        if (current()) { work.complete = true; owner.entries = work.entries; setEntries(work.entries); setError("") }
      })().catch(failure => {
        if (current()) setError(failure instanceof Error ? failure.message : String(failure))
      }).finally(() => { if (current()) setPending(false) })
    }, 150)
    onCleanup(() => { clearTimeout(timer); controller.abort() })
  })
  return { entries, pending, error, progress, refresh: () => setRetry(value => value + 1) }
}
