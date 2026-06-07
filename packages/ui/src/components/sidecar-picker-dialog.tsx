import { Dialog } from "@kobalte/core/dialog"
import { For, Show, createEffect, createMemo, type Component } from "solid-js"
import { Globe, Square } from "lucide-solid"
import { useI18n } from "../lib/i18n"
import { ensureSidecarsLoaded, sidecars, sidecarsLoading } from "../stores/sidecars"

interface SideCarPickerDialogProps {
  open: boolean
  onClose: () => void
  onOpenSidecar: (sidecarId: string) => void | Promise<void>
}

export const SideCarPickerDialog: Component<SideCarPickerDialogProps> = (props) => {
  const { t } = useI18n()
  const orderedSidecars = createMemo(() => Array.from(sidecars().values()).sort((a, b) => a.name.localeCompare(b.name)))

  createEffect(() => {
    if (props.open) {
      void ensureSidecarsLoaded()
    }
  })

  return (
    <Dialog open={props.open} onOpenChange={(open) => !open && props.onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay class="modal-overlay" />
        <div class="fixed inset-0 z-50 flex items-center justify-center p-4">
          <Dialog.Content class="modal-surface w-full max-w-2xl p-6 flex flex-col gap-4 max-h-[80vh] overflow-hidden">
            <div>
              <Dialog.Title class="text-xl font-semibold text-primary">{t("sidecars.picker.title")}</Dialog.Title>
              <Dialog.Description class="text-sm text-secondary mt-2">
                {t("sidecars.picker.subtitle")}
              </Dialog.Description>
            </div>

            <div class="flex-1 overflow-auto flex flex-col gap-3">
              <Show when={!sidecarsLoading()} fallback={<div class="panel panel-empty-state">{t("sidecars.picker.loading")}</div>}>
                <Show when={orderedSidecars().length > 0} fallback={<div class="panel panel-empty-state">{t("sidecars.picker.empty")}</div>}>
                  <For each={orderedSidecars()}>
                    {(sidecar) => (
                      <button
                        type="button"
                        class="panel-list-item panel-list-item-content text-left disabled:cursor-not-allowed disabled:opacity-60"
                        disabled={sidecar.status !== "running"}
                        onClick={() => void props.onOpenSidecar(sidecar.id)}
                      >
                        <div class="flex items-center justify-between gap-4 w-full">
                          <div class="flex items-center gap-3 min-w-0">
                            <span class="panel-empty-state-icon !w-10 !h-10">
                              <Globe class="w-5 h-5" />
                            </span>
                            <div class="min-w-0">
                              <div class="text-sm font-medium text-primary truncate">{sidecar.name}</div>
                              <div class="text-xs text-muted">
                                {t("sidecars.kind.port")} - {sidecar.insecure ? "http" : "https"}://127.0.0.1:{sidecar.port}
                              </div>
                              <div class="text-xs text-muted mt-1">{t("sidecars.basePath")}: <code>/sidecars/{sidecar.id}</code></div>
                            </div>
                          </div>
                          <div class="text-xs text-secondary flex items-center gap-2">
                            <Square class="w-4 h-4" />
                            <span>{t(`sidecars.status.${sidecar.status}`)}</span>
                          </div>
                        </div>
                      </button>
                    )}
                  </For>
                </Show>
              </Show>
            </div>

            <div class="flex justify-end">
              <button type="button" class="selector-button selector-button-secondary" onClick={props.onClose}>
                {t("sidecars.picker.close")}
              </button>
            </div>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog>
  )
}
