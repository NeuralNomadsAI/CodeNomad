import { createSignal, onCleanup, onMount } from "solid-js"

// The keyboard can shrink only visualViewport, leaving the layout viewport
// and conversation container unchanged. Keep their visible intersection.
export function usePromptViewport(wrapper: () => HTMLElement | undefined) {
  const [size, setSize] = createSignal({ width: 0, height: 0 }, {
    equals: (a, b) => a.width === b.width && a.height === b.height,
  })
  onMount(() => {
    const container = wrapper()?.closest("[data-session-center-width]") ?? wrapper()?.closest(".session-view")
    if (!container) return
    const viewport = window.visualViewport
    let frame = 0
    const update = () => {
      const rect = container.getBoundingClientRect()
      if (!rect.width || !rect.height) return
      const top = viewport?.offsetTop ?? 0
      const bottom = top + (viewport?.height ?? window.innerHeight)
      const height = Math.max(0, Math.min(rect.bottom, bottom) - Math.max(rect.top, top))
      if (height > 0) setSize({ width: rect.width, height })
    }
    const schedule = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(update)
    }
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(schedule)
    observer?.observe(container)
    window.addEventListener("resize", schedule)
    viewport?.addEventListener("resize", schedule)
    viewport?.addEventListener("scroll", schedule)
    update()
    onCleanup(() => {
      cancelAnimationFrame(frame)
      observer?.disconnect()
      window.removeEventListener("resize", schedule)
      viewport?.removeEventListener("resize", schedule)
      viewport?.removeEventListener("scroll", schedule)
    })
  })
  return size
}
