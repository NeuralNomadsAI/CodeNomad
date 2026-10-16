import { onCleanup } from "solid-js"
import { contentWidth } from "./measured-action-overflow"

/** A tool header gives up room in order: its actions fold into the overflow
 * menu (observeActionOverflow), then the status word goes, leaving the icon and
 * duration, and only then does the title truncate. The decision always measures
 * the full content, word included (kept measurable while hidden), so it never
 * oscillates. */
export function observeToolStatusCompaction(summary: HTMLElement) {
  let frame = 0
  let disposed = false
  const measure = () => {
    frame = 0
    if (disposed || !summary.isConnected || !summary.clientWidth) return
    const next = String(contentWidth(summary) > summary.getBoundingClientRect().width + 0.5)
    if (summary.dataset.statusCompact !== next) summary.dataset.statusCompact = next
  }
  const schedule = () => { if (!frame && !disposed) frame = requestAnimationFrame(measure) }
  const resize = new ResizeObserver(schedule)
  resize.observe(summary)
  const mutation = new MutationObserver(schedule)
  mutation.observe(summary, { subtree: true, childList: true, characterData: true })
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
