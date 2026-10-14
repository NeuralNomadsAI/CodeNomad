import { createEffect } from "solid-js"
import { keyboardRegistry } from "../keyboard-registry"
import { isHotkeyRecording } from "../hotkeys"

type EscapeKeyState = "idle" | "firstPress"

const ESCAPE_DEBOUNCE_TIMEOUT = 1000

let escapeKeyState: EscapeKeyState = "idle"
let escapeTimeoutId: number | null = null
let onEscapeStateChange: ((inDebounce: boolean) => void) | null = null

export function setEscapeStateChangeHandler(handler: (inDebounce: boolean) => void) {
  onEscapeStateChange = handler
}

function resetEscapeState() {
  escapeKeyState = "idle"
  if (escapeTimeoutId !== null) {
    clearTimeout(escapeTimeoutId)
    escapeTimeoutId = null
  }
  if (onEscapeStateChange) {
    onEscapeStateChange(false)
  }
}

export function registerEscapeShortcut(
  isSessionBusy: () => boolean,
  abortSession: () => Promise<void>,
  blurInput: () => void,
  closeModal: () => void,
  hasActiveSession: () => boolean = () => true,
  homeOverlay?: { isOpen: () => boolean; close: () => void },
) {
  // A confirmation belongs to its surface, never to the session behind home.
  createEffect(() => { homeOverlay?.isOpen(); resetEscapeState() })
  const confirmDoublePress = (action: () => void) => {
    if (escapeKeyState === "idle") {
      escapeKeyState = "firstPress"
      onEscapeStateChange?.(true)
      escapeTimeoutId = window.setTimeout(resetEscapeState, ESCAPE_DEBOUNCE_TIMEOUT)
    } else {
      resetEscapeState()
      action()
    }
  }
  // Closing transient layers remains conventional Escape, independent of the
  // rebindable double-press session action.
  const closeLayer = (event: KeyboardEvent) => {
    if (event.isComposing || event.keyCode === 229 || isHotkeyRecording()
      || event.key !== "Escape" || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return
    if (event.defaultPrevented) {
      if (homeOverlay?.isOpen()) resetEscapeState()
      return
    }
    if (document.querySelector('[role="dialog"]')) {
      event.preventDefault()
      closeModal()
      resetEscapeState()
    } else if (homeOverlay?.isOpen()) {
      event.preventDefault()
      if (!event.repeat) confirmDoublePress(homeOverlay.close)
    }
  }
  window.addEventListener("keydown", closeLayer)
  keyboardRegistry.register({
    id: "session-abort",
    condition: () => hasActiveSession() && isSessionBusy(),
    handler: () => confirmDoublePress(() => { void abortSession() }),
    description: "abort session",
    context: "global",
  })
  keyboardRegistry.register({
    id: "prompt-blur",
    condition: () => hasActiveSession() && !isSessionBusy()
      && Boolean(document.activeElement?.matches(".prompt-input")),
    handler: () => { resetEscapeState(); blurInput() },
    description: "blur input",
    context: "input",
  })
  return () => {
    window.removeEventListener("keydown", closeLayer)
    keyboardRegistry.unregister("session-abort")
    keyboardRegistry.unregister("prompt-blur")
    resetEscapeState()
    onEscapeStateChange = null
  }
}
