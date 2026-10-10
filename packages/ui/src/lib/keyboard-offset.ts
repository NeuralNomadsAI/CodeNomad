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

/** Keeps `--keyboard-offset` current; returns the cleanup. */
export function installKeyboardOffset(win: Window): () => void {
  const vv = win.visualViewport
  const root = win.document.documentElement
  if (!vv) return () => {}
  const coarse = win.matchMedia?.("(pointer: coarse)")
  let frame = 0
  const update = () => {
    frame = 0
    const inset = keyboardInset({ innerHeight: win.innerHeight, viewportHeight: vv.height, viewportOffsetTop: vv.offsetTop,
      coarsePointer: Boolean(coarse?.matches), editing: isTextEntry(win.document.activeElement as HTMLInputElement | null) })
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
