import { createEffect, createSignal, onCleanup, onMount } from "solid-js"
import { hasKeyboardOcclusion, layoutKeyboardInset } from "../../lib/keyboard-offset"

const TRANSCRIPT_RESERVE = 64

function visibleHeight(rect: DOMRect, top: number, bottom: number) {
  return Math.max(0, Math.min(rect.bottom, bottom) - Math.max(rect.top, top))
}

export function usePromptViewport(wrapper: () => HTMLElement | undefined, interruptionExpanded: () => boolean) {
  const [size, setSize] = createSignal({ referenceHeight: 0, visibleHeight: 0, fieldSpace: undefined as number | undefined }, {
    equals: (a, b) => a.referenceHeight === b.referenceHeight && a.visibleHeight === b.visibleHeight && a.fieldSpace === b.fieldSpace,
  })
  onMount(() => {
    const composer = wrapper()?.parentElement
    const session = composer?.closest<HTMLElement>(".session-view")
    if (!composer || !session) return
    const container = session.closest("[data-session-center-width]") ?? session
    const host = session.closest("[data-keyboard-viewport]")
    const footer = composer.querySelector(".prompt-input-footer")
    const field = composer.querySelector(".prompt-input-field-container")
    const viewport = window.visualViewport
    let frame = 0
    let transcriptInset = 0
    const update = () => {
      const rect = container.getBoundingClientRect()
      if (!rect.width || !rect.height) return
      const top = viewport?.offsetTop ?? 0
      const bottom = top + (viewport?.height ?? window.innerHeight)
      const visible = visibleHeight(rect, top, bottom)
      const layoutInset = layoutKeyboardInset(window)
      const occluded = layoutInset > 0 || hasKeyboardOcclusion(window)
      const sessionRect = session.getBoundingClientRect()
      // The host or the browser (layoutInset) has already shortened the layout.
      // Add that space back only to the reference, without treating a visual
      // viewport pan as a resize.
      const inset = (host ? parseFloat(getComputedStyle(host).paddingBottom) : 0) + layoutInset
      const reference = occluded
        ? Math.max(0, Math.min(rect.bottom + inset, window.innerHeight + layoutInset) - Math.max(rect.top, 0))
        : visible
      let fieldSpace: number | undefined
      if (occluded) {
        // Use the actual visible session (below header chrome) and subtract
        // the footer, composer chrome and in-flow rows, never the transcript.
        const chrome = composer.getBoundingClientRect().height - (field?.getBoundingClientRect().height ?? 0)
        const rows = Array.from(session.children).filter(row => row !== composer
          && !row.classList.contains("mission-transcript-surface") && row.getClientRects().length > 0
          && !["absolute", "fixed"].includes(getComputedStyle(row).position))
        const rowsHeight = rows.reduce((height, row) => height + row.getBoundingClientRect().height, 0)
        fieldSpace = Math.floor(visibleHeight(sessionRect, top, bottom) - chrome - rowsHeight)
      }
      // Move the transcript's layout edge out of the occluded top strip.
      // Leave scrolling to the transcript's existing resize/anchor handling.
      const nextInset = occluded && !interruptionExpanded() ? Math.max(0, top - sessionRect.top) : 0
      if (nextInset !== transcriptInset) {
        transcriptInset = nextInset
        if (transcriptInset > 0) session.style.setProperty("--keyboard-transcript-inset", `${transcriptInset}px`)
        else session.style.removeProperty("--keyboard-transcript-inset")
      }
      if (reference > 0) setSize({ referenceHeight: reference, visibleHeight: visible, fieldSpace })
    }
    const schedule = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(update)
    }
    createEffect(() => {
      interruptionExpanded()
      schedule()
    })
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(schedule)
    const observe = () => {
      observer?.disconnect()
      observer?.observe(container)
      observer?.observe(session)
      if (footer) observer?.observe(footer)
      for (const row of session.children) {
        if (row !== composer && !row.classList.contains("mission-transcript-surface")) observer?.observe(row)
      }
      schedule()
    }
    const rowsObserver = new MutationObserver(observe)
    rowsObserver.observe(session, { childList: true })
    observe()
    window.addEventListener("resize", schedule)
    window.addEventListener("orientationchange", schedule)
    document.addEventListener("focusin", schedule)
    document.addEventListener("focusout", schedule)
    viewport?.addEventListener("resize", schedule)
    viewport?.addEventListener("scroll", schedule)
    update()
    onCleanup(() => {
      cancelAnimationFrame(frame)
      observer?.disconnect()
      rowsObserver.disconnect()
      if (transcriptInset > 0) session.style.removeProperty("--keyboard-transcript-inset")
      window.removeEventListener("resize", schedule)
      window.removeEventListener("orientationchange", schedule)
      document.removeEventListener("focusin", schedule)
      document.removeEventListener("focusout", schedule)
      viewport?.removeEventListener("resize", schedule)
      viewport?.removeEventListener("scroll", schedule)
    })
  })
  return size
}

export function capPromptHeight(desired: number, fieldSpace: number | undefined, minimum: number): number {
  return fieldSpace === undefined ? desired : Math.min(desired, Math.max(minimum, fieldSpace - TRANSCRIPT_RESERVE))
}
