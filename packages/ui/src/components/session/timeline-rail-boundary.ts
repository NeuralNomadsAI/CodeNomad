/** Follow the real composer footer boundary, including wrapped/touch controls. */
export function observeTimelineRailBoundary(rail: HTMLElement): () => void {
  const view = rail.parentElement
  if (!view) return () => {}
  const footer = view.querySelector<HTMLElement>(".prompt-input-footer")
  if (!footer) return () => {}
  const update = () => {
    const bottom = view.getBoundingClientRect().bottom - footer.getBoundingClientRect().top
    rail.style.insetBlockEnd = `${Math.max(0, bottom)}px`
  }
  const observer = new ResizeObserver(update)
  observer.observe(view)
  observer.observe(footer)
  update()
  return () => observer.disconnect()
}
