import { Component } from "solid-js"
import { Dialog } from "@kobalte/core/dialog"
import { Terminal, Settings2, Plug, Variable, Settings, ExternalLink } from "lucide-solid"
import { Button } from "./ui"
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
  onOpenFullSettings?: () => void
}

const AdvancedSettingsModal: Component<AdvancedSettingsModalProps> = (props) => {
  return (
    <Dialog open={props.open} onOpenChange={(open) => !open && props.onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay class="fixed inset-0 z-50 bg-black/50" />
        <div class="fixed inset-0 z-50 flex items-center justify-center p-4">
          <Dialog.Content class="rounded-lg shadow-2xl flex flex-col bg-background text-foreground w-full max-w-4xl max-h-[90vh] overflow-hidden">
            <header class="px-6 py-4 border-b border-border">
              <Dialog.Title class="text-xl font-semibold text-foreground">Advanced Settings</Dialog.Title>
              <p class="text-sm text-muted-foreground mt-1">Configure OpenCode instances, providers, and environment</p>
            </header>

            <div class="flex-1 overflow-y-auto p-6 space-y-6">
              {/* Session Configuration Group */}
              <div class="space-y-4">
                <div class="flex items-center gap-2 text-sm font-semibold text-foreground">
                  <Terminal class="w-4 h-4" />
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
              <div class="space-y-4">
                <div class="flex items-center gap-2 text-sm font-semibold text-foreground">
                  <Plug class="w-4 h-4" />
                  <span>Connections</span>
                </div>
                <ProviderSettingsPanel />
                <McpSettingsPanel />
              </div>

              {/* Environment Group */}
              <div class="space-y-4">
                <div class="flex items-center gap-2 text-sm font-semibold text-foreground">
                  <Variable class="w-4 h-4" />
                  <span>Environment</span>
                </div>
                <EnvironmentVariablesEditor disabled={Boolean(props.isLoading)} />
              </div>
            </div>

            <div class="flex items-center justify-between px-6 py-4 border-t border-border">
              <Button
                variant="outline"
                type="button"
                onClick={() => {
                  props.onClose()
                  props.onOpenFullSettings?.()
                }}
              >
                <Settings class="w-4 h-4" />
                All Settings
              </Button>
              <Button
                variant="ghost"
                type="button"
                onClick={props.onClose}
              >
                Close
              </Button>
            </div>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog>
  )
}

export default AdvancedSettingsModal
