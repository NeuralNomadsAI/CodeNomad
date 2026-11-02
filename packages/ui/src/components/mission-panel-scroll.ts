import { createEffect, createSignal, onCleanup, onMount, type Accessor } from "solid-js"

/** Single-scroller policy for a region of `.mission-control` that fills the remaining
 * height: the task group (mission-task-tree.css) and the creation form's body
 * (mission-create.css). While the rest of the panel plus the region's minimum height
 * fits, the panel is fixed and the region alone scrolls, filling the remaining
 * height. Otherwise (short viewport, expanded picker, requests, a wrapped footer) the
 * panel becomes the only scroller and the region takes its natural height, so no
 * control above or below it is clipped and gestures never nest.
 *
 * The required height is the same sum in both modes (everything else in the panel
 * plus the region's minimum), so switching never oscillates. Size observers cover
 * the panel, the region, each sibling between them and the current focus's layout
 * branches, keeping that focus visible through nested growth without polling. */
export function missionPanelScroll(element: () => HTMLElement | undefined, active: Accessor<boolean> = () => true): Accessor<boolean> {
  const [panelScrolls, setPanelScrolls] = createSignal(false)
  onMount(() => {
    const tree = element(), host = tree?.closest<HTMLElement>(".mission-control")
    if (!tree || !host) return
    const containers: HTMLElement[] = []
    for (let node = tree.parentElement; node; node = node.parentElement) { containers.push(node); if (node === host) break }
    let frame = 0, disposed = false
    const rendered = (node: HTMLElement) => node.isConnected && node.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true })
      && !node.closest('[inert], [aria-hidden="true"]')
    const keepFocusVisible = () => {
      const focused = document.activeElement
      if (!active() || !document.hasFocus() || document.visibilityState !== "visible" || element() !== tree
        || !rendered(tree) || !(focused instanceof HTMLElement) || !host.contains(focused) || !rendered(focused)) return
      // Only the existing vertical owner moves; scrollIntoView also moves outer/horizontal scrollers.
      for (let node = focused.parentElement; node && host.contains(node); node = node.parentElement) {
        if (/^(auto|scroll)$/.test(getComputedStyle(node).overflowY) && node.scrollHeight > node.clientHeight + 1) {
          const box = focused.getBoundingClientRect(), port = node.getBoundingClientRect(), scale = port.height / node.offsetHeight
          const contentTop = port.top + node.clientTop * scale
          const top = Math.max(0, contentTop), bottom = Math.min(window.innerHeight, contentTop + node.clientHeight * scale)
          const above = box.top - top, below = box.bottom - bottom
          // Nearest edge also handles controls taller than the available viewport.
          const delta = above < 0 && below < 0 ? Math.max(above, below) : above > 0 && below > 0 ? Math.min(above, below) : 0
          if (delta) node.scrollTop += delta / scale
          break
        }
        if (node === host) break
      }
    }
    const measure = () => {
      frame = 0
      if (disposed || !active() || element() !== tree || !rendered(tree)) return
      const minimum = parseFloat(getComputedStyle(tree).minHeight) || 0
      const next = host.scrollHeight - tree.offsetHeight + minimum > host.clientHeight + 1
      if (next !== panelScrolls()) setPanelScrolls(next)
      keepFocusVisible()
    }
    const schedule = () => { if (!disposed && !frame) frame = requestAnimationFrame(measure) }
    const resize = new ResizeObserver(schedule)
    const observe = () => {
      resize.disconnect()
      resize.observe(host)
      for (const container of containers) for (const child of container.children) resize.observe(child)
      // A nested sibling can grow while the scrollport's own dimensions stay fixed.
      // Observe focus-path siblings rather than the panel's entire descendant tree.
      const focused = document.activeElement
      if (focused instanceof HTMLElement && host.contains(focused)) {
        for (let node = focused.parentElement; node && node !== host && host.contains(node); node = node.parentElement) {
          for (const child of node.children) resize.observe(child)
        }
      }
      schedule()
    }
    const mutation = new MutationObserver(observe)
    mutation.observe(host, { childList: true, subtree: true })
    document.addEventListener("focusin", observe)
    createEffect(() => { active(); schedule() })
    observe()
    onCleanup(() => { disposed = true; cancelAnimationFrame(frame); resize.disconnect(); mutation.disconnect(); document.removeEventListener("focusin", observe) })
  })
  return panelScrolls
}
