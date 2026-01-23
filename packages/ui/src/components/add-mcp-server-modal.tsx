import { Component } from "solid-js"
import { Dialog } from "@kobalte/core"
import { X } from "lucide-solid"

export interface AddMcpServerResult {
  name: string
  command: string
  args?: string[]
  env?: Record<string, string>
}

interface AddMcpServerModalProps {
  open: boolean
  onClose: () => void
  folder?: string
  instanceId?: string
  onApply?: (result: AddMcpServerResult) => void
  onApplyToAll?: (result: AddMcpServerResult) => void
}

const AddMcpServerModal: Component<AddMcpServerModalProps> = (props) => {
  return (
    <Dialog.Root open={props.open} onOpenChange={(open) => !open && props.onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay class="dialog-overlay" />
        <Dialog.Content class="dialog-content dialog-content-md">
          <div class="dialog-header">
            <Dialog.Title class="dialog-title">Add MCP Server</Dialog.Title>
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
              Cancel
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

export default AddMcpServerModal
