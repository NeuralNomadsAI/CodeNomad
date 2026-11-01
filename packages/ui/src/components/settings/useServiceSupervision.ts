import { createEffect, createSignal, on, onCleanup, untrack } from "solid-js"
import type { SupervisionSettingsControl, SupervisionSettingsResponse } from "../../../../server/src/api-types"
import { serverApi } from "../../lib/api-client"
import { serverEvents } from "../../lib/server-events"
import { HttpResponseError } from "../../lib/retryable-file-search"

type Operation = { input: SupervisionSettingsControl; state: "pending" | "uncertain" }
const checkedStatus = (value: SupervisionSettingsResponse) => {
  if (!value || !/^[a-f0-9]{64}$/.test(value.serviceKey) || !Number.isSafeInteger(value.revision) || value.revision < 0
    || !["unset", "on", "off"].includes(value.desired) || !["off", "pending", "installed", "running", "failing"].includes(value.state)
    || typeof value.serviceResponding !== "boolean" || value.cause !== null && typeof value.cause !== "string")
    throw new Error("Invalid service supervision observation")
  return value
}
const receiptMatches = (value: SupervisionSettingsResponse, input: SupervisionSettingsControl) =>
  value.serviceKey === input.serviceKey && value.request?.state === "recorded" && value.request.requestID === input.requestID
  && value.request.action === input.action && value.request.appliedRevision === input.expectedRevision + (input.action === "retry" ? 0 : 1)
// Unacknowledged controls survive Settings navigation, pinned to their service and
// original request. Reopening the card only observes; an explicit click retries.
const [operations, setOperations] = createSignal<Record<string, Operation>>({})
const forget = (input: SupervisionSettingsControl) => setOperations(current => {
  if (current[input.serviceKey]?.input.requestID !== input.requestID) return current
  const next = { ...current }; delete next[input.serviceKey]; return next
})

/** The displayed service key/revision fences writes. Demand, visibility and
 * reconnect refresh observations, with one read lane and one coalesced follow-up. */
export function useServiceSupervision(props: { active: () => boolean; selection: () => string }) {
  const [snapshot, setSnapshot] = createSignal<SupervisionSettingsResponse>()
  const [busy, setBusy] = createSignal(false), [error, setError] = createSignal(false)
  const [conflict, setConflict] = createSignal(false)
  let refresh = async () => {}, save = async (_action: SupervisionSettingsControl["action"], _original = false) => {}
  createEffect(() => {
    props.selection()
    const active = props.active()
    let disposed = false, reading = false, writing = false, trailing = false
    setSnapshot(undefined); setError(false); setBusy(false); setConflict(false)
    refresh = async () => {}; save = async () => {}
    if (!active) return
    const current = () => !disposed && props.active() && document.visibilityState === "visible"
    const load = async () => {
      if (!current()) return
      if (reading || writing) { trailing = true; return }
      reading = true; setBusy(true)
      do {
        trailing = false
        try {
          // Read the selected host first. Never send an old service key as a
          // substitute for discovering the current Settings execution host.
          let next = checkedStatus(await serverApi.getServiceSupervision())
          const operation = untrack(operations)[next.serviceKey]
          if (operation) {
            next = checkedStatus(await serverApi.getServiceSupervision({ serviceKey: next.serviceKey, requestID: operation.input.requestID }))
            if (next.serviceKey !== operation.input.serviceKey) throw new Error("Service supervision identity changed")
            if (operation.state === "uncertain" && receiptMatches(next, operation.input)) forget(operation.input)
          }
          if (current() && !trailing) { setSnapshot(next); setError(false) }
        } catch { if (current() && !trailing) setError(true) }
      } while (current() && trailing)
      reading = false
      if (!disposed) setBusy(false)
    }
    refresh = load
    save = async (action, original = false) => {
      const data = untrack(snapshot)
      if (!current() || reading || writing || !data || untrack(error)) return
      const held = untrack(operations)[data.serviceKey]
      if (held?.state === "pending" || held && !original) return
      const input = original && held ? held.input : { serviceKey: data.serviceKey, expectedRevision: data.revision,
        requestID: crypto.randomUUID(), action }
      writing = true; setBusy(true); setConflict(false)
      setOperations(value => ({ ...value, [input.serviceKey]: { input, state: "pending" } }))
      try {
        const next = checkedStatus(await serverApi.controlServiceSupervision(input))
        if (next.serviceKey !== input.serviceKey || next.revision < input.expectedRevision
          || input.action !== "retry" && !receiptMatches(next, input)) throw new Error("Service supervision acknowledgement differs")
        forget(input)
        if (current()) setSnapshot(next)
      } catch (error) {
        if (error instanceof HttpResponseError && error.status === 409 && error.message === "supervision-conflict") {
          // A stale revision cannot overwrite another profile's later choice.
          // Re-read only; the human decides again from the current observation.
          forget(input)
          if (current()) setConflict(true)
        } else setOperations(value => value[input.serviceKey]?.input.requestID !== input.requestID ? value
          : { ...value, [input.serviceKey]: { input, state: "uncertain" } })
      } finally {
        writing = false
        if (!disposed) { setBusy(false); await load() }
      }
    }
    const reconnect = serverEvents.onOpen(() => void load())
    // A prior mount may still own the HTTP control. Its settlement invalidates
    // this mount's display without granting permission to resend the action.
    createEffect(on(() => { const key = snapshot()?.serviceKey; return key ? operations()[key] : undefined }, (next, previous) => {
      if (previous?.state === "pending" && next?.state !== "pending" && !writing) void load()
    }))
    const visible = () => { if (document.visibilityState === "visible") void load() }
    document.addEventListener("visibilitychange", visible)
    onCleanup(() => { disposed = true; reconnect(); document.removeEventListener("visibilitychange", visible) })
    void load()
  })
  const operation = () => { const key = snapshot()?.serviceKey; return key ? operations()[key] : undefined }
  return { snapshot, busy: () => busy() || operation()?.state === "pending", error, conflict, operation,
    refresh: () => refresh(), save: (action: SupervisionSettingsControl["action"]) => save(action),
    retryOriginal: () => { const held = operation(); return held ? save(held.input.action, true) : Promise.resolve() } }
}
