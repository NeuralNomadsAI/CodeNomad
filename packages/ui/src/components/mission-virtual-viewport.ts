import { createEffect, createSignal, on, onCleanup } from "solid-js"

/** Virtua lists share the panel's existing scroll owner. Their start offset includes
 * the sticky header and any preceding branches, in unscaled scroll coordinates. */
export function missionVirtualViewport(element: () => HTMLElement | undefined, active: () => boolean = () => true) {
  const [scrollRef, setScrollRef] = createSignal<HTMLElement>()
  const [startMargin, setStartMargin] = createSignal(0)
  createEffect(on(element, list => {
    const host = list?.closest<HTMLElement>(".mission-control")
    if (!list || !host) return
    let frame = 0, focusFrame = 0
    let focused: HTMLElement | undefined, wasVisible = false
    const visibleBounds = () => {
      const bounds = host.getBoundingClientRect(), scale = bounds.height / host.offsetHeight || 1
      const margin = focused ? (parseFloat(getComputedStyle(focused).scrollMarginTop) || 0) * scale : 0
      return { top: bounds.top + margin, bottom: Math.min(innerHeight, bounds.bottom), scale }
    }
    const rememberFocus = () => {
      const target = document.activeElement
      if (target === focused && (focusFrame || host.clientWidth !== portWidth || host.clientHeight !== portHeight)) {
        repairResize()
        return
      }
      focused = target instanceof HTMLElement && list.contains(target) ? target : undefined
      const box = focused?.getBoundingClientRect(), bounds = visibleBounds()
      wasVisible = Boolean(box && box.top >= bounds.top - 1 && box.bottom <= bounds.bottom + 1)
    }
    const repairResize = () => {
      if (!wasVisible || focusFrame) return
      focusFrame = requestAnimationFrame(() => {
        focusFrame = 0
        if (!active() || !document.hasFocus() || document.visibilityState !== "visible" || !list.checkVisibility()
          || !focused?.isConnected || document.activeElement !== focused) return
        const box = focused.getBoundingClientRect(), bounds = visibleBounds()
        const delta = box.top < bounds.top ? box.top - bounds.top : box.bottom > bounds.bottom ? box.bottom - bounds.bottom : 0
        if (delta) host.scrollTop += delta / bounds.scale
        rememberFocus()
      })
    }
    let portWidth = host.clientWidth, portHeight = host.clientHeight
    const scroll = () => {
      // A viewport resize may itself emit scroll before ResizeObserver runs. Keep
      // the previous visibility until its one repair, rather than treating it as a wheel gesture.
      if (focusFrame) return
      if (host.clientWidth !== portWidth || host.clientHeight !== portHeight) repairResize()
      else rememberFocus()
    }
    const measure = () => {
      frame = 0
      if (!list.checkVisibility() || !host.offsetHeight) return
      const bounds = host.getBoundingClientRect(), scale = bounds.height / host.offsetHeight || 1
      setStartMargin((list.getBoundingClientRect().top - bounds.top) / scale - host.clientTop + host.scrollTop)
    }
    const observer = new ResizeObserver(() => {
      if (host.clientWidth !== portWidth || host.clientHeight !== portHeight) {
        portWidth = host.clientWidth; portHeight = host.clientHeight
        repairResize()
      }
      if (!frame) frame = requestAnimationFrame(measure)
    })
    for (let node: HTMLElement | null = list; node; node = node.parentElement) {
      observer.observe(node)
      if (node === host) break
    }
    measure()
    setScrollRef(host)
    host.addEventListener("focusin", rememberFocus)
    host.addEventListener("scroll", scroll, { passive: true })
    const wheel = () => { cancelAnimationFrame(focusFrame); focusFrame = 0; wasVisible = false }
    host.addEventListener("wheel", wheel, { passive: true })
    onCleanup(() => {
      observer.disconnect(); cancelAnimationFrame(frame); cancelAnimationFrame(focusFrame)
      host.removeEventListener("focusin", rememberFocus); host.removeEventListener("scroll", scroll)
      host.removeEventListener("wheel", wheel)
      setScrollRef(undefined)
    })
  }))
  return { scrollRef, startMargin }
}
