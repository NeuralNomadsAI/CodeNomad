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

export function showAlertDialog(message: string, options?: Omit<AlertDialogState, "message">) {
  setAlertDialogState({
    type: "alert",
    message,
    ...options,
  })
}

export function showConfirmDialog(message: string, options?: Omit<AlertDialogState, "message">): Promise<boolean> {
  const activeElement = typeof document !== "undefined" ? (document.activeElement as HTMLElement | null) : null
  activeElement?.blur()

  return new Promise<boolean>((resolve) => {
    setAlertDialogState({
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
    setAlertDialogState({
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
