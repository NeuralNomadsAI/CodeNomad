import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js"

const pixels = (value: string) => Number.parseFloat(value) || 0

function textWidth(element: Element): number {
  const range = document.createRange()
  range.selectNodeContents(element)
  return range.getBoundingClientRect().width
}

function inlineChrome(element: Element): number {
  const style = getComputedStyle(element)
  return pixels(style.paddingLeft) + pixels(style.paddingRight) + pixels(style.borderLeftWidth) + pixels(style.borderRightWidth)
}

function flexWidth(element: Element, widths: number[]): number {
  return inlineChrome(element) + widths.reduce((sum, width) => sum + width, 0)
    + Math.max(0, widths.length - 1) * pixels(getComputedStyle(element).columnGap)
}

/** Measure the full row content, even while the inline actions are hidden.
 * Comparing against the same full-action budget in both modes avoids oscillation.
 */
export function useSessionRowOverflow(row: Accessor<HTMLElement | undefined>) {
  const [compact, setCompact] = createSignal(false)
  createEffect(() => {
    const element = row()
    if (!element) return
    let frame = 0
    const measure = () => {
      frame = 0
      const select = element.querySelector<HTMLElement>(".session-item-select")
      const inline = element.querySelector<HTMLElement>(".session-item-inline-actions")
      const actions = element.querySelector<HTMLElement>(".session-item-actions")
      if (!select || !inline || !actions || !element.getBoundingClientRect().width) return
      const title = select.querySelector(".session-item-title")!
      const icon = select.querySelector(".session-item-kind-icon")!
      const badges = select.querySelector(".session-item-badges")!
      const badgeWidths = [...badges.children].map((badge) => flexWidth(badge,
        [...badge.children].map((child) => child.matches(".session-item-status-label, .worktree-indicator-label")
          ? textWidth(child) : child.getBoundingClientRect().width),
      ))
      const widths = [icon.getBoundingClientRect().width, textWidth(title)]
      if (badgeWidths.length) widths.push(flexWidth(badges, badgeWidths))
      const required = flexWidth(select, widths) + inline.getBoundingClientRect().width
      const available = select.getBoundingClientRect().width + actions.getBoundingClientRect().width
      const next = required > available + 0.5
      if (next === compact()) return
      const hadActionFocus = actions.contains(document.activeElement)
      setCompact(next)
      if (hadActionFocus) queueMicrotask(() => {
        if (!element.isConnected) return
        const selector = next ? ".session-item-overflow-actions button" : ".session-item-inline-actions button:not(:disabled)"
        element.querySelector<HTMLElement>(selector)?.focus({ preventScroll: true })
      })
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure)
    }
    const resize = new ResizeObserver(schedule)
    resize.observe(element)
    for (const target of element.querySelectorAll(".session-item-select, .session-item-inline-actions")) resize.observe(target)
    const mutation = new MutationObserver(schedule)
    mutation.observe(element, { childList: true, characterData: true, subtree: true })
    document.fonts?.addEventListener("loadingdone", schedule)
    schedule()
    onCleanup(() => {
      cancelAnimationFrame(frame)
      resize.disconnect()
      mutation.disconnect()
      document.fonts?.removeEventListener("loadingdone", schedule)
    })
  })
  return compact
}
