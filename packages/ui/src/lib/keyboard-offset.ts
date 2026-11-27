const NON_TEXT_INPUTS = new Set(["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"])

/** True for a focused field that can raise an on-screen keyboard. */
export function isTextEntry(element: { tagName?: string; type?: string; isContentEditable?: boolean } | null | undefined): boolean {
  if (!element) return false
  if (element.isContentEditable) return true
  const tag = element.tagName?.toLowerCase()
  if (tag === "textarea") return true
  return tag === "input" && !NON_TEXT_INPUTS.has((element.type ?? "text").toLowerCase())
}

/** Bottom inset reserved for an on-screen keyboard. Only touch devices editing
 * text get one: desktop hosts can report a stale visualViewport (Windows), which
 * must never shrink the layout. */
export function keyboardInset(input: { innerHeight: number; viewportHeight: number; viewportOffsetTop: number; coarsePointer: boolean; editing: boolean }): number {
  if (!input.coarsePointer || !input.editing) return 0
  return Math.max(0, Math.floor(input.innerHeight - input.viewportHeight - input.viewportOffsetTop))
}

export function hasKeyboardOcclusion(win: Window): boolean {
  const viewport = win.visualViewport
  // There is no keyboard event on Safari or Chrome's default viewport mode.
  // Treat only a substantial, unzoomed height loss while editing as occlusion:
  // a pan changes the offset, and browser chrome only costs a small height.
  return Boolean(viewport && viewport.scale === 1 && win.innerHeight - viewport.height >= 100
    && win.matchMedia?.("(pointer: coarse)").matches
    && isTextEntry(win.document.activeElement as HTMLInputElement | null))
}

/** Height a keyboard removed from the layout itself. Firefox installed web apps
 * shrink the whole window (visualViewport included) instead of overlaying it,
 * so remember the tallest height seen at the current width and treat a
 * substantial loss while editing on touch as the keyboard. A width change
 * (rotation, split window) starts over from the new geometry. */
export function createLayoutKeyboardTracker() {
  let width = 0
  let fullHeight = 0
  return (win: Window): number => {
    if (win.innerWidth !== width || win.innerHeight > fullHeight) {
      width = win.innerWidth
      fullHeight = win.innerHeight
    }
    const lost = fullHeight - win.innerHeight
    return lost >= 100 && (win.visualViewport?.scale ?? 1) === 1
      && win.matchMedia?.("(pointer: coarse)").matches
      && isTextEntry(win.document.activeElement as HTMLInputElement | null) ? lost : 0
  }
}

export const layoutKeyboardInset = createLayoutKeyboardTracker()

/** Keeps `--keyboard-offset` current; returns the cleanup. */
export function installKeyboardOffset(win: Window): () => void {
  const vv = win.visualViewport
  const root = win.document.documentElement
  if (!vv) return () => {}
  const coarse = win.matchMedia?.("(pointer: coarse)")
  let frame = 0
  const update = () => {
    frame = 0
    const inset = hasKeyboardOcclusion(win)
      ? keyboardInset({ innerHeight: win.innerHeight, viewportHeight: vv.height, viewportOffsetTop: vv.offsetTop,
        coarsePointer: true, editing: true })
      : 0
    root.style.setProperty("--keyboard-offset", `${inset}px`)
  }
  const schedule = () => { if (!frame) frame = win.requestAnimationFrame(update) }
  const targets: Array<[EventTarget, string]> = [[vv, "resize"], [vv, "scroll"], [win, "resize"], [win, "orientationchange"],
    [win.document, "focusin"], [win.document, "focusout"], ...(coarse ? [[coarse, "change"] as [EventTarget, string]] : [])]
  for (const [target, type] of targets) target.addEventListener(type, schedule)
  schedule()
  return () => {
    for (const [target, type] of targets) target.removeEventListener(type, schedule)
    if (frame) win.cancelAnimationFrame(frame)
    root.style.removeProperty("--keyboard-offset")
  }
}
