import { createSignal, onCleanup, onMount, type Accessor } from "solid-js"

/** Whether this document is visible and focused, tracked while the caller is mounted. */
export function createDocumentAttention(): Accessor<boolean> {
  const [attention, setAttention] = createSignal(false)
  onMount(() => {
    const update = () => setAttention(canMarkSessionIdleSeen({
      active: true, visibilityState: document.visibilityState, focused: document.hasFocus(),
    }))
    update()
    window.addEventListener("focus", update)
    window.addEventListener("blur", update)
    document.addEventListener("visibilitychange", update)
    onCleanup(() => {
      window.removeEventListener("focus", update)
      window.removeEventListener("blur", update)
      document.removeEventListener("visibilitychange", update)
    })
  })
  return attention
}

export function canMarkSessionIdleSeen(input: {
  active: boolean
  visibilityState: DocumentVisibilityState
  focused: boolean
}): boolean {
  return input.active && input.visibilityState === "visible" && input.focused
}
