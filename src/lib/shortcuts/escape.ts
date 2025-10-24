import { keyboardRegistry } from "../keyboard-registry"

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
) {
  keyboardRegistry.register({
    id: "escape",
    key: "Escape",
    modifiers: {},
    handler: () => {
      const hasOpenModal = document.querySelector('[role="dialog"]') !== null

      if (hasOpenModal) {
        closeModal()
        resetEscapeState()
        return
      }

      if (isSessionBusy()) {
        if (escapeKeyState === "idle") {
          escapeKeyState = "firstPress"
          if (onEscapeStateChange) {
            onEscapeStateChange(true)
          }
          escapeTimeoutId = window.setTimeout(() => {
            resetEscapeState()
          }, ESCAPE_DEBOUNCE_TIMEOUT)
        } else if (escapeKeyState === "firstPress") {
          resetEscapeState()
          abortSession()
        }
        return
      }

      resetEscapeState()
      blurInput()
    },
    description: "cancel/close",
    context: "global",
  })
}
