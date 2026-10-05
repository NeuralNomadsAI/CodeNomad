import { createEffect, createMemo, createSignal, on } from "solid-js"
import { sessions } from "../stores/sessions"
import { getInterruptionQueue, getInterruptionScope } from "../stores/interruption-scope"

export function useInterruptionDockState(props: { instanceId: string; sessionId?: string | null }) {
  type Selection = { key: string; expanded: boolean }
  const [selections, setSelections] = createSignal(new Map<string | null | undefined, Selection>())
  const pending = createMemo(() => getInterruptionQueue(props.instanceId))
  const scope = createMemo(() => getInterruptionScope(sessions().get(props.instanceId), props.sessionId))
  const external = (item: ReturnType<typeof pending>[number]) => item.payload.sessionID === "global" || !scope().has(item.payload.sessionID)
  const selection = () => selections().get(props.sessionId)
  const current = createMemo(() => pending().find(item => item.key === selection()?.key)
    ?? pending().find(item => item.payload.sessionID === props.sessionId)
    ?? pending().find(item => !external(item)) ?? pending()[0])
  const expanded = createMemo(() => {
    const item = current()
    return Boolean(item && (selection()?.key === item.key ? selection()!.expanded : !external(item)))
  })
  const select = (key: string, open: boolean) => setSelections(previous => new Map(previous).set(props.sessionId, { key, expanded: open }))
  // Pin even an automatic selection. Queue reordering/arrivals must not replace
  // the editor; each automatic foreign fallback starts closed, even if an older
  // request from that conversation was deliberately opened.
  createEffect(on([() => props.sessionId, () => current()?.key], () => {
    const item = current()
    if (item && selection()?.key !== item.key) select(item.key, !external(item))
  }))
  const index = () => pending().findIndex(item => item.key === current()?.key)
  const move = (delta: number) => {
    const next = pending()[index() + delta]
    if (next) select(next.key, !external(next))
  }
  const previews = createMemo(() => current() && !external(current()!) ? pending().filter(external) : [])
  return { pending, current, expanded, select, index, move, previews, scope }
}
