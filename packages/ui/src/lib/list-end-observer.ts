/** Shared session/Mission infinite-list trigger. Callers retain their own demand,
 * loading and failure guards; keyboard focus on a fallback never advances a list. */
export function observeListEnd(element: HTMLElement, root: HTMLElement | null, onReach: () => void, margin: number) {
  const observer = new IntersectionObserver(entries => {
    if (entries.some(entry => entry.isIntersecting) && !element.contains(document.activeElement)) onReach()
  }, { root, rootMargin: `0px 0px ${margin}px 0px` })
  observer.observe(element)
  return () => observer.disconnect()
}
