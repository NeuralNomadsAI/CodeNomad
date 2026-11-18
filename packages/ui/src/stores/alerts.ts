import { createSignal } from "solid-js"

export type AlertVariant = "info" | "warning" | "error"

export type AlertDialogChoice = { value: string; label: string; tone?: "primary" | "danger" }

export type AlertDialogState = {
  type?: "alert" | "confirm" | "prompt" | "choice"
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
  /** Opt-in guarded confirmations; timers belong to this exact dialog. */
  confirmDelayMs?: number
  expiresAfterMs?: number
  returnFocus?: () => void

  // prompt-only
  inputLabel?: string
  inputPlaceholder?: string
  inputDefaultValue?: string

  // confirm-only
  resolve?: (value: boolean) => void

  // prompt-only
  resolvePrompt?: (value: string | null) => void

  // choice-only: buttons after Cancel; the last one receives initial focus.
  choices?: AlertDialogChoice[]
  resolveChoice?: (value: string | null) => void
}

const [alertDialogState, setAlertDialogState] = createSignal<AlertDialogState | null>(null)

function replaceAlertDialog(next: AlertDialogState) {
  const previous = alertDialogState()
  setAlertDialogState(next)
  // Replacing the singleton is not consent. Release pending callers without
  // invoking action callbacks or leaving their local controls locked forever.
  if (previous?.type === "confirm") previous.resolve?.(false)
  if (previous?.type === "prompt") previous.resolvePrompt?.(null)
  if (previous?.type === "choice") previous.resolveChoice?.(null)
}

export function showAlertDialog(message: string, options?: Omit<AlertDialogState, "message">) {
  replaceAlertDialog({
    type: "alert",
    message,
    ...options,
  })
}

export function showConfirmDialog(message: string, options?: Omit<AlertDialogState, "message">, signal?: AbortSignal): Promise<boolean> {
  const activeElement = typeof document !== "undefined" ? (document.activeElement as HTMLElement | null) : null
  activeElement?.blur()

  return new Promise<boolean>((resolve) => {
    let expiry: ReturnType<typeof setTimeout> | undefined
    if (signal?.aborted) { resolve(false); return }
    const cancel = () => {
      if (alertDialogState() === owned) dismissAlertDialog()
      owned.resolve?.(false)
    }
    const owned: AlertDialogState = {
      type: "confirm",
      message,
      ...options,
      resolve: value => { clearTimeout(expiry); signal?.removeEventListener("abort", cancel); resolve(value) },
    }
    signal?.addEventListener("abort", cancel, { once: true })
    replaceAlertDialog(owned)
    if (options?.expiresAfterMs) expiry = setTimeout(cancel, options.expiresAfterMs)
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

/** Resolves the chosen value, or null when cancelled or dismissed. */
export function showChoiceDialog(
  message: string,
  choices: AlertDialogChoice[],
  options?: Omit<AlertDialogState, "message" | "type" | "choices" | "resolve" | "resolvePrompt" | "resolveChoice">,
): Promise<string | null> {
  const activeElement = typeof document !== "undefined" ? (document.activeElement as HTMLElement | null) : null
  activeElement?.blur()

  return new Promise<string | null>((resolveChoice) => {
    replaceAlertDialog({
      type: "choice",
      message,
      ...options,
      choices,
      resolveChoice,
    })
  })
}

export function dismissAlertDialog() {
  setAlertDialogState(null)
}

export { alertDialogState }
