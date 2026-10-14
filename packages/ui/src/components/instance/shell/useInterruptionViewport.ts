import { createEffect, createSignal, onCleanup, onMount, type Accessor, type JSX } from "solid-js"

// Android's keyboard may resize only visualViewport. Bound the request/composer
// stack to its bottom edge without changing the saved composer height or normal
// conversation layout. Measure the uncapped top, not the capped element's height,
// so keyboard panning and ResizeObserver cannot progressively shrink the pane.
export function useInterruptionViewport(container: Accessor<HTMLElement | undefined>, expanded: Accessor<boolean>) {
  const [bottomSpace, setBottomSpace] = createSignal<number>()
  let schedule = () => {}
  createEffect(() => { if (expanded()) schedule() })
  onMount(() => {
    const element = container()
    if (!element) return
    const viewport = window.visualViewport
    let frame = 0
    const measure = () => {
      if (!expanded()) return
      const bottom = (viewport?.offsetTop ?? 0) + (viewport?.height ?? window.innerHeight)
      setBottomSpace(Math.max(0, bottom - element.getBoundingClientRect().top))
    }
    schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure) }
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(schedule)
    observer?.observe(element)
    viewport?.addEventListener("resize", schedule)
    viewport?.addEventListener("scroll", schedule)
    window.addEventListener("resize", schedule)
    measure()
    onCleanup(() => {
      cancelAnimationFrame(frame)
      observer?.disconnect()
      viewport?.removeEventListener("resize", schedule)
      viewport?.removeEventListener("scroll", schedule)
      window.removeEventListener("resize", schedule)
    })
  })
  return (): JSX.CSSProperties | undefined => expanded() && bottomSpace() !== undefined
    ? { "max-height": `${bottomSpace()}px` } : undefined
}
