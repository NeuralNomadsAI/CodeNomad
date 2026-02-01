import { Dialog } from "@kobalte/core/dialog"
import { Component, Show, createEffect } from "solid-js"
import { alertDialogState, dismissAlertDialog } from "../stores/alerts"
import type { AlertVariant, AlertDialogState } from "../stores/alerts"

const variantAccent: Record<AlertVariant, { badgeBg: string; badgeBorder: string; badgeText: string; symbol: string; fallbackTitle: string }> = {
  info: {
    badgeBg: "hsl(var(--muted))",
    badgeBorder: "hsl(var(--border))",
    badgeText: "hsl(var(--primary))",
    symbol: "i",
    fallbackTitle: "Heads up",
  },
  warning: {
    badgeBg: "rgba(255, 152, 0, 0.14)",
    badgeBorder: "hsl(var(--warning))",
    badgeText: "hsl(var(--warning))",
    symbol: "!",
    fallbackTitle: "Please review",
  },
  error: {
    badgeBg: "hsl(var(--destructive) / 0.1)",
    badgeBorder: "hsl(var(--destructive))",
    badgeText: "hsl(var(--destructive))",
    symbol: "!",
    fallbackTitle: "Something went wrong",
  },
}

function dismiss(confirmed: boolean, payload?: AlertDialogState | null) {
  const current = payload ?? alertDialogState()
  if (current?.type === "confirm") {
    if (confirmed) {
      current.onConfirm?.()
    } else {
      current.onCancel?.()
    }
    current.resolve?.(confirmed)
  } else if (confirmed) {
    current?.onConfirm?.()
  }
  dismissAlertDialog()
}

const AlertDialog: Component = () => {
  let primaryButtonRef: HTMLButtonElement | undefined

  createEffect(() => {
    if (alertDialogState()) {
      queueMicrotask(() => {
        primaryButtonRef?.focus()
      })
    }
  })

  return (
    <Show when={alertDialogState()} keyed>
      {(payload) => {
        const variant = payload.variant ?? "info"
        const accent = variantAccent[variant]
        const title = payload.title || accent.fallbackTitle
        const isConfirm = payload.type === "confirm"
        const confirmLabel = payload.confirmLabel || (isConfirm ? "Confirm" : "OK")
        const cancelLabel = payload.cancelLabel || "Cancel"

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
              <Dialog.Overlay class="fixed inset-0 z-50 bg-black/50" />
              <div class="fixed inset-0 z-50 flex items-center justify-center p-4">
                <Dialog.Content class="rounded-lg shadow-2xl flex flex-col bg-background text-foreground w-full max-w-sm p-6 border border-border" tabIndex={-1}>
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
                      <Dialog.Description class="text-sm text-muted-foreground mt-1 whitespace-pre-line break-words">
                        {payload.message}
                        {payload.detail && <p class="mt-2 text-muted-foreground">{payload.detail}</p>}
                      </Dialog.Description>
                    </div>
                  </div>

                  <div class="mt-6 flex justify-end gap-3">
                    {isConfirm && (
                      <button
                        type="button"
                        class="inline-flex items-center justify-center gap-2 font-medium px-4 py-2 rounded-md transition-colors border border-border bg-background text-foreground hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed"
                        onClick={() => dismiss(false, payload)}
                      >
                        {cancelLabel}
                      </button>
                    )}
                    <button
                      type="button"
                      class="inline-flex items-center justify-center gap-2 font-medium px-4 py-2 rounded-md transition-colors bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
                      ref={(el) => {
                        primaryButtonRef = el
                      }}
                      onClick={() => dismiss(true, payload)}
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
