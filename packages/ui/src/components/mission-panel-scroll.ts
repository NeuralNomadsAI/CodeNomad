import { createSignal, onCleanup, onMount, type Accessor } from "solid-js"

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
 * the panel, the region and each sibling between them; no timer or polling. */
export function missionPanelScroll(element: () => HTMLElement | undefined): Accessor<boolean> {
  const [panelScrolls, setPanelScrolls] = createSignal(false)
  onMount(() => {
    const tree = element(), host = tree?.closest<HTMLElement>(".mission-control")
    if (!tree || !host) return
    const containers: HTMLElement[] = []
    for (let node = tree.parentElement; node; node = node.parentElement) { containers.push(node); if (node === host) break }
    let frame = 0
    const measure = () => {
      frame = 0
      if (!tree.isConnected) return
      const minimum = parseFloat(getComputedStyle(tree).minHeight) || 0
      const next = host.scrollHeight - tree.offsetHeight + minimum > host.clientHeight + 1
      if (next === panelScrolls()) return
      setPanelScrolls(next)
      // Switching moves content between scrollers; keep keyboard focus in view.
      const focused = document.activeElement
      if (focused instanceof HTMLElement && host.contains(focused)) focused.scrollIntoView({ block: "nearest" })
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure) }
    const resize = new ResizeObserver(schedule)
    const observe = () => {
      resize.disconnect()
      resize.observe(host)
      for (const container of containers) for (const child of container.children) resize.observe(child)
      schedule()
    }
    const mutation = new MutationObserver(observe)
    for (const container of containers) mutation.observe(container, { childList: true })
    observe()
    onCleanup(() => { cancelAnimationFrame(frame); resize.disconnect(); mutation.disconnect() })
  })
  return panelScrolls
}
