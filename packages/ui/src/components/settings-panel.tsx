import { Component, Show, createSignal } from "solid-js"
import { Dialog } from "@kobalte/core/dialog"
import { X, Server, ChevronDown, ChevronRight, Settings, Plug, Info, Zap, MessageSquare } from "lucide-solid"
import type { Instance } from "../types/instance"
import { preferences, toggleDefaultToolCallsCollapsed, toggleShowVerboseOutput } from "../stores/preferences"

interface SettingsPanelProps {
  open: boolean
  onClose: () => void
  instance: Instance | null
  serverStatus: "healthy" | "warning" | "error"
  onOpenMcpSettings?: () => void
  onOpenAdvancedSettings?: () => void
  onOpenCommandsSettings?: () => void
}

const SettingsPanel: Component<SettingsPanelProps> = (props) => {
  const [showInstanceDetails, setShowInstanceDetails] = createSignal(false)

  const statusLabel = () => {
    switch (props.serverStatus) {
      case "healthy": return "Server Running"
      case "warning": return "Server Warning"
      case "error": return "Server Error"
    }
  }

  const statusColor = () => {
    switch (props.serverStatus) {
      case "healthy": return "bg-green-500"
      case "warning": return "bg-yellow-500"
      case "error": return "bg-red-500"
    }
  }

  const statusTextColor = () => {
    switch (props.serverStatus) {
      case "healthy": return "text-green-500"
      case "warning": return "text-yellow-500"
      case "error": return "text-red-500"
    }
  }

  return (
    <Dialog open={props.open} onOpenChange={(open) => !open && props.onClose()} modal>
      <Dialog.Portal>
        <Dialog.Overlay class="settings-panel-overlay" />
        <div class="fixed inset-y-0 right-0 z-50 flex">
          <Dialog.Content class="settings-panel">
            <div class="settings-panel-header">
              <Dialog.Title class="settings-panel-title">Settings</Dialog.Title>
              <Dialog.CloseButton class="settings-panel-close">
                <X class="w-4 h-4" />
              </Dialog.CloseButton>
            </div>

            <div class="settings-panel-content">
              {/* Server Status */}
              <div class="settings-section">
                <div class="settings-status">
                  <div class={`settings-status-dot ${statusColor()}`} />
                  <span class={`settings-status-label ${statusTextColor()}`}>
                    {statusLabel()}
                  </span>
                </div>
              </div>

              {/* Quick Actions */}
              <div class="settings-section">
                <h3 class="settings-section-title">Configuration</h3>
                <div class="settings-actions">
                  <button
                    class="settings-action-button"
                    onClick={() => props.onOpenCommandsSettings?.()}
                  >
                    <Zap class="w-4 h-4" />
                    <span>Slash Commands</span>
                  </button>
                  <button
                    class="settings-action-button"
                    onClick={() => props.onOpenMcpSettings?.()}
                  >
                    <Plug class="w-4 h-4" />
                    <span>MCP Servers</span>
                  </button>
                  <button
                    class="settings-action-button"
                    onClick={() => props.onOpenAdvancedSettings?.()}
                  >
                    <Settings class="w-4 h-4" />
                    <span>Advanced Settings</span>
                  </button>
                </div>
              </div>

              {/* Chat Window Settings */}
              <div class="settings-section">
                <h3 class="settings-section-title">
                  <MessageSquare class="w-4 h-4" />
                  <span>Chat Window</span>
                </h3>
                <div class="settings-toggles">
                  <label class="settings-toggle-row">
                    <span class="settings-toggle-label">
                      <span class="settings-toggle-title">Collapse tool calls by default</span>
                      <span class="settings-toggle-description">Tool call sections start collapsed in messages</span>
                    </span>
                    <button
                      type="button"
                      class={`settings-toggle-switch ${preferences().defaultToolCallsCollapsed ? "active" : ""}`}
                      onClick={toggleDefaultToolCallsCollapsed}
                      role="switch"
                      aria-checked={preferences().defaultToolCallsCollapsed}
                    >
                      <span class="settings-toggle-switch-handle" />
                    </button>
                  </label>
                  <label class="settings-toggle-row">
                    <span class="settings-toggle-label">
                      <span class="settings-toggle-title">Show verbose output</span>
                      <span class="settings-toggle-description">Display real-time streaming text while generating</span>
                    </span>
                    <button
                      type="button"
                      class={`settings-toggle-switch ${preferences().showVerboseOutput ? "active" : ""}`}
                      onClick={toggleShowVerboseOutput}
                      role="switch"
                      aria-checked={preferences().showVerboseOutput}
                    >
                      <span class="settings-toggle-switch-handle" />
                    </button>
                  </label>
                </div>
              </div>

              {/* Instance Details (Collapsible) */}
              <Show when={props.instance}>
                <div class="settings-section">
                  <button
                    class="settings-section-toggle"
                    onClick={() => setShowInstanceDetails(!showInstanceDetails())}
                  >
                    {showInstanceDetails() ? (
                      <ChevronDown class="w-4 h-4" />
                    ) : (
                      <ChevronRight class="w-4 h-4" />
                    )}
                    <Info class="w-4 h-4" />
                    <span>Instance Details</span>
                  </button>

                  <Show when={showInstanceDetails()}>
                    <div class="settings-details">
                      <div class="settings-detail-row">
                        <span class="settings-detail-label">Instance ID</span>
                        <span class="settings-detail-value font-mono">
                          {props.instance?.id.slice(0, 8)}...
                        </span>
                      </div>
                      <div class="settings-detail-row">
                        <span class="settings-detail-label">Folder</span>
                        <span class="settings-detail-value font-mono truncate">
                          {props.instance?.folder}
                        </span>
                      </div>
                      <div class="settings-detail-row">
                        <span class="settings-detail-label">Port</span>
                        <span class="settings-detail-value font-mono">
                          {props.instance?.port}
                        </span>
                      </div>
                      <div class="settings-detail-row">
                        <span class="settings-detail-label">Status</span>
                        <span class="settings-detail-value">
                          {props.instance?.status}
                        </span>
                      </div>
                    </div>
                  </Show>
                </div>
              </Show>
            </div>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog>
  )
}

export default SettingsPanel
