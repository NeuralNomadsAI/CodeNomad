import { createSignal } from "solid-js"

export type AlertVariant = "info" | "warning" | "error"

export type AlertDialogState = {
  type?: "alert" | "confirm" | "prompt"
  title?: string
  message: string
  detail?: string
  variant?: AlertVariant
  confirmLabel?: string
  cancelLabel?: string
  /** When false, prevents dismissal via Escape key or backdrop click. Default: true */
  dismissible?: boolean
  onConfirm?: () => void
  onCancel?: () => void

  // prompt-only
  inputLabel?: string
  inputPlaceholder?: string
  inputDefaultValue?: string

  // confirm-only
  resolve?: (value: boolean) => void

  // prompt-only
  resolvePrompt?: (value: string | null) => void
}

const [alertDialogState, setAlertDialogState] = createSignal<AlertDialogState | null>(null)

function replaceAlertDialog(next: AlertDialogState) {
  const previous = alertDialogState()
  setAlertDialogState(next)
  // Replacing the singleton is not consent. Release pending callers without
  // invoking action callbacks or leaving their local controls locked forever.
  if (previous?.type === "confirm") previous.resolve?.(false)
  if (previous?.type === "prompt") previous.resolvePrompt?.(null)
}

export function showAlertDialog(message: string, options?: Omit<AlertDialogState, "message">) {
  replaceAlertDialog({
    type: "alert",
    message,
    ...options,
  })
}

export function showConfirmDialog(message: string, options?: Omit<AlertDialogState, "message">): Promise<boolean> {
  const activeElement = typeof document !== "undefined" ? (document.activeElement as HTMLElement | null) : null
  activeElement?.blur()

  return new Promise<boolean>((resolve) => {
    replaceAlertDialog({
      type: "confirm",
      message,
      ...options,
      resolve,
    })
  })
}

export function showPromptDialog(
  message: string,
  options?: Omit<AlertDialogState, "message" | "type" | "resolve" | "resolvePrompt">,
): Promise<string | null> {
  const activeElement = typeof document !== "undefined" ? (document.activeElement as HTMLElement | null) : null
  activeElement?.blur()

  return new Promise<string | null>((resolvePrompt) => {
    replaceAlertDialog({
      type: "prompt",
      message,
      ...options,
      resolvePrompt,
    })
  })
}

export function dismissAlertDialog() {
  setAlertDialogState(null)
}

export { alertDialogState }
