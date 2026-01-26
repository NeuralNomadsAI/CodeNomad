import { Dialog } from "@kobalte/core/dialog"
import { Component, Show, createEffect, createSignal } from "solid-js"
import { alertDialogState, dismissAlertDialog } from "../stores/alerts"
import type { AlertVariant, AlertDialogState } from "../stores/alerts"
import { useI18n } from "../lib/i18n"

const variantAccent: Record<AlertVariant, { badgeBg: string; badgeBorder: string; badgeText: string; symbol: string }> = {
  info: {
    badgeBg: "var(--badge-neutral-bg)",
    badgeBorder: "var(--border-base)",
    badgeText: "var(--accent-primary)",
    symbol: "i",
  },
  warning: {
    badgeBg: "rgba(255, 152, 0, 0.14)",
    badgeBorder: "var(--status-warning)",
    badgeText: "var(--status-warning)",
    symbol: "!",
  },
  error: {
    badgeBg: "var(--danger-soft-bg)",
    badgeBorder: "var(--status-error)",
    badgeText: "var(--status-error)",
    symbol: "!",
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
  const { t } = useI18n()
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

        const fallbackTitle =
          variant === "warning"
            ? t("alertDialog.fallbackTitle.warning")
            : variant === "error"
              ? t("alertDialog.fallbackTitle.error")
              : t("alertDialog.fallbackTitle.info")

        const title = payload.title || fallbackTitle
        const isConfirm = payload.type === "confirm"
        const isPrompt = payload.type === "prompt"
        const confirmLabel =
          payload.confirmLabel ||
          (isConfirm
            ? t("alertDialog.actions.confirm")
            : isPrompt
              ? t("alertDialog.actions.run")
              : t("alertDialog.actions.ok"))
        const cancelLabel = payload.cancelLabel || t("alertDialog.actions.cancel")

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
                        <label class="text-sm font-medium text-secondary">
                          {payload.inputLabel || t("alertDialog.prompt.inputLabel")}
                        </label>
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
