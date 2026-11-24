/**
 * Moves keyboard focus to content revealed in place, without scrolling. A
 * non-focusable target gets a temporary programmatic tab stop, released when
 * focus leaves it.
 */
export function focusRevealedElement(target: HTMLElement) {
  if (!target.hasAttribute("tabindex")) {
    target.setAttribute("tabindex", "-1")
    const release = () => {
      // Switching windows also blurs; keep the target so focus can return to it.
      if (!document.hasFocus()) return
      target.removeAttribute("tabindex")
      target.removeEventListener("blur", release)
    }
    target.addEventListener("blur", release)
  }
  target.focus({ preventScroll: true })
}
