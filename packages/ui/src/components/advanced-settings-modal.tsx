import { Component } from "solid-js"
import { Dialog } from "@kobalte/core/dialog"
import OpenCodeBinarySelector from "./opencode-binary-selector"
import EnvironmentVariablesEditor from "./environment-variables-editor"
import { useI18n } from "../lib/i18n"

interface AdvancedSettingsModalProps {
  open: boolean
  onClose: () => void
  selectedBinary: string
  onBinaryChange: (binary: string) => void
  isLoading?: boolean
}

const AdvancedSettingsModal: Component<AdvancedSettingsModalProps> = (props) => {
  const { t } = useI18n()

  return (
    <Dialog open={props.open} onOpenChange={(open) => !open && props.onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay class="modal-overlay" />
        <div class="fixed inset-0 z-50 flex items-center justify-center p-4">
          <Dialog.Content class="modal-surface w-full max-w-5xl max-h-[90vh] flex flex-col overflow-hidden">
            <header class="px-6 py-4 border-b" style={{ "border-color": "var(--border-base)" }}>
              <Dialog.Title class="text-xl font-semibold text-primary">{t("advancedSettings.title")}</Dialog.Title>
            </header>

            <div class="flex-1 overflow-y-auto p-6 space-y-6">
              <OpenCodeBinarySelector
                selectedBinary={props.selectedBinary}
                onBinaryChange={props.onBinaryChange}
                disabled={Boolean(props.isLoading)}
                isVisible={props.open}
              />

              <div class="panel">
                <div class="panel-header">
                  <h3 class="panel-title">{t("advancedSettings.environmentVariables.title")}</h3>
                  <p class="panel-subtitle">{t("advancedSettings.environmentVariables.subtitle")}</p>
                </div>
                <div class="panel-body">
                  <EnvironmentVariablesEditor disabled={Boolean(props.isLoading)} />
                </div>
              </div>
            </div>

            <div class="px-6 py-4 border-t flex justify-end" style={{ "border-color": "var(--border-base)" }}>
              <button
                type="button"
                class="selector-button selector-button-secondary"
                onClick={props.onClose}
              >
                {t("advancedSettings.actions.close")}
              </button>
            </div>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog>
  )
}

export default AdvancedSettingsModal
