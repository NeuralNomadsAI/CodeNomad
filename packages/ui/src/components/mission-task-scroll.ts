import { createSignal, onCleanup, onMount, type Accessor } from "solid-js"

/** Single-scroller policy for the task group of `.mission-control`
 * (mission-task-tree.css). While the rest of the panel plus the task group's
 * minimum height fits, the panel is fixed and the task flow alone scrolls, filling
 * the remaining height. Otherwise (short viewport, expanded picker, requests) the
 * panel becomes the only scroller and the flow takes its natural height, so no
 * control above or below the tasks is clipped and gestures never nest.
 *
 * The required height is the same sum in both modes (everything else in the panel
 * plus the group's minimum), so switching never oscillates. Size observers cover
 * the panel, the group and each sibling between them; no timer or polling. */
export function missionTaskPanelScroll(element: () => HTMLElement | undefined): Accessor<boolean> {
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
      setPanelScrolls(host.scrollHeight - tree.offsetHeight + minimum > host.clientHeight + 1)
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
