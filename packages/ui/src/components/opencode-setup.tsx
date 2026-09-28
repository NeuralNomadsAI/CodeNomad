import { createEffect, onCleanup, onMount, Show, untrack } from "solid-js"
import { Dialog } from "@kobalte/core/dialog"
import { Portal } from "solid-js/web"
import { useI18n } from "../lib/i18n"
import { useConfig } from "../stores/preferences"
import { sseManager } from "../lib/sse-manager"
import { OpenCodeSetupPanel } from "./settings/opencode-setup-panel"
import { OpenCodeExecutableCard } from "./settings/opencode-executable-card"
import { invalidateOpenCodeSetup, needsOpenCodeSetup, openCodeSetupOpen, openCodeSetupStatus,
  openOpenCodeSetup, refreshOpenCodeSetup, setOpenCodeSetupOpen } from "../stores/opencode-setup"

export default function OpenCodeSetup(props: { automatic?: boolean } = {}) {
  const { t } = useI18n()
  const { serverSettings } = useConfig()
  createEffect(() => { serverSettings().opencodeBinary; untrack(invalidateOpenCodeSetup) })
  createEffect(() => {
    sseManager.getStatuses()
    untrack(() => { if (!document.hidden) void refreshOpenCodeSetup() })
  })
  let announced = ""
  createEffect(() => {
    if (props.automatic === false) return
    const status = openCodeSetupStatus()
    if (!status || !needsOpenCodeSetup(status)) { announced = ""; return }
    const key = `${status.binaryPath}:${status.state}:${status.daemonVersion ?? ""}`
    if (announced === key) return
    announced = key
    setOpenCodeSetupOpen(true)
  })
  onMount(() => {
    const refresh = () => { if (!document.hidden) void refreshOpenCodeSetup() }
    window.addEventListener("focus", refresh)
    document.addEventListener("visibilitychange", refresh)
    onCleanup(() => {
      window.removeEventListener("focus", refresh)
      document.removeEventListener("visibilitychange", refresh)
    })
  })
  return <>
    <Show when={props.automatic !== false && needsOpenCodeSetup() && !openCodeSetupOpen()}>
      <Portal><div class="fixed bottom-4 right-4 z-50 border border-base bg-surface-secondary p-3" role="status">
        <button class="selector-button" onClick={() => openOpenCodeSetup()}>{t("settings.opencode.setup.required")}</button>
      </div></Portal>
    </Show>
    <Dialog open={openCodeSetupOpen()} onOpenChange={setOpenCodeSetupOpen}>
      <Dialog.Portal><Dialog.Overlay class="modal-overlay" />
        <div class="fixed inset-0 z-50 flex items-center justify-center p-4">
          <Dialog.Content class="modal-surface w-full max-w-2xl max-h-[85vh] overflow-auto">
            <header class="window-header"><Dialog.Title class="window-title">{t("settings.opencode.setup.required")}</Dialog.Title>
              <Dialog.CloseButton class="window-action" aria-label={t("app.launchError.close")}>{t("app.launchError.close")}</Dialog.CloseButton></header>
            <div class="window-body"><OpenCodeSetupPanel><OpenCodeExecutableCard /></OpenCodeSetupPanel></div>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog>
  </>
}
