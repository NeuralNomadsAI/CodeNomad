import { Dialog } from "@kobalte/core/dialog"
import { Component, Show, createEffect, createSignal } from "solid-js"
import { alertDialogState, dismissAlertDialog } from "../stores/alerts"
import type { AlertVariant, AlertDialogState } from "../stores/alerts"

const variantAccent: Record<AlertVariant, { badgeBg: string; badgeBorder: string; badgeText: string; symbol: string; fallbackTitle: string }> = {
  info: {
    badgeBg: "var(--badge-neutral-bg)",
    badgeBorder: "var(--border-base)",
    badgeText: "var(--accent-primary)",
    symbol: "i",
    fallbackTitle: "Heads up",
  },
  warning: {
    badgeBg: "rgba(255, 152, 0, 0.14)",
    badgeBorder: "var(--status-warning)",
    badgeText: "var(--status-warning)",
    symbol: "!",
    fallbackTitle: "Please review",
  },
  error: {
    badgeBg: "var(--danger-soft-bg)",
    badgeBorder: "var(--status-error)",
    badgeText: "var(--status-error)",
    symbol: "!",
    fallbackTitle: "Something went wrong",
  },
}

function dismiss(confirmed: boolean, payload?: AlertDialogState | null, promptValue?: string) {
  const current = payload ?? alertDialogState()

  if (current?.type === "confirm") {
    if (confirmed) {
      current.onConfirm?.()
    } else {
      current.onCancel?.()
    }
    current.resolve?.(confirmed)
    dismissAlertDialog()
    return
  }

  if (current?.type === "prompt") {
    if (confirmed) {
      current.onConfirm?.()
      current.resolvePrompt?.(promptValue ?? "")
    } else {
      current.onCancel?.()
      current.resolvePrompt?.(null)
    }
    dismissAlertDialog()
    return
  }

  if (confirmed) {
    current?.onConfirm?.()
  }
  dismissAlertDialog()
}

const AlertDialog: Component = () => {
  let primaryButtonRef: HTMLButtonElement | undefined
  let promptInputRef: HTMLInputElement | undefined

  createEffect(() => {
    const state = alertDialogState()
    if (!state) return

    queueMicrotask(() => {
      if (state.type === "prompt") {
        promptInputRef?.focus()
        promptInputRef?.select()
        return
      }
      primaryButtonRef?.focus()
    })
  })

  return (
    <Show when={alertDialogState()} keyed>
      {(payload) => {
        const variant = payload.variant ?? "info"
        const accent = variantAccent[variant]
        const title = payload.title || accent.fallbackTitle
        const isConfirm = payload.type === "confirm"
        const isPrompt = payload.type === "prompt"
        const confirmLabel = payload.confirmLabel || (isConfirm ? "Confirm" : isPrompt ? "Run" : "OK")
        const cancelLabel = payload.cancelLabel || "Cancel"

        const [inputValue, setInputValue] = createSignal(payload.inputDefaultValue ?? "")

        return (
          <Dialog
            open
            modal
            onOpenChange={(open) => {
              if (!open) {
                dismiss(false, payload)
              }
            }}
          >
            <Dialog.Portal>
              <Dialog.Overlay class="modal-overlay" />
              <div class="fixed inset-0 z-50 flex items-center justify-center p-4">
                <Dialog.Content class="modal-surface w-full max-w-sm p-6 border border-base shadow-2xl" tabIndex={-1}>
                  <div class="flex items-start gap-3">
                    <div
                      class="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border text-base font-semibold"
                      style={{
                        "background-color": accent.badgeBg,
                        "border-color": accent.badgeBorder,
                        color: accent.badgeText,
                      }}
                      aria-hidden
                    >
                      {accent.symbol}
                    </div>
                    <div class="flex-1 min-w-0">
                      <Dialog.Title class="text-lg font-semibold text-primary">{title}</Dialog.Title>
                      <Dialog.Description class="text-sm text-secondary mt-1 whitespace-pre-line break-words">
                        {payload.message}
                        {payload.detail && <p class="mt-2 text-secondary">{payload.detail}</p>}
                      </Dialog.Description>
                    </div>
                  </div>

                    <Show when={isPrompt}>
                      <div class="mt-4">
                        <label class="text-sm font-medium text-secondary">{payload.inputLabel || "Input"}</label>
                        <input
                          ref={(el) => {
                            promptInputRef = el
                          }}
                          class="form-input mt-2"
                          value={inputValue()}
                          placeholder={payload.inputPlaceholder || ""}
                          autocapitalize="off"
                          autocorrect="off"
                          spellcheck={false}
                          onInput={(e) => setInputValue(e.currentTarget.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault()
                              dismiss(true, payload, inputValue())
                            }
                          }}
                        />
                      </div>
                    </Show>

                   <div class="mt-6 flex justify-end gap-3">
                     {(isConfirm || isPrompt) && (
                       <button
                         type="button"
                         class="button-secondary"
                         onClick={() => dismiss(false, payload)}
                       >
                         {cancelLabel}
                       </button>
                     )}
                     <button
                       type="button"
                       class="button-primary"
                       ref={(el) => {
                         primaryButtonRef = el
                       }}
                       onClick={() => dismiss(true, payload, inputValue())}
                     >
                       {confirmLabel}
                     </button>
                   </div>
                </Dialog.Content>
              </div>
            </Dialog.Portal>
          </Dialog>
        )
      }}
    </Show>
  )
}

export default AlertDialog
