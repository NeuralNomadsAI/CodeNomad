import { createEffect, createMemo, createSignal, onCleanup, type Accessor } from "solid-js"
import type { OutlineEntry } from "../../../server/src/opencode/session-pruning/navigation-contract"
import { serverApi } from "../lib/api-client"
import { tGlobal } from "../lib/i18n"
import { getOpenCodeInstanceGeneration, getOpenCodeMutationRevision } from "./opencode-data"
import { sessions } from "./session-state"

// Metadata has its own lifetime: changing the resident 200-message window never
// evicts the outline. Hidden views cancel work; refresh retains the last snapshot.
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
  createEffect(() => {
    const instanceId = props.instanceId(), sessionID = props.sessionId()
    const generation = getOpenCodeInstanceGeneration(instanceId)
    const key = JSON.stringify([instanceId, sessionID, generation])
    // Refresh on terminal state/undo/explicit content changes, not every token.
    sessionState()
    const revision = getOpenCodeMutationRevision(instanceId, sessionID)
    retry()
    if (key !== identity) { identity = key; setEntries([]); setError("") }
    if (!props.active()) { setPending(false); return }
    const controller = new AbortController()
    const current = () => !controller.signal.aborted && key === identity
      && generation === getOpenCodeInstanceGeneration(instanceId)
      && revision === getOpenCodeMutationRevision(instanceId, sessionID)
    setPending(true)
    const timer = setTimeout(() => {
      void (async () => {
        const next: OutlineEntry[] = []
        let cursor: { after: number; through: number } | undefined
        do {
          const page = await serverApi.fetchSessionOutline(instanceId, sessionID, cursor, controller.signal)
          if (!current()) return
          if (page.status !== "outline") throw new Error(tGlobal(`session.pruning.${page.reason}`))
          if (cursor && page.cursor && page.cursor.after <= cursor.after) throw new Error(tGlobal("session.pruning.conflict"))
          next.push(...page.entries)
          cursor = page.cursor ?? undefined
        } while (cursor)
        if (current()) { setEntries(next); setError("") }
      })().catch(failure => {
        if (current()) setError(failure instanceof Error ? failure.message : String(failure))
      }).finally(() => { if (current()) setPending(false) })
    }, 150)
    onCleanup(() => { clearTimeout(timer); controller.abort() })
  })
  return { entries, pending, error, refresh: () => setRetry(value => value + 1) }
}
