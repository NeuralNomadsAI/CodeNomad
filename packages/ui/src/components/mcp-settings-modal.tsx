import { Component } from "solid-js"
import { Dialog } from "@kobalte/core"
import { X } from "lucide-solid"

interface McpSettingsModalProps {
  open: boolean
  onClose: () => void
  folder?: string
  instanceId?: string
  onAddServer?: () => void
}

const McpSettingsModal: Component<McpSettingsModalProps> = (props) => {
  return (
    <Dialog.Root open={props.open} onOpenChange={(open) => !open && props.onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay class="dialog-overlay" />
        <Dialog.Content class="dialog-content dialog-content-md">
          <div class="dialog-header">
            <Dialog.Title class="dialog-title">MCP Settings</Dialog.Title>
            <Dialog.CloseButton class="dialog-close-button">
              <X size={16} />
            </Dialog.CloseButton>
          </div>
          <div class="dialog-body">
            <div class="text-muted text-sm">
              MCP server configuration coming soon.
            </div>
          </div>
          <div class="dialog-footer">
            <button
              type="button"
              class="btn btn-secondary btn-sm"
              onClick={props.onClose}
            >
              Close
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

export default McpSettingsModal
