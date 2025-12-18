import { Component } from "solid-js"
import { Dialog } from "@kobalte/core/dialog"
import { Terminal, Settings2, Plug, Variable } from "lucide-solid"
import OpenCodeBinarySelector from "./opencode-binary-selector"
import EnvironmentVariablesEditor from "./environment-variables-editor"
import ModelDefaultsPanel from "./model-defaults-panel"
import ProviderSettingsPanel from "./provider-settings-panel"
import McpSettingsPanel from "./mcp-settings-panel"

interface AdvancedSettingsModalProps {
  open: boolean
  onClose: () => void
  selectedBinary: string
  onBinaryChange: (binary: string) => void
  isLoading?: boolean
}

const AdvancedSettingsModal: Component<AdvancedSettingsModalProps> = (props) => {
  return (
    <Dialog open={props.open} onOpenChange={(open) => !open && props.onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay class="modal-overlay" />
        <div class="fixed inset-0 z-50 flex items-center justify-center p-4">
          <Dialog.Content class="modal-surface w-full max-w-4xl max-h-[90vh] flex flex-col overflow-hidden">
            <header class="modal-header">
              <Dialog.Title class="text-xl font-semibold text-primary">Advanced Settings</Dialog.Title>
              <p class="text-sm text-secondary mt-1">Configure OpenCode instances, providers, and environment</p>
            </header>

            <div class="modal-body">
              {/* Session Configuration Group */}
              <div class="modal-section">
                <div class="modal-section-header">
                  <Terminal />
                  <span>Session Configuration</span>
                </div>
                <OpenCodeBinarySelector
                  selectedBinary={props.selectedBinary}
                  onBinaryChange={props.onBinaryChange}
                  disabled={Boolean(props.isLoading)}
                  isVisible={props.open}
                />
                <ModelDefaultsPanel />
              </div>

              {/* Connections Group */}
              <div class="modal-section">
                <div class="modal-section-header">
                  <Plug />
                  <span>Connections</span>
                </div>
                <ProviderSettingsPanel />
                <McpSettingsPanel />
              </div>

              {/* Environment Group */}
              <div class="modal-section">
                <div class="modal-section-header">
                  <Variable />
                  <span>Environment</span>
                </div>
                <EnvironmentVariablesEditor disabled={Boolean(props.isLoading)} />
              </div>
            </div>

            <div class="modal-footer">
              <button
                type="button"
                class="modal-button modal-button--ghost"
                onClick={props.onClose}
              >
                Close
              </button>
            </div>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog>
  )
}

export default AdvancedSettingsModal
