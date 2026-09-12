import { onCleanup } from "solid-js"

const px = (value: string) => Number.parseFloat(value) || 0

/** Intrinsic width of the single-line header, ignoring its overflow trigger. */
function contentWidth(element: Element): number {
  if (element.matches(".action-overflow-trigger, .message-agent-meta-inline--measure")) return 0
  const style = getComputedStyle(element)
  if (style.display === "none") return 0
  if (element instanceof SVGElement || element.matches(".message-action-button, .tool-call-header-copy")) {
    return element.getBoundingClientRect().width
  }
  const widths: number[] = []
  for (const child of element.childNodes) {
    if (child instanceof Element) widths.push(contentWidth(child))
    else if (child.nodeType === Node.TEXT_NODE && child.textContent?.trim()) {
      const range = document.createRange()
      range.selectNode(child)
      widths.push(range.getBoundingClientRect().width)
    }
  }
  const visible = widths.filter((width) => width > 0)
  const stacked = style.flexDirection === "column"
  const content = stacked ? Math.max(0, ...visible) : visible.reduce((a, b) => a + b, 0)
  return content + (stacked ? 0 : Math.max(0, visible.length - 1) * px(style.columnGap))
    + px(style.paddingLeft) + px(style.paddingRight) + px(style.borderLeftWidth) + px(style.borderRightWidth)
}

export function observeActionOverflow(element: HTMLElement) {
  let frame = 0
  let disposed = false
  const measure = () => {
    frame = 0
    if (disposed || !element.isConnected || !element.clientWidth) return
    const menu = element.querySelector<HTMLButtonElement>(".action-overflow-narrow")
    if (!menu) return
    // Preserve an open menu during a resize; re-evaluate when it closes.
    const next = menu.hasAttribute("data-expanded") || contentWidth(element) > element.getBoundingClientRect().width + 0.5
    if (element.dataset.contentOverflow === String(next)) return
    const active = document.activeElement
    const hadActionFocus = active instanceof Element && active.matches(".message-action-button, .tool-call-header-copy") && element.contains(active)
    element.dataset.contentOverflow = String(next)
    for (const control of element.querySelectorAll<HTMLElement>(".message-action-group, .tool-call-header-copy:not(.action-overflow-trigger)")) control.inert = next
    if (hadActionFocus) queueMicrotask(() => {
      if (disposed) return
      const target = next ? menu : element.querySelector<HTMLButtonElement>(".message-action-group button:not(:disabled), .tool-call-header-copy:not(.action-overflow-trigger):not(:disabled)")
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
