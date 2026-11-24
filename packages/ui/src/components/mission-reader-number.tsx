import { createEffect, createSignal } from "solid-js"

/** A native number draft is not a read request. Commit only on Enter/blur and
 * never replace an edited draft when a delayed page becomes authoritative. */
export function MissionReaderNumber(props: { value: number; max: number; identity: string; label: string;
  class?: string; onCommit: (value: number) => void }) {
  const [draft, setDraft] = createSignal(String(props.value))
  let dirty = false, previousIdentity = ""
  createEffect(() => {
    const identity = props.identity, value = props.value
    if (identity !== previousIdentity) { previousIdentity = identity; dirty = false }
    if (!dirty) setDraft(String(value))
  })
  const commit = (input: HTMLInputElement, report: boolean) => {
    if (!dirty || !input.isConnected) return
    const value = input.valueAsNumber
    if (!Number.isInteger(value) || value < 1 || value > props.max) {
      if (report) input.reportValidity()
      return
    }
    dirty = false
    props.onCommit(value)
  }
  return <input type="number" min="1" max={props.max} step="1" class={props.class} value={draft()}
    aria-label={props.label} onInput={event => { dirty = true; setDraft(event.currentTarget.value) }}
    onBlur={event => commit(event.currentTarget, false)} onKeyDown={event => {
      if (event.key === "Enter" && !event.isComposing) {
        event.preventDefault(); event.stopPropagation(); commit(event.currentTarget, true)
      }
    }} />
}
