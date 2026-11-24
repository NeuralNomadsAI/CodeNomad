import { createEffect, onCleanup } from "solid-js"

// Sections can grow after their asynchronous settings have loaded. Keep the
// requested offset until it is reachable, or until the user takes over.
export function createSettingsScrollRestoration(
  element: () => HTMLElement | undefined,
  position: () => { scrollTop?: number } | undefined,
  changed: (top: number) => void,
) {
  createEffect(() => {
    const request = position()
    const viewport = element()
    if (!request || !viewport) return
    let restoring = true
    let frame = 0
    const top = request.scrollTop ?? 0
    const restore = () => {
      if (!restoring) return
      viewport.scrollTop = top
      if (viewport.scrollHeight - viewport.clientHeight >= top) {
        cancelAnimationFrame(frame)
        frame = requestAnimationFrame(() => { restoring = false })
      }
    }
    const takeOver = () => {
      restoring = false
      cancelAnimationFrame(frame)
    }
    const keyDown = (event: KeyboardEvent) => {
      if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) takeOver()
    }
    const scroll = () => { if (!restoring) changed(Math.round(viewport.scrollTop)) }
    const observer = new ResizeObserver(restore)
    observer.observe(viewport)
    for (const child of viewport.children) observer.observe(child)
    viewport.addEventListener("scroll", scroll)
    viewport.addEventListener("wheel", takeOver, { passive: true })
    viewport.addEventListener("pointerdown", takeOver)
    viewport.addEventListener("keydown", keyDown)
    restore()
    onCleanup(() => {
      observer.disconnect()
      cancelAnimationFrame(frame)
      viewport.removeEventListener("scroll", scroll)
      viewport.removeEventListener("wheel", takeOver)
      viewport.removeEventListener("pointerdown", takeOver)
      viewport.removeEventListener("keydown", keyDown)
    })
  })
}
