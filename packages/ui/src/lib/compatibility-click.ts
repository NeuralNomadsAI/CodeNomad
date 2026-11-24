/** Touch menus select on pointerup and unmount at once, so the browser's
 * follow-up compatibility click lands on whatever lay beneath the menu (a row,
 * a reader toggle or the drawer backdrop) and supersedes the chosen action.
 * Swallow exactly that one click, bounded in time. */
export function suppressCompatibilityClick(target: Pick<EventTarget, "addEventListener" | "removeEventListener"> = document, timeoutMs = 700): () => void {
  const swallow = (event: Event) => { event.preventDefault(); event.stopImmediatePropagation(); stop() }
  const timer = setTimeout(stop, timeoutMs)
  function stop() { clearTimeout(timer); target.removeEventListener("click", swallow, { capture: true }) }
  target.addEventListener("click", swallow, { capture: true })
  return stop
}
