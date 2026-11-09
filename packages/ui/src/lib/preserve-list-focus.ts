import { createEffect, on, onCleanup } from "solid-js"

/** Keyed DOM moves can blur a still-mounted control. Preserve that native focus,
 * without scrolling it back into view or overriding a later user focus choice. */
export function preserveListFocus(element: () => HTMLElement | undefined) {
  createEffect(on(element, root => {
    if (!root) return
    let focused: HTMLElement | undefined
    const remember = (event: FocusEvent) => {
      focused = event.target instanceof HTMLElement && root.contains(event.target) ? event.target : undefined
    }
    const pointer = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || !focused?.contains(event.target)) focused = undefined
    }
    const keyboard = (event: KeyboardEvent) => { if (event.key === "Tab") focused = undefined }
    const observer = new MutationObserver(records => {
      const control = focused
      if (!control?.isConnected) { focused = undefined; return }
      if (document.activeElement !== document.body || !document.hasFocus() || document.visibilityState !== "visible"
        || !root.contains(control) || root.closest('[inert], [aria-hidden="true"]')
        || !root.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return
      if (records.some(record => [...record.removedNodes].some(node => node.contains(control)))) control.focus({ preventScroll: true })
    })
    observer.observe(root, { childList: true, subtree: true })
    document.addEventListener("focusin", remember)
    document.addEventListener("pointerdown", pointer, true)
    document.addEventListener("keydown", keyboard, true)
    onCleanup(() => {
      observer.disconnect()
      document.removeEventListener("focusin", remember)
      document.removeEventListener("pointerdown", pointer, true)
      document.removeEventListener("keydown", keyboard, true)
    })
  }))
}
