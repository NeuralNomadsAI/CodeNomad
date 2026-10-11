import { onCleanup } from "solid-js"

export const LONG_PRESS_MS = 450

/**
 * Handlers for a button whose click keeps its primary action while a long
 * press (mouse or touch), right-click, Alt+ArrowDown, Shift+F10 or the Menu
 * key opens a secondary popup anchored to the button.
 */
export function createLongPressHandlers(options: { onClick: () => void; onLongPress: (target: HTMLElement) => void }) {
  let timer: ReturnType<typeof setTimeout> | undefined
  // A completed long press must not also trigger the click that ends it.
  let swallowClick = false
  const cancel = () => {
    if (timer === undefined) return
    clearTimeout(timer)
    timer = undefined
  }
  onCleanup(cancel)

  return {
    onPointerDown(event: PointerEvent) {
      cancel()
      swallowClick = false
      if (event.button !== 0) return
      const target = event.currentTarget as HTMLElement
      timer = setTimeout(() => {
        timer = undefined
        swallowClick = true
        options.onLongPress(target)
      }, LONG_PRESS_MS)
    },
    onPointerUp: cancel,
    onPointerLeave: cancel,
    onPointerCancel: cancel,
    onContextMenu(event: MouseEvent) {
      event.preventDefault()
      cancel()
      options.onLongPress(event.currentTarget as HTMLElement)
    },
    onKeyDown(event: KeyboardEvent) {
      const opens = (event.altKey && event.key === "ArrowDown") || (event.shiftKey && event.key === "F10") || event.key === "ContextMenu"
      if (!opens) return
      event.preventDefault()
      options.onLongPress(event.currentTarget as HTMLElement)
    },
    onClick(event: MouseEvent) {
      if (swallowClick) {
        swallowClick = false
        event.preventDefault()
        return
      }
      options.onClick()
    },
  }
}
