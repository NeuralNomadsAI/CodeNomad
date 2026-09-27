import { onCleanup } from "solid-js"

const px = (value: string) => Number.parseFloat(value) || 0

// Width of the row content ignoring the overflow trigger, so hidden inline
// actions stay measurable. Text nodes are measured with a Range because the
// label truncates with ellipsis.
function rowContentWidth(element: Element): number {
  if (element.matches(".action-overflow-trigger")) return 0
  const style = getComputedStyle(element)
  if (style.display === "none") return 0
  if (element instanceof SVGElement || element.matches("button")) {
    return element.getBoundingClientRect().width
  }
  const widths: number[] = []
  for (const child of element.childNodes) {
    if (child instanceof Element) widths.push(rowContentWidth(child))
    else if (child.nodeType === Node.TEXT_NODE && child.textContent?.trim()) {
      const range = document.createRange()
      range.selectNode(child)
      widths.push(range.getBoundingClientRect().width)
    }
  }
  const visible = widths.filter((width) => width > 0)
  const stacked = style.flexDirection === "column"
  return (stacked ? Math.max(0, ...visible) : visible.reduce((a, b) => a + b, 0))
    + (stacked ? 0 : Math.max(0, visible.length - 1) * px(style.columnGap))
    + px(style.paddingLeft) + px(style.paddingRight) + px(style.borderLeftWidth) + px(style.borderRightWidth)
}

// Toggle data-compact on a file row: inline icon buttons while they fit, the
// shared overflow menu only when they don't. An open menu stays mounted
// across resizes; hidden actions stay measurable but inert.
export function observeRowOverflow(element: HTMLElement) {
  let frame = 0
  let disposed = false
  const measure = () => {
    frame = 0
    if (disposed || !element.isConnected || !element.clientWidth) return
    const menu = element.querySelector<HTMLButtonElement>(".action-overflow-trigger")
    const inline = element.querySelector<HTMLElement>(".file-row-inline-actions")
    if (!menu || !inline) return
    const menuWidth = menu.getBoundingClientRect().width || 24
    const required = rowContentWidth(element) + menuWidth
    const available = element.getBoundingClientRect().width
    const next = menu.hasAttribute("data-expanded") || required > available + 0.5
    if (element.dataset.compact === String(next)) return
    const active = document.activeElement
    const hadActionFocus = active instanceof Element && element.contains(active)
      && active.matches(".file-row-inline-actions button, .action-overflow-trigger")
    element.dataset.compact = String(next)
    inline.inert = next
    if (hadActionFocus) queueMicrotask(() => {
      if (disposed || !element.isConnected) return
      const target = next ? menu : element.querySelector<HTMLButtonElement>(".file-row-inline-actions button:not(:disabled)")
      target?.focus({ preventScroll: true })
    })
  }
  const schedule = () => { if (!frame && !disposed) frame = requestAnimationFrame(measure) }
  const resize = new ResizeObserver(schedule)
  resize.observe(element)
  const mutation = new MutationObserver(schedule)
  mutation.observe(element, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["data-expanded"] })
  document.fonts?.addEventListener("loadingdone", schedule)
  schedule()
  onCleanup(() => {
    disposed = true
    cancelAnimationFrame(frame)
    resize.disconnect()
    mutation.disconnect()
    document.fonts?.removeEventListener("loadingdone", schedule)
  })
}
