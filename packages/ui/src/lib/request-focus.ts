/** A disabled submitting control can lose focus to body; another control owns its own focus. */
export function captureRequestFocus(acceptsFocus?: (target: EventTarget | null) => boolean) {
  let moved = false
  const changed = (event: FocusEvent) => { if (event.target !== document.body && !acceptsFocus?.(event.target)) moved = true }
  document.addEventListener("focusin", changed)
  return {
    retained: () => !moved,
    dispose: () => document.removeEventListener("focusin", changed),
  }
}
